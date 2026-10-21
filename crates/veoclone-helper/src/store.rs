//! Projects on disk: `ProjectMeta` (the JSON shape the editor reads) and the
//! in-memory store that keeps every `project.json` up to date.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Message shown for jobs that were running when the helper was closed.
pub const INTERRUPTED: &str = "The helper was closed while this was running — press Try again";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Style {
    Broadcast,
    Action,
    FrameAll,
}

impl Style {
    /// Reco FieldPanner preset name.
    pub fn preset(self) -> &'static str {
        match self {
            Style::Broadcast => "broadcast",
            Style::Action => "action",
            Style::FrameAll => "frame_all",
        }
    }
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub name: String,
    pub size_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe: Option<ProbeInfo>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Files {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<FileInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<FileInfo>,
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
    pub lens_id: Option<String>,
    pub style: Style,
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

/// Write a file via a temporary file and a rename, so a crash never leaves
/// half a file behind.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let tmp = path.with_file_name(format!("{name}.{}.tmp", new_id()));
    std::fs::write(&tmp, bytes)?;
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
    /// when the helper stopped are marked failed (the work is lost).
    pub fn open(data_dir: &Path) -> std::io::Result<Store> {
        let root = data_dir.join("projects");
        std::fs::create_dir_all(&root)?;
        let mut map = HashMap::new();
        for entry in std::fs::read_dir(&root)?.flatten() {
            let dir = entry.path();
            let Ok(text) = std::fs::read_to_string(dir.join("project.json")) else {
                continue;
            };
            let mut meta: ProjectMeta = match serde_json::from_str(&text) {
                Ok(m) => m,
                Err(e) => {
                    log::warn!("Skipping unreadable {}: {e}", dir.display());
                    continue;
                }
            };
            if !valid_id(&meta.id) || entry.file_name().to_string_lossy() != meta.id {
                continue;
            }
            if recover_interrupted(&mut meta, &dir) {
                write_atomic(&dir.join("project.json"), &to_json(&meta))?;
            }
            remove_part_files(&dir);
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
            m.disk_bytes = dir_size(&self.project_dir(&m.id));
        }
        all
    }

    pub fn get(&self, id: &str) -> Option<ProjectMeta> {
        let mut meta = self.lock().get(id)?.meta.clone();
        meta.disk_bytes = dir_size(&self.project_dir(id));
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

    /// Forget a project and delete its folder.
    pub fn delete(&self, id: &str) -> std::io::Result<()> {
        let dir = self.project_dir(id);
        let mut map = self.lock();
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
        map.remove(id);
        Ok(())
    }
}

fn to_json(meta: &ProjectMeta) -> Vec<u8> {
    serde_json::to_vec_pretty(meta).expect("ProjectMeta always serializes")
}

/// Mark jobs that were cut short by a restart as failed. Returns true if
/// anything changed.
pub fn recover_interrupted(meta: &mut ProjectMeta, dir: &Path) -> bool {
    let mut changed = false;
    if matches!(meta.status, Status::Queued | Status::Processing) {
        meta.status = Status::Failed;
        meta.error = Some(ErrorInfo {
            message: INTERRUPTED.into(),
            detail: None,
        });
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

/// Remove leftovers of uploads and jobs that never finished
/// (`*.part`, `*.tmp`, `proxy.tmp.mp4`, `ai_pass.tmp.mkv`).
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

/// The uploaded original for one side (`left.<ext>` / `right.<ext>`).
pub fn original_file(dir: &Path, side: &str) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| {
            p.is_file()
                && p.file_stem().is_some_and(|s| s == side)
                && p.extension().is_some_and(|x| x != "part" && x != "tmp")
        })
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
            style: Style::Broadcast,
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
        assert_eq!(v["job"], serde_json::Value::Null);
        assert_eq!(v["error"], serde_json::Value::Null);
        assert_eq!(v["style"], "frame_all");
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
        assert!(original_file(tmp.path(), "left").is_none());
        std::fs::write(tmp.path().join("left.MOV"), b"").unwrap();
        assert_eq!(
            original_file(tmp.path(), "left").unwrap(),
            tmp.path().join("left.MOV")
        );
        assert!(original_file(tmp.path(), "right").is_none());
    }
}
