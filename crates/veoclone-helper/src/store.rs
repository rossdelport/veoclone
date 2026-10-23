//! Projects on disk: `ProjectMeta` (the JSON shape the editor reads) and the
//! in-memory store that keeps every `project.json` up to date.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Message shown for jobs that were running when VeoClone was closed.
pub const INTERRUPTED: &str =
    "VeoClone was closed, or the PC restarted, while this was running. Press Try again.";

/// Shown instead of [`INTERRUPTED`] once a match's work has been cut short
/// twice in a row: the next run uses the slower safe mode (see
/// [`ProjectMeta::safe_mode`]).
pub const STOPPED_TWICE: &str = "VeoClone stopped while working on this match more than once. \
                                 Press Try again to use a slower but safer way.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Style {
    Broadcast,
    Action,
    FrameAll,
    /// "Follow the ball": Reco's ball tracking mode (no player cluster).
    Ball,
}

impl Style {
    /// Reco FieldPanner preset name. Ball mode starts from the broadcast
    /// preset like reco-gui does; Reco then forces `ball_weight` to 1.0.
    pub fn preset(self) -> &'static str {
        match self {
            Style::Broadcast | Style::Ball => "broadcast",
            Style::Action => "action",
            Style::FrameAll => "frame_all",
        }
    }

    /// Reco's tracking mode: the ball alone, or the players and the ball.
    pub fn tracking_mode(self) -> reco_autocam::TrackingMode {
        match self {
            Style::Ball => reco_autocam::TrackingMode::Ball,
            _ => reco_autocam::TrackingMode::Field,
        }
    }
}

/// "AI accuracy": how often the AI looks at the picture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiAccuracy {
    /// Every frame (Reco's detection interval 1).
    #[default]
    Best,
    /// Every 3rd frame (reco-gui's default), about 3 times less AI work.
    Faster,
}

impl AiAccuracy {
    /// Reco's detection interval: run the AI on every Nth frame.
    pub fn interval(self) -> u64 {
        match self {
            AiAccuracy::Best => 1,
            AiAccuracy::Faster => 3,
        }
    }
}

/// "Mark the pitch": the outline the user clicked in the editor and, per
/// camera, the image polygon Reco's field ROI filter uses (match.json
/// `field_roi`, normalised `[x, y]` with y = 0 at the top).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PitchOutline {
    /// Changes with every save, so the editor can tell whether the AI
    /// path was made with this outline.
    pub id: String,
    /// The outline as clicked: `[yaw, pitch]` radians of each corner.
    pub points: Vec<[f64; 2]>,
    /// The left camera's polygon; empty when it sees none of the pitch.
    pub left: Vec<[f64; 2]>,
    /// The right camera's polygon; empty when it sees none of the pitch.
    pub right: Vec<[f64; 2]>,
}

impl PitchOutline {
    /// Reco's field ROI. Reco ignores a camera whose polygon has fewer
    /// than 3 corners (it keeps everything that camera sees), so a camera
    /// that sees none of the pitch gets a polygon outside its picture:
    /// everything it sees is off the pitch.
    pub fn field_roi(&self) -> reco_core::calibration::FieldRoi {
        const NOWHERE: [[f64; 2]; 3] = [[-2.0, -2.0], [-1.0, -2.0], [-2.0, -1.0]];
        let side = |p: &Vec<[f64; 2]>| {
            if p.len() >= 3 {
                p.clone()
            } else {
                NOWHERE.to_vec()
            }
        };
        reco_core::calibration::FieldRoi {
            left: side(&self.left),
            right: side(&self.right),
        }
    }
}

/// The settings the current AI camera path was made with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRun {
    pub style: Style,
    pub ai_accuracy: AiAccuracy,
    /// `PitchOutline::id` of the outline used, if any.
    pub pitch_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    New,
    Uploaded,
    Queued,
    Processing,
    Ready,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fps {
    pub num: u32,
    pub den: u32,
}

impl Fps {
    pub fn as_f64(self) -> f64 {
        self.num as f64 / self.den.max(1) as f64
    }

    /// Seconds from the start of the synced timeline to frame `f`.
    pub fn frame_to_secs(self, f: u64) -> f64 {
        f as f64 * self.den as f64 / self.num.max(1) as f64
    }

    /// Frame `f` as a clock time for people: "41:20" or "1:02:05".
    pub fn clock(self, f: u64) -> String {
        let s = self.frame_to_secs(f) as u64;
        let (h, m, s) = (s / 3600, s / 60 % 60, s % 60);
        if h > 0 {
            format!("{h}:{m:02}:{s:02}")
        } else {
            format!("{m}:{s:02}")
        }
    }
}

/// What ffprobe told us about one uploaded file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInfo {
    pub width: u32,
    pub height: u32,
    pub fps: Fps,
    pub frame_count: u64,
    pub duration: f64,
    pub codec: String,
    pub pixel_format: String,
    pub color_transfer: Option<String>,
    pub rotation: i32,
    pub has_audio: bool,
}

/// One camera's video: one file, or a recording the camera split into
/// several files (a GoPro saves a new "chapter" every 4 GB).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    /// The file's name; for a recording in parts, the first part's.
    pub name: String,
    /// All parts together.
    pub size_bytes: u64,
    /// The whole recording (all parts as one video).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe: Option<ProbeInfo>,
    /// The parts in order; `None` for a part not sent yet. Empty for one
    /// file.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<Option<PartInfo>>,
}

/// One file of a recording in parts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartInfo {
    pub name: String,
    pub size_bytes: u64,
}

impl FileInfo {
    /// One uploaded file.
    pub fn single(name: String, size_bytes: u64) -> FileInfo {
        FileInfo {
            name,
            size_bytes,
            probe: None,
            parts: Vec::new(),
        }
    }

    /// A recording in parts (some may still be missing).
    pub fn from_parts(parts: Vec<Option<PartInfo>>) -> FileInfo {
        let name = parts
            .iter()
            .flatten()
            .next()
            .map(|p| p.name.clone())
            .unwrap_or_default();
        FileInfo {
            name,
            size_bytes: parts.iter().flatten().map(|p| p.size_bytes).sum(),
            probe: None,
            parts,
        }
    }

    /// Every part has been sent.
    pub fn complete(&self) -> bool {
        self.parts.iter().all(Option::is_some)
    }

    /// How many files the video is made of.
    pub fn file_count(&self) -> usize {
        self.parts.len().max(1)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Files {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<FileInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<FileInfo>,
}

impl Files {
    pub fn side(&self, side: &str) -> Option<&FileInfo> {
        if side == "left" {
            self.left.as_ref()
        } else {
            self.right.as_ref()
        }
    }

    pub fn side_mut(&mut self, side: &str) -> &mut Option<FileInfo> {
        if side == "left" {
            &mut self.left
        } else {
            &mut self.right
        }
    }

    /// Both videos are here, with all their parts.
    pub fn both(&self) -> bool {
        [&self.left, &self.right]
            .iter()
            .all(|f| f.as_ref().is_some_and(FileInfo::complete))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    Process,
    Export,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Step {
    Probe,
    Calibrate,
    Proxy,
    Track,
    Export,
    Finalize,
    /// Burning the editor's text boxes into the finished video.
    Overlay,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobInfo {
    pub kind: JobKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export_id: Option<String>,
    pub step: Step,
    pub step_index: u32,
    pub step_count: u32,
    pub progress: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frames_done: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frames_total: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eta_seconds: Option<f64>,
    pub message: String,
    pub started_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorInfo {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibSummary {
    pub confidence: f64,
    pub sync_offset_frames: i64,
    pub sync_offset_seconds: f64,
    pub lens: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportStatus {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    Fast,
    Balanced,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportMeta {
    pub id: String,
    pub status: ExportStatus,
    pub progress: f64,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    pub width: u32,
    pub height: u32,
    pub quality: Quality,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    /// The left phone's lens (and the right one's, unless `right_lens_id`).
    pub lens_id: Option<String>,
    /// The right phone's lens when the two phones are different models;
    /// `None`: the same as the left phone.
    #[serde(default)]
    pub right_lens_id: Option<String>,
    pub style: Style,
    /// How often the AI looks at the picture (missing in older matches:
    /// every frame).
    #[serde(default)]
    pub ai_accuracy: AiAccuracy,
    /// "Mark the pitch" (none: the AI looks everywhere).
    #[serde(default)]
    pub pitch: Option<PitchOutline>,
    /// What the current AI camera path was made with (none: not known,
    /// e.g. a match from an older VeoClone).
    #[serde(default)]
    pub ai_run: Option<AiRun>,
    /// What the AI saw last time is kept, so a new style, AI accuracy or
    /// pitch outline runs again in seconds (filled in when read).
    #[serde(default)]
    pub ai_seen: Option<crate::seen::SeenSummary>,
    pub status: Status,
    pub files: Files,
    pub job: Option<JobInfo>,
    pub error: Option<ErrorInfo>,
    pub warnings: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calibration: Option<CalibSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fps: Option<Fps>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_count: Option<u64>,
    #[serde(default)]
    pub disk_bytes: u64,
    #[serde(default)]
    pub exports: Vec<ExportMeta>,
    /// How many times in a row VeoClone stopped (closed or crashed) while
    /// processing this match.
    #[serde(default)]
    pub interrupted_runs: u32,
}

impl ProjectMeta {
    /// After two interrupted runs, avoid the fast graphics-card video
    /// decoding (a crash in a driver would close VeoClone every time).
    pub fn safe_mode(&self) -> bool {
        self.interrupted_runs >= 2
    }
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Short random id used for projects and exports (also a folder name).
pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

/// Ids come from URLs, so only accept what `new_id` makes.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Write a file via a temporary file and a rename, so a crash (or a power
/// cut) never leaves half a file behind.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let tmp = path.with_file_name(format!("{name}.{}.tmp", new_id()));
    let written = std::fs::File::create(&tmp).and_then(|mut f| {
        f.write_all(bytes)?;
        // On disk before the rename, so the rename never points at nothing.
        f.sync_all()
    });
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    let result = std::fs::rename(&tmp, path).or_else(|_| {
        // Windows can refuse briefly while another program (antivirus,
        // a browser download) has the target open.
        std::thread::sleep(Duration::from_millis(100));
        std::fs::rename(&tmp, path)
    });
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Total size of every file in a folder (recursively).
pub fn dir_size(path: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(path) else {
        return 0;
    };
    rd.flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => dir_size(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

/// Files the processing pipeline makes from the uploads. Removed whenever an
/// upload changes so stale results are never served.
pub const DERIVED_FILES: [&str; 4] = ["match.json", "calib.json", "proxy.mp4", "ai_path.bin"];

/// All projects, kept in memory and mirrored to `<data>/projects/<id>/project.json`.
pub struct Store {
    root: PathBuf,
    inner: Mutex<HashMap<String, Entry>>,
}

struct Entry {
    meta: ProjectMeta,
    last_saved: Instant,
}

impl Store {
    /// Load every project under `<data>/projects`. Jobs that were running
    /// when VeoClone stopped are marked failed (the work is lost). Only call
    /// this while holding the data folder lock (main.rs): it removes the
    /// leftovers of unfinished work.
    pub fn open(data_dir: &Path) -> std::io::Result<Store> {
        let root = data_dir.join("projects");
        std::fs::create_dir_all(&root)?;
        let mut map = HashMap::new();
        for entry in std::fs::read_dir(&root)?.flatten() {
            let dir = entry.path();
            let folder = entry.file_name().to_string_lossy().into_owned();
            if folder.ends_with(DELETING) {
                // A delete that was cut short.
                let _ = std::fs::remove_dir_all(&dir);
                continue;
            }
            if !valid_id(&folder) || !dir.is_dir() {
                continue;
            }
            // First, so a full disk gets VeoClone's own leftovers back.
            remove_part_files(&dir);
            let Ok(bytes) = std::fs::read(dir.join("project.json")) else {
                continue;
            };
            let (mut meta, damaged) = match serde_json::from_slice::<ProjectMeta>(&bytes) {
                Ok(m) if m.id == folder => (m, false),
                Ok(_) => continue,
                Err(e) => {
                    log::warn!("Damaged match settings in {}: {e}", dir.display());
                    (recovered_meta(&folder, &dir), true)
                }
            };
            if (recover_interrupted(&mut meta, &dir) || damaged)
                && let Err(e) = write_atomic(&dir.join("project.json"), &to_json(&meta))
            {
                // Kept in memory; saved with the next change.
                log::warn!("Could not save {}: {e}", dir.display());
            }
            map.insert(
                meta.id.clone(),
                Entry {
                    meta,
                    last_saved: Instant::now(),
                },
            );
        }
        Ok(Store {
            root,
            inner: Mutex::new(map),
        })
    }

    pub fn project_dir(&self, id: &str) -> PathBuf {
        self.root.join(id)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        // A panic while holding the lock leaves plain data behind; keep going.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// All projects, newest first, with `diskBytes` filled in.
    pub fn list(&self) -> Vec<ProjectMeta> {
        let mut all: Vec<ProjectMeta> = self.lock().values().map(|e| e.meta.clone()).collect();
        all.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
        for m in &mut all {
            let dir = self.project_dir(&m.id);
            m.disk_bytes = dir_size(&dir);
            m.ai_seen = crate::seen::summary(&dir);
        }
        all
    }

    pub fn get(&self, id: &str) -> Option<ProjectMeta> {
        let mut meta = self.lock().get(id)?.meta.clone();
        let dir = self.project_dir(id);
        meta.disk_bytes = dir_size(&dir);
        meta.ai_seen = crate::seen::summary(&dir);
        Some(meta)
    }

    pub fn create(&self, meta: ProjectMeta) -> std::io::Result<ProjectMeta> {
        let dir = self.project_dir(&meta.id);
        std::fs::create_dir_all(&dir)?;
        write_atomic(&dir.join("project.json"), &to_json(&meta))?;
        self.lock().insert(
            meta.id.clone(),
            Entry {
                meta: meta.clone(),
                last_saved: Instant::now(),
            },
        );
        Ok(meta)
    }

    /// Change a project and save it straight away. Returns the new state, or
    /// `None` if the project does not exist (any more).
    pub fn update<R>(
        &self,
        id: &str,
        f: impl FnOnce(&mut ProjectMeta) -> R,
    ) -> Option<(ProjectMeta, R)> {
        self.update_inner(id, true, f)
    }

    /// Like [`update`](Self::update) for frequent progress ticks: the change
    /// is visible at once but only written to disk every few seconds.
    pub fn update_progress(&self, id: &str, f: impl FnOnce(&mut ProjectMeta)) {
        self.update_inner(id, false, f);
    }

    fn update_inner<R>(
        &self,
        id: &str,
        always_save: bool,
        f: impl FnOnce(&mut ProjectMeta) -> R,
    ) -> Option<(ProjectMeta, R)> {
        let mut map = self.lock();
        let entry = map.get_mut(id)?;
        let r = f(&mut entry.meta);
        if always_save {
            entry.meta.updated_at = now_iso();
        }
        if always_save || entry.last_saved.elapsed() > Duration::from_secs(5) {
            let path = self.project_dir(id).join("project.json");
            if let Err(e) = write_atomic(&path, &to_json(&entry.meta)) {
                log::warn!("Could not save {}: {e}", path.display());
            }
            entry.last_saved = Instant::now();
        }
        Some((entry.meta.clone(), r))
    }

    /// Forget a project and delete its folder. All or nothing: the folder
    /// is renamed first, which Windows refuses while another program (a
    /// video player) has one of its files open.
    pub fn delete(&self, id: &str) -> std::io::Result<()> {
        let dir = self.project_dir(id);
        let mut map = self.lock();
        if dir.exists() {
            let trash = self.root.join(format!("{id}{DELETING}"));
            let _ = std::fs::remove_dir_all(&trash);
            std::fs::rename(&dir, &trash)?;
            if let Err(e) = std::fs::remove_dir_all(&trash) {
                // Finished at the next start.
                log::warn!("Could not delete all of {}: {e}", trash.display());
            }
        }
        map.remove(id);
        Ok(())
    }
}

/// Suffix of a project folder that is being deleted.
const DELETING: &str = ".deleting";

/// Settings for a match whose project.json was damaged (for example by a
/// power cut), so it still shows up and can be deleted or fixed.
fn recovered_meta(id: &str, dir: &Path) -> ProjectMeta {
    let file = |side| {
        let parts: Vec<PartInfo> = original_files(dir, side)
            .iter()
            .filter_map(|path| {
                Some(PartInfo {
                    name: path.file_name()?.to_string_lossy().into_owned(),
                    size_bytes: path.metadata().ok()?.len(),
                })
            })
            .collect();
        match parts.len() {
            0 => None,
            1 => Some(FileInfo::single(parts[0].name.clone(), parts[0].size_bytes)),
            _ => Some(FileInfo::from_parts(parts.into_iter().map(Some).collect())),
        }
    };
    let files = Files {
        left: file("left"),
        right: file("right"),
    };
    let now = now_iso();
    ProjectMeta {
        id: id.into(),
        name: "Recovered match".into(),
        created_at: now.clone(),
        updated_at: now,
        lens_id: None,
        right_lens_id: None,
        style: Style::Broadcast,
        ai_accuracy: AiAccuracy::Best,
        pitch: None,
        ai_run: None,
        ai_seen: None,
        status: Status::Failed,
        files,
        job: None,
        error: Some(ErrorInfo {
            message: "This match's settings were damaged. You can delete it, or add the videos \
                      again and press Start."
                .into(),
            detail: None,
        }),
        warnings: Vec::new(),
        calibration: None,
        fps: None,
        frame_count: None,
        disk_bytes: 0,
        exports: Vec::new(),
        interrupted_runs: 0,
    }
}

fn to_json(meta: &ProjectMeta) -> Vec<u8> {
    serde_json::to_vec_pretty(meta).expect("ProjectMeta always serializes")
}

/// Mark jobs that were cut short by a restart as failed. Returns true if
/// anything changed.
pub fn recover_interrupted(meta: &mut ProjectMeta, dir: &Path) -> bool {
    let mut changed = false;
    if meta.status == Status::Processing {
        meta.interrupted_runs += 1;
    }
    if matches!(meta.status, Status::Queued | Status::Processing) {
        let message = if meta.safe_mode() {
            STOPPED_TWICE
        } else {
            INTERRUPTED
        };
        let error = ErrorInfo {
            message: message.into(),
            detail: None,
        };
        end_unfinished_run(meta, dir, Some(error));
        changed = true;
    }
    if meta.job.take().is_some() {
        changed = true;
    }
    for ex in &mut meta.exports {
        if matches!(ex.status, ExportStatus::Queued | ExportStatus::Running) {
            ex.status = ExportStatus::Failed;
            ex.error = Some(INTERRUPTED.into());
            // Half-made parts are useless; free the disk space.
            let _ = std::fs::remove_dir_all(dir.join("exports").join(&ex.id));
            changed = true;
        }
    }
    changed
}

/// A processing run that stopped before the end: cancelled (`problem` is
/// `None`), failed, or cut short by closing VeoClone. If the results of an
/// earlier run are all still there, the match stays ready with them and
/// the problem becomes a warning (DESIGN.md 4.7), so the editor and the
/// finished videos stay reachable.
pub fn end_unfinished_run(meta: &mut ProjectMeta, dir: &Path, problem: Option<ErrorInfo>) {
    meta.job = None;
    let Some(frames) = earlier_results(dir) else {
        meta.status = if problem.is_some() {
            Status::Failed
        } else {
            Status::Cancelled
        };
        meta.error = problem;
        return;
    };
    let warning = match &problem {
        None => "You stopped the new run, so this match keeps its earlier result.".to_string(),
        Some(e) if e.message == INTERRUPTED || e.message == STOPPED_TWICE => {
            "VeoClone was closed, or the PC restarted, before the new run finished, so this \
             match keeps its earlier result."
                .to_string()
        }
        Some(e) => format!(
            "The new run did not finish, so this match keeps its earlier result. {}",
            e.message
        ),
    };
    meta.status = Status::Ready;
    meta.error = None;
    meta.frame_count = Some(frames);
    if !meta.warnings.contains(&warning) {
        meta.warnings.push(warning);
    }
}

/// The frame count of an earlier finished run whose results (calibration,
/// preview, AI path and editor data) are all still on disk. New uploads, a
/// swap and a new calibration delete them, so they always belong together.
fn earlier_results(dir: &Path) -> Option<u64> {
    if !DERIVED_FILES.iter().all(|f| dir.join(f).is_file()) {
        return None;
    }
    let calib: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("calib.json")).ok()?).ok()?;
    calib["frameCount"].as_u64().filter(|n| *n > 0)
}

/// Remove leftovers of uploads and jobs that never finished
/// (`*.part`, `*.tmp`, `proxy.*.tmp.mp4`, `matched-*.tmp.mp4`, `ai_pass.tmp.mkv`).
fn remove_part_files(dir: &Path) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.ends_with(".part") || name.ends_with(".tmp") || name.contains(".tmp.") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

/// Most files one camera's video may be split into.
pub const MAX_PARTS: usize = 99;

/// Every uploaded file of one side, in no particular order: the one file
/// `left.<ext>` (`None`) and the parts of a recording in several files,
/// `left.001.<ext>`, `left.002.<ext>`… (`Some(1)`, `Some(2)`…). Only these
/// exact names count, so the matching copy (`matched-left.mp4`) and
/// unfinished files are never taken for them.
pub fn side_files(dir: &Path, side: &str) -> Vec<(Option<usize>, PathBuf)> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    rd.flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let rest = name.strip_prefix(side)?.strip_prefix('.')?;
            let (number, ext) = match rest.split_once('.') {
                None => (None, rest),
                Some((n, ext)) if n.len() == 3 && n.bytes().all(|b| b.is_ascii_digit()) => {
                    (Some(n.parse::<usize>().ok()?), ext)
                }
                Some(_) => return None,
            };
            let ours = !ext.is_empty()
                && ext.bytes().all(|b| b.is_ascii_alphanumeric())
                && ext != "part"
                && ext != "tmp"
                && number != Some(0);
            (ours && e.path().is_file()).then(|| (number, e.path()))
        })
        .collect()
}

/// The uploaded original of one side in order: `left.<ext>`, or all the
/// parts `left.001.<ext>`, `left.002.<ext>`… Empty when there is none, or
/// when a part in between is missing.
pub fn original_files(dir: &Path, side: &str) -> Vec<PathBuf> {
    let mut files = side_files(dir, side);
    files.sort();
    let parts: Vec<(usize, PathBuf)> = files
        .iter()
        .filter_map(|(n, p)| Some((n.as_ref().copied()?, p.clone())))
        .collect();
    if parts.is_empty() {
        return files.into_iter().map(|(_, p)| p).take(1).collect();
    }
    if parts.iter().enumerate().all(|(i, (n, _))| *n == i + 1) {
        parts.into_iter().map(|(_, p)| p).collect()
    } else {
        Vec::new()
    }
}

/// The uploaded original of one side when it is all there: as many files
/// as `ProjectMeta.files` lists, every part sent.
pub fn uploaded_files(meta: &ProjectMeta, dir: &Path, side: &str) -> Option<Vec<PathBuf>> {
    let info = meta.files.side(side).filter(|f| f.complete())?;
    let files = original_files(dir, side);
    (!files.is_empty() && files.len() == info.file_count()).then_some(files)
}

/// The matching copy of one side's video (DESIGN.md 4.2), made when the
/// two phones filmed in different formats.
pub fn matched_file(dir: &Path, side: &str) -> PathBuf {
    dir.join(format!("matched-{side}.mp4"))
}

/// What the matching copy was made from; it is only used while this holds.
pub fn matched_record(dir: &Path, side: &str) -> PathBuf {
    dir.join(format!("matched-{side}.json"))
}

/// Delete one side's matching copy. Returns true if there was one.
pub fn remove_matched(dir: &Path, side: &str) -> bool {
    let _ = std::fs::remove_file(matched_record(dir, side));
    std::fs::remove_file(matched_file(dir, side)).is_ok()
}

/// The video every processing step and export reads for one side: the
/// matching copy when there is one (one file, also when the upload came in
/// parts), otherwise the uploaded original (all its parts, in order).
/// Empty when there is no upload.
pub fn working_files(dir: &Path, side: &str) -> Vec<PathBuf> {
    let originals = original_files(dir, side);
    let matched = matched_file(dir, side);
    if !originals.is_empty() && matched.is_file() {
        vec![matched]
    } else {
        originals
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn sample(id: &str) -> ProjectMeta {
        ProjectMeta {
            id: id.into(),
            name: "Saturday match".into(),
            created_at: now_iso(),
            updated_at: now_iso(),
            lens_id: None,
            right_lens_id: None,
            style: Style::Broadcast,
            ai_accuracy: AiAccuracy::Best,
            pitch: None,
            ai_run: None,
            ai_seen: None,
            status: Status::New,
            files: Files::default(),
            job: None,
            error: None,
            warnings: vec![],
            calibration: None,
            fps: None,
            frame_count: None,
            disk_bytes: 0,
            exports: vec![],
            interrupted_runs: 0,
        }
    }

    #[test]
    fn json_shape_matches_design() {
        let mut m = sample("abc123");
        m.exports.push(ExportMeta {
            id: "e1".into(),
            status: ExportStatus::Done,
            progress: 1.0,
            created_at: "2026-01-01T00:00:00Z".into(),
            file_name: Some("x.mp4".into()),
            size_bytes: Some(5),
            width: 1920,
            height: 1080,
            quality: Quality::Balanced,
            error: None,
        });
        m.style = Style::FrameAll;
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["lensId"], serde_json::Value::Null);
        assert_eq!(v["rightLensId"], serde_json::Value::Null);
        assert_eq!(v["job"], serde_json::Value::Null);
        assert_eq!(v["error"], serde_json::Value::Null);
        assert_eq!(v["style"], "frame_all");
        assert_eq!(v["aiAccuracy"], "best");
        assert_eq!(v["pitch"], serde_json::Value::Null);
        assert_eq!(v["aiRun"], serde_json::Value::Null);
        assert_eq!(v["status"], "new");
        assert_eq!(v["files"], serde_json::json!({}));
        assert!(v.get("calibration").is_none());
        assert!(v.get("frameCount").is_none());
        assert_eq!(v["diskBytes"], 0);
        assert_eq!(v["exports"][0]["fileName"], "x.mp4");
        assert_eq!(v["exports"][0]["status"], "done");
        assert_eq!(v["exports"][0]["quality"], "balanced");
        assert!(v["createdAt"].as_str().unwrap().ends_with('Z'));
    }

    #[test]
    fn store_roundtrip_and_restart_marks_interrupted() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();
        let mut m = sample(&new_id());
        m.status = Status::Processing;
        m.job = Some(JobInfo {
            kind: JobKind::Process,
            export_id: None,
            step: Step::Proxy,
            step_index: 2,
            step_count: 4,
            progress: 0.5,
            frames_done: Some(10),
            frames_total: Some(20),
            eta_seconds: None,
            message: "x".into(),
            started_at: now_iso(),
        });
        m.exports.push(ExportMeta {
            id: "e1".into(),
            status: ExportStatus::Queued,
            progress: 0.0,
            created_at: now_iso(),
            file_name: None,
            size_bytes: None,
            width: 1920,
            height: 1080,
            quality: Quality::Fast,
            error: None,
        });
        let id = m.id.clone();
        store.create(m).unwrap();
        std::fs::write(store.project_dir(&id).join("left.part"), b"xx").unwrap();
        std::fs::write(store.project_dir(&id).join("proxy.tmp.mp4"), b"xx").unwrap();
        std::fs::write(store.project_dir(&id).join("left.mov"), b"xx").unwrap();
        drop(store);

        let store = Store::open(tmp.path()).unwrap();
        let m = store.get(&id).unwrap();
        assert_eq!(m.status, Status::Failed);
        assert_eq!(m.error.unwrap().message, INTERRUPTED);
        assert!(m.job.is_none());
        assert_eq!(m.exports[0].status, ExportStatus::Failed);
        assert!(!store.project_dir(&id).join("left.part").exists());
        assert!(!store.project_dir(&id).join("proxy.tmp.mp4").exists());
        assert!(store.project_dir(&id).join("left.mov").exists());

        let (m, _) = store.update(&id, |m| m.name = "Renamed".into()).unwrap();
        assert_eq!(m.name, "Renamed");
        drop(store);
        let store = Store::open(tmp.path()).unwrap();
        assert_eq!(store.get(&id).unwrap().name, "Renamed");
        assert_eq!(store.list().len(), 1);
        store.delete(&id).unwrap();
        assert!(store.get(&id).is_none());
        assert!(!store.project_dir(&id).exists());
        assert_eq!(
            std::fs::read_dir(tmp.path().join("projects"))
                .unwrap()
                .count(),
            0
        );
    }

    fn write_results(dir: &Path, frames: u64) {
        for f in DERIVED_FILES {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        let calib = serde_json::json!({ "frameCount": frames });
        std::fs::write(dir.join("calib.json"), calib.to_string()).unwrap();
    }

    /// DESIGN.md 4.7: a re-run that stops keeps the earlier result.
    #[test]
    fn unfinished_rerun_keeps_earlier_result() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let problem = || {
            Some(ErrorInfo {
                message: "It broke.".into(),
                detail: Some("x".into()),
            })
        };
        // First run: nothing to fall back on.
        let mut m = sample("a1");
        m.status = Status::Processing;
        end_unfinished_run(&mut m, dir, None);
        assert_eq!(m.status, Status::Cancelled);
        end_unfinished_run(&mut m, dir, problem());
        assert_eq!(m.status, Status::Failed);
        assert_eq!(m.error.as_ref().unwrap().message, "It broke.");

        // A re-run after a finished one: back to ready, problem as warning.
        write_results(dir, 588);
        let mut m = sample("a1");
        m.status = Status::Processing;
        m.frame_count = Some(600); // the re-run's probe count
        end_unfinished_run(&mut m, dir, problem());
        assert_eq!(m.status, Status::Ready);
        assert!(m.error.is_none());
        assert_eq!(m.frame_count, Some(588));
        assert!(m.warnings[0].contains("earlier result") && m.warnings[0].contains("It broke."));
        end_unfinished_run(&mut m, dir, None);
        end_unfinished_run(&mut m, dir, None);
        assert_eq!(m.warnings.len(), 2, "{:?}", m.warnings);

        // Also when VeoClone was closed during the re-run.
        let mut m = sample("a1");
        m.status = Status::Processing;
        assert!(recover_interrupted(&mut m, dir));
        assert_eq!(m.status, Status::Ready);
        assert!(m.warnings[0].starts_with("VeoClone was closed"));

        // Without all the results there is nothing to keep.
        std::fs::remove_file(dir.join("proxy.mp4")).unwrap();
        let mut m = sample("a1");
        m.status = Status::Processing;
        recover_interrupted(&mut m, dir);
        assert_eq!(m.status, Status::Failed);
    }

    /// Two interrupted runs in a row switch the match to safe mode.
    #[test]
    fn repeated_interruptions_use_safe_mode() {
        let tmp = tempfile::tempdir().unwrap();
        let mut m = sample("a1");
        for (run, message) in [(1, INTERRUPTED), (2, STOPPED_TWICE), (3, STOPPED_TWICE)] {
            m.status = Status::Processing;
            recover_interrupted(&mut m, tmp.path());
            assert_eq!(m.interrupted_runs, run);
            assert_eq!(m.error.as_ref().unwrap().message, message);
        }
        assert!(m.safe_mode());
        // Queued work that never started does not count.
        m.interrupted_runs = 0;
        m.status = Status::Queued;
        recover_interrupted(&mut m, tmp.path());
        assert_eq!(m.interrupted_runs, 0);
        assert_eq!(m.status, Status::Failed);
    }

    #[test]
    fn damaged_settings_and_half_deleted_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();
        let m = store.create(sample("abc123def456")).unwrap();
        let dir = store.project_dir(&m.id);
        std::fs::write(dir.join("left.mov"), b"12345").unwrap();
        std::fs::write(dir.join("right.001.mp4"), b"12").unwrap();
        std::fs::write(dir.join("right.002.mp4"), b"345").unwrap();
        drop(store);
        // A power cut left an empty project.json behind.
        std::fs::write(dir.join("project.json"), b"").unwrap();
        // A delete was cut short.
        let gone = tmp.path().join("projects").join("0123456789ab.deleting");
        std::fs::create_dir_all(gone.join("exports")).unwrap();

        let store = Store::open(tmp.path()).unwrap();
        assert!(!gone.exists());
        let m = store.get("abc123def456").unwrap();
        assert_eq!(m.status, Status::Failed);
        assert_eq!(m.name, "Recovered match");
        assert_eq!(m.files.left.as_ref().unwrap().size_bytes, 5);
        assert!(m.files.left.as_ref().unwrap().parts.is_empty());
        let right = m.files.right.as_ref().unwrap();
        assert_eq!(right.parts.len(), 2, "both parts found again");
        assert_eq!(
            (right.name.as_str(), right.size_bytes),
            ("right.001.mp4", 5)
        );
        drop(store);
        // It was saved, so it stays the same.
        let store = Store::open(tmp.path()).unwrap();
        assert_eq!(store.get("abc123def456").unwrap().created_at, m.created_at);
        store.delete("abc123def456").unwrap();
        assert!(store.list().is_empty());
    }

    #[test]
    fn write_atomic_leaves_no_temp_files() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("a.json");
        write_atomic(&path, b"one").unwrap();
        write_atomic(&path, b"two").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        assert!(write_atomic(&tmp.path().join("missing").join("b.json"), b"x").is_err());
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 1);
    }

    /// "Follow the ball" is Reco's ball mode; the others are field mode.
    #[test]
    fn styles() {
        use reco_autocam::TrackingMode;
        let ball: Style = serde_json::from_str("\"ball\"").unwrap();
        assert_eq!(ball, Style::Ball);
        assert_eq!(serde_json::to_value(Style::Ball).unwrap(), "ball");
        assert_eq!(ball.tracking_mode(), TrackingMode::Ball);
        assert_eq!(ball.preset(), "broadcast");
        for s in [Style::Broadcast, Style::Action, Style::FrameAll] {
            assert_eq!(s.tracking_mode(), TrackingMode::Field);
            assert!(
                reco_autocam::panners::FieldPannerConfig::from_preset_name(s.preset()).is_some()
            );
        }
        assert!(serde_json::from_str::<Style>("\"wild\"").is_err());
    }

    /// A camera that sees none of the pitch ignores everything it sees.
    #[test]
    fn pitch_outline_as_field_roi() {
        let square = vec![[0.1, 0.5], [0.9, 0.5], [0.9, 0.9], [0.1, 0.9]];
        let p = PitchOutline {
            id: "x".into(),
            points: vec![[0.0, 0.0]; 4],
            left: square.clone(),
            right: vec![],
        };
        let roi = p.field_roi();
        assert_eq!(roi.left, square);
        assert_eq!(roi.right.len(), 3);
        use reco_core::projection::point_in_polygon;
        for x in 0..=10 {
            for y in 0..=10 {
                let q = [x as f64 / 10.0, y as f64 / 10.0];
                assert!(!point_in_polygon(q, &roi.right), "{q:?}");
            }
        }
        assert!(point_in_polygon([0.5, 0.7], &roi.left));
        assert!(!point_in_polygon([0.5, 0.2], &roi.left));
    }

    /// Every frame by default, also for matches from older versions.
    #[test]
    fn ai_accuracy() {
        assert_eq!(AiAccuracy::default().interval(), 1);
        assert_eq!(AiAccuracy::Faster.interval(), 3);
        let mut v = serde_json::to_value(sample("a1")).unwrap();
        v.as_object_mut().unwrap().remove("aiAccuracy");
        let m: ProjectMeta = serde_json::from_value(v).unwrap();
        assert_eq!(m.ai_accuracy, AiAccuracy::Best);
        let f: AiAccuracy = serde_json::from_str("\"faster\"").unwrap();
        assert_eq!(f, AiAccuracy::Faster);
    }

    #[test]
    fn clock_times() {
        let fps = Fps {
            num: 30000,
            den: 1001,
        };
        assert_eq!(fps.clock(0), "0:00");
        assert_eq!(fps.clock(1799), "1:00");
    }

    #[test]
    fn ids() {
        let id = new_id();
        assert_eq!(id.len(), 12);
        assert!(valid_id(&id));
        assert!(!valid_id("../etc"));
        assert!(!valid_id(""));
    }

    #[test]
    fn finds_original_file() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("left.part"), b"").unwrap();
        assert!(original_files(tmp.path(), "left").is_empty());
        std::fs::write(tmp.path().join("left.MOV"), b"").unwrap();
        assert_eq!(
            original_files(tmp.path(), "left"),
            vec![tmp.path().join("left.MOV")]
        );
        assert!(original_files(tmp.path(), "right").is_empty());
    }

    /// A recording the camera split into several files (GoPro chapters).
    #[test]
    fn finds_the_parts_in_order() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        for name in [
            "left.003.mp4",
            "left.001.mp4",
            "left.002.mp4",
            "left.004.mp4.part",
            "left.0123456789ab.part",
            "left.mp4.0123456789ab.tmp",
            "left.000.mp4",
            "left.12.mp4",
            "left.x.mp4",
            "leftover.001.mp4",
            "matched-left.mp4",
            "right.001.mov",
            "right.003.mov",
        ] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let names = |files: Vec<PathBuf>| -> Vec<String> {
            files
                .iter()
                .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
                .collect()
        };
        assert_eq!(
            names(original_files(dir, "left")),
            ["left.001.mp4", "left.002.mp4", "left.003.mp4"]
        );
        let mut found = side_files(dir, "left");
        found.sort();
        assert_eq!(
            found.iter().map(|(n, _)| *n).collect::<Vec<_>>(),
            [Some(1), Some(2), Some(3)]
        );
        // Part 2 is missing: not usable yet.
        assert!(original_files(dir, "right").is_empty());
        std::fs::write(dir.join("right.002.mov"), b"x").unwrap();
        assert_eq!(original_files(dir, "right").len(), 3);
        // The matching copy is one file made from all the parts.
        std::fs::write(dir.join("matched-left.mp4"), b"x").unwrap();
        assert_eq!(names(working_files(dir, "left")), ["matched-left.mp4"]);
        assert_eq!(names(working_files(dir, "right")).len(), 3);

        // Only as many parts as the match says, all of them sent.
        let mut m = sample("a1");
        assert!(uploaded_files(&m, dir, "left").is_none());
        let part = |n: &str| {
            Some(PartInfo {
                name: n.into(),
                size_bytes: 1,
            })
        };
        m.files.left = Some(FileInfo::from_parts(vec![
            part("GX010042.MP4"),
            part("GX020042.MP4"),
            None,
        ]));
        assert!(uploaded_files(&m, dir, "left").is_none(), "part 3 not sent");
        m.files.left.as_mut().unwrap().parts[2] = part("GX030042.MP4");
        assert_eq!(uploaded_files(&m, dir, "left").unwrap().len(), 3);
        m.files.left.as_mut().unwrap().parts.pop();
        assert!(
            uploaded_files(&m, dir, "left").is_none(),
            "2 listed, 3 on disk"
        );
    }

    #[test]
    fn file_info_of_parts() {
        let part = |n: &str, size| PartInfo {
            name: n.into(),
            size_bytes: size,
        };
        let f = FileInfo::from_parts(vec![
            Some(part("GX010042.MP4", 4_000)),
            None,
            Some(part("GX030042.MP4", 1_000)),
        ]);
        assert_eq!((f.name.as_str(), f.size_bytes), ("GX010042.MP4", 5_000));
        assert!(!f.complete());
        assert_eq!(f.file_count(), 3);
        let v = serde_json::to_value(&f).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"name": "GX010042.MP4", "sizeBytes": 5000, "parts": [
                {"name": "GX010042.MP4", "sizeBytes": 4000}, null,
                {"name": "GX030042.MP4", "sizeBytes": 1000}]})
        );
        // One file: no parts listed, like before.
        let one = FileInfo::single("IMG_1.MOV".into(), 7);
        assert!(one.complete());
        assert_eq!(one.file_count(), 1);
        assert_eq!(
            serde_json::to_value(&one).unwrap(),
            serde_json::json!({"name": "IMG_1.MOV", "sizeBytes": 7})
        );
        let old: FileInfo = serde_json::from_str(r#"{"name":"a.mov","sizeBytes":3}"#).unwrap();
        assert!(old.parts.is_empty() && old.complete());
        let mut files = Files::default();
        assert!(!files.both());
        files.left = Some(one);
        files.right = Some(f);
        assert!(!files.both());
        files.right.as_mut().unwrap().parts[1] = Some(part("GX020042.MP4", 4_000));
        assert!(files.both());
    }

    /// The matching copy is used for processing, but is never an original.
    #[test]
    fn working_file_prefers_the_matching_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        for name in [
            "matched-right.mp4",
            "matched-right.json",
            "matched-right.0123456789ab.tmp.mp4",
        ] {
            std::fs::write(dir.join(name), b"").unwrap();
        }
        assert!(original_files(dir, "right").is_empty());
        assert!(
            working_files(dir, "right").is_empty(),
            "no copy without an original"
        );
        std::fs::write(dir.join("right.mov"), b"").unwrap();
        std::fs::write(dir.join("left.mp4"), b"").unwrap();
        assert_eq!(original_files(dir, "right"), vec![dir.join("right.mov")]);
        assert_eq!(
            working_files(dir, "right"),
            vec![dir.join("matched-right.mp4")]
        );
        assert_eq!(working_files(dir, "left"), vec![dir.join("left.mp4")]);
        assert!(remove_matched(dir, "right"));
        assert!(!remove_matched(dir, "right"));
        assert!(!matched_record(dir, "right").exists());
        assert_eq!(working_files(dir, "right"), vec![dir.join("right.mov")]);
        // A copy left half-made is cleared away at the next start.
        remove_part_files(dir);
        assert!(!dir.join("matched-right.0123456789ab.tmp.mp4").exists());
    }
}
