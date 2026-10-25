//! "What the AI saw": the AI pass records every person and ball the AI
//! found (before any filtering), so a new camera style, AI accuracy, widest
//! view or pitch outline needs no new pass over the video. [`repan`]
//! rebuilds the AI camera path from the recording the way Reco's session
//! does:
//!
//! 1. per detection frame, the recorded detections of both cameras, left
//!    then right (session/detection.rs), the ball-mode confidence floor and
//!    the pitch outline (reco-autocam `RoiFilteredDetector`, Reco's own
//!    code, with the person anchor `setup_autocam` installs);
//! 2. `map_detections` (`camera_to_panorama` with the pipeline's scene);
//!    frames between detection frames re-use the last detections
//!    (session/detection_dispatch.rs);
//! 3. the trackers of `setup_autocam` (players first, then the ball, as
//!    `dispatch_detect_only`), one `WorldState` per frame;
//! 4. `FieldPanner::decide_with_lookahead` with the next `n` world states
//!    (the lookahead buffer of session/run_loop.rs), then the loop's
//!    centred moving average (`centered_smooth`, same summation order).
//!
//! File format (`ai_seen.bin.gz`, gzip): one block per `detect()` call,
//! `u8` camera (0 left, 1 right), `u32` count, then per detection `u16`
//! class, `f32` confidence, centre x, centre y, width, height (little
//! endian). Only the person and ball classes are kept (nothing else reaches
//! a tracker). `ai_seen.json` ([`SeenMeta`]) says how it was made.

use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use reco_autocam::panners::FieldPannerConfig;
use reco_core::calibration::{FieldRoi, MatchCalibration};
use reco_core::detect::DetectionTarget;
use reco_core::detect::detector::{
    CameraId, ChromaFormat, Detection, DetectorError, DetectorFrame, RawFrame, UnifiedDetector,
};
use reco_core::detect::director::{MappedDetection, ViewportPosition};
use reco_core::detect::panner::{PanContext, Panner};
use reco_core::detect::tracker::{Tracker, WorldState};
use reco_core::render::scene::SceneGeometry;
use reco_core::session::StitchSession;
use serde::{Deserialize, Serialize};

use crate::store::Style;

/// The recording and what it was made with.
pub const SEEN_DATA: &str = "ai_seen.bin.gz";
pub const SEEN_META: &str = "ai_seen.json";
/// Both, for removing them together with the AI path.
pub const SEEN_FILES: [&str; 2] = [SEEN_DATA, SEEN_META];

/// The AI pass detects at Reco's field-mode floor, so the recording holds
/// what every style needs.
pub const RECORD_CONFIDENCE: f32 = 0.10;
/// Reco's ball mode floor (reco-cli / reco-gui). Reco keeps a detection
/// when `confidence >= threshold` (reco-detect `postprocess`), so keeping
/// the recorded ones at or above it gives exactly the same detections.
pub const BALL_CONFIDENCE: f32 = 0.25;
pub const VERSION: u32 = 1;
const DETECTION_BYTES: usize = 22;

/// The model's class ids, resolved like reco-autocam's `setup_autocam`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Classes {
    /// `resolve_class_id(["person"])`: the player tracker's class.
    pub person: Option<u16>,
    /// `resolve_or(["ball", "sports ball"], 32)`.
    pub ball: u16,
    /// `resolve_or(["person"], 0)`: the class the pitch outline tests by
    /// its feet.
    pub roi_person: u16,
}

impl Classes {
    pub fn from_names(names: &[String]) -> Classes {
        let find = |candidates: &[&str]| {
            candidates.iter().find_map(|c| {
                names
                    .iter()
                    .position(|n| n.eq_ignore_ascii_case(c))
                    .map(|i| i as u16)
            })
        };
        let person = find(&["person"]);
        Classes {
            person,
            ball: find(&["ball", "sports ball"]).unwrap_or(32),
            roi_person: person.unwrap_or(0),
        }
    }

    fn keep(&self, class: u16) -> bool {
        class == self.ball || Some(class) == self.person || class == self.roi_person
    }
}

/// How a recording was made (`ai_seen.json`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeenMeta {
    pub version: u32,
    /// The AI model's file name and size: another model sees differently.
    pub model: String,
    pub model_bytes: u64,
    pub classes: Classes,
    /// The frame rate `setup_autocam` was given (`SourceInfo::fps as f32`).
    pub fps: f32,
    /// Reco's lookahead buffer, in frames.
    pub lookahead_frames: usize,
    /// The AI looked at every `every`th frame.
    pub every: u64,
    /// Frames of the AI pass.
    pub frames: u64,
    /// The calibration's sync offset (the frame pairing).
    pub sync_offset: i64,
}

/// "Widest view": how far the AI camera may zoom out (DESIGN.md 4.12).
///
/// Reco's presets let the camera zoom out to 58° (broadcast), 48° (action)
/// or 70° (frame-all) of vertical view, about 89°, 77° and 102° across at
/// 16:9. A flat (rectilinear) picture that wide stretches whatever is at its
/// sides: something at the left or right edge looks `1 / cos²(half the
/// width)` times wider than in the middle, about twice as wide at 89°. Veo
/// stays near 50–60° across. The cap is applied to the FieldPanner config
/// ([`WidestView::limit`]) the same way by the AI pass and by [`repan`], so
/// changing it re-runs in seconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WidestView {
    /// Like Veo: at most 34° tall, about 57° across (a 33 mm lens on a
    /// full-frame camera). The sides look at most 1.3 times wider than the
    /// middle.
    Natural,
    /// At most 44° tall, about 71° across; the sides up to 1.5 times wider.
    Wide,
    /// No extra cap: Reco's preset as it is (VeoClone before this setting).
    Widest,
}

impl WidestView {
    /// What new matches use.
    pub const NEW_MATCH: WidestView = WidestView::Natural;

    /// The setting a match uses: none stored means a match from before the
    /// setting existed, which keeps behaving as it did (Widest).
    pub fn effective(stored: Option<WidestView>) -> WidestView {
        stored.unwrap_or(WidestView::Widest)
    }

    /// The widest vertical field of view in degrees; `None`: the preset's.
    /// The editor uses the same numbers (`web/src/engine/path.ts`).
    pub fn max_fov_deg(self) -> Option<f32> {
        match self {
            WidestView::Natural => Some(34.0),
            WidestView::Wide => Some(44.0),
            WidestView::Widest => None,
        }
    }

    /// A FieldPanner config that never zooms out beyond the cap:
    /// `fov_wide = min(preset, cap)`, then the start (`fov_default`, also
    /// ball mode's fixed zoom) and the tightest zoom brought down so that
    /// `fov_tight <= fov_default <= fov_wide`, which Reco's `sanitized`
    /// then leaves as it is.
    pub fn limit(self, mut config: FieldPannerConfig) -> FieldPannerConfig {
        if let Some(cap) = self.max_fov_deg() {
            config.fov_wide = config.fov_wide.min(cap);
            config.fov_default = config.fov_default.min(config.fov_wide);
            config.fov_tight = config.fov_tight.min(config.fov_default);
        }
        config
    }

    /// For the job log.
    pub fn describe(self) -> String {
        let name = match self {
            WidestView::Natural => "Natural",
            WidestView::Wide => "Wide",
            WidestView::Widest => "Widest",
        };
        match self.max_fov_deg() {
            Some(v) => {
                let across = 2.0 * (16.0 / 9.0 * (v.to_radians() / 2.0).tan()).atan();
                format!(
                    "{name}: the AI camera zooms out to at most {v:.0} deg tall ({:.0} deg \
                     across)",
                    across.to_degrees()
                )
            }
            None => format!("{name}: the AI camera zooms out as far as Reco's preset allows"),
        }
    }
}

/// The FieldPanner config of a camera style with the widest view applied,
/// as both the AI pass (given to `setup_autocam`) and [`repan`] use it.
/// Ball mode's `ball_weight = 1.0` comes on top (`setup_autocam` / repan).
pub fn panner_config(style: Style, widest: WidestView) -> Option<FieldPannerConfig> {
    FieldPannerConfig::from_preset_name(style.preset()).map(|c| widest.limit(c))
}

/// What a re-run needs to know about a recording, for the editor.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SeenSummary {
    /// The AI looked at every `every`th frame; a re-run can use it for this
    /// AI accuracy or a coarser one.
    pub every: u64,
}

pub fn model_identity(model: &Path) -> (String, u64) {
    let name = model
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    (name, std::fs::metadata(model).map(|m| m.len()).unwrap_or(0))
}

pub fn read_meta(dir: &Path) -> Option<SeenMeta> {
    if !dir.join(SEEN_DATA).is_file() {
        return None;
    }
    let meta: SeenMeta = serde_json::from_slice(&std::fs::read(dir.join(SEEN_META)).ok()?).ok()?;
    (meta.version == VERSION).then_some(meta)
}

pub fn summary(dir: &Path) -> Option<SeenSummary> {
    read_meta(dir).map(|m| SeenSummary { every: m.every })
}

pub fn remove(dir: &Path) {
    for f in SEEN_FILES {
        let _ = std::fs::remove_file(dir.join(f));
    }
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/// Streams the detections to a gzip file while the AI pass runs.
pub struct SeenWriter {
    path: PathBuf,
    out: Option<GzEncoder<BufWriter<std::fs::File>>>,
    classes: Classes,
    error: Option<String>,
    /// Detection frames written (left-camera calls).
    pub frames: u64,
}

impl SeenWriter {
    pub fn create(path: &Path, classes: Classes) -> std::io::Result<SeenWriter> {
        let file = std::fs::File::create(path)?;
        Ok(SeenWriter {
            path: path.to_path_buf(),
            out: Some(GzEncoder::new(
                BufWriter::with_capacity(1 << 20, file),
                Compression::default(),
            )),
            classes,
            error: None,
            frames: 0,
        })
    }

    fn record(&mut self, camera: CameraId, detections: &[Detection]) {
        if camera == CameraId::Left {
            self.frames += 1;
        }
        let Some(out) = self.out.as_mut() else { return };
        let kept: Vec<&Detection> = detections
            .iter()
            .filter(|d| self.classes.keep(d.class_id))
            .collect();
        let mut buf = Vec::with_capacity(5 + kept.len() * DETECTION_BYTES);
        buf.push(u8::from(camera == CameraId::Right));
        buf.extend((kept.len() as u32).to_le_bytes());
        for d in kept {
            buf.extend(d.class_id.to_le_bytes());
            for v in [d.confidence, d.center_x, d.center_y, d.width, d.height] {
                buf.extend(v.to_le_bytes());
            }
        }
        if let Err(e) = out.write_all(&buf) {
            // A full disk must not stop the AI pass; only the quick
            // re-runs are lost.
            self.error = Some(e.to_string());
            self.out = None;
        }
    }

    /// Finish the file. Returns its path, or why it is unusable.
    pub fn finish(&mut self) -> Result<PathBuf, String> {
        if let Some(e) = self.error.take() {
            return Err(e);
        }
        let out = self.out.take().ok_or("already finished")?;
        let mut file = out.finish().map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())?;
        Ok(self.path.clone())
    }
}

/// Wraps the detector `setup_autocam` made and records what it returns,
/// unchanged.
pub struct Recorder {
    inner: Box<dyn UnifiedDetector>,
    writer: Arc<Mutex<SeenWriter>>,
}

impl UnifiedDetector for Recorder {
    fn name(&self) -> &'static str {
        self.inner.name()
    }

    fn detect(
        &mut self,
        camera: CameraId,
        frame: &DetectorFrame<'_>,
    ) -> Result<Vec<Detection>, DetectorError> {
        let result = self.inner.detect(camera, frame);
        // A failed call counts as nothing found, as in the session.
        let found = result.as_deref().unwrap_or(&[]);
        self.writer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .record(camera, found);
        result
    }

    fn class_names(&self) -> Option<&[String]> {
        self.inner.class_names()
    }
}

/// Keeps the detections at or above a confidence (Reco's ball mode floor).
pub struct MinConfidence {
    inner: Box<dyn UnifiedDetector>,
    min: f32,
}

impl UnifiedDetector for MinConfidence {
    fn name(&self) -> &'static str {
        self.inner.name()
    }

    fn detect(
        &mut self,
        camera: CameraId,
        frame: &DetectorFrame<'_>,
    ) -> Result<Vec<Detection>, DetectorError> {
        let mut found = self.inner.detect(camera, frame)?;
        found.retain(|d| d.confidence >= self.min);
        Ok(found)
    }

    fn class_names(&self) -> Option<&[String]> {
        self.inner.class_names()
    }
}

/// The detector chain the AI pass uses, around the detector `setup_autocam`
/// picked: record everything, then the ball-mode floor, then the pitch
/// outline (what `setup_autocam` does for a `field_roi`).
pub fn wrap_detector(
    detector: Box<dyn UnifiedDetector>,
    writer: Option<Arc<Mutex<SeenWriter>>>,
    min_confidence: Option<f32>,
    roi: Option<(FieldRoi, u16)>,
) -> Box<dyn UnifiedDetector> {
    let mut d = detector;
    if let Some(writer) = writer {
        d = Box::new(Recorder { inner: d, writer });
    }
    if let Some(min) = min_confidence {
        d = Box::new(MinConfidence { inner: d, min });
    }
    if let Some((roi, person)) = roi {
        d = Box::new(
            reco_autocam::RoiFilteredDetector::new(d, roi)
                .with_class_anchor(person, reco_autocam::RoiAnchor::Bottom),
        );
    }
    d
}

/// Hands `setup_autocam` the session, putting [`wrap_detector`]'s chain
/// around the detector it attaches.
pub struct Wiring<'a, F: FnOnce(Box<dyn UnifiedDetector>) -> Box<dyn UnifiedDetector>> {
    pub session: &'a mut StitchSession,
    pub wrap: Option<F>,
}

impl<F: FnOnce(Box<dyn UnifiedDetector>) -> Box<dyn UnifiedDetector>> DetectionTarget
    for Wiring<'_, F>
{
    fn set_detector(&mut self, detector: Box<dyn UnifiedDetector>) {
        let detector = match self.wrap.take() {
            Some(wrap) => wrap(detector),
            None => detector,
        };
        self.session.set_detector(detector);
    }
    fn set_detection_interval(&mut self, interval: u64) {
        self.session.set_detection_interval(interval);
    }
    fn set_ball_tracker(&mut self, tracker: Box<dyn Tracker>) {
        self.session.set_ball_tracker(tracker);
    }
    fn set_player_tracker(&mut self, tracker: Box<dyn Tracker>) {
        self.session.set_player_tracker(tracker);
    }
    fn set_panner(&mut self, panner: Box<dyn Panner>) {
        self.session.set_panner(panner);
    }
    fn pipeline(&self) -> &reco_core::render::pipeline::StitchPipeline {
        DetectionTarget::pipeline(&*self.session)
    }
    fn gpu(&self) -> &reco_core::gpu::GpuContext {
        DetectionTarget::gpu(&*self.session)
    }
}

// ---------------------------------------------------------------------------
// Reading and re-panning
// ---------------------------------------------------------------------------

/// The recorded detections, one list per detection frame (left camera's,
/// then the right camera's).
pub fn read_frames(path: &Path) -> std::io::Result<Vec<Vec<Detection>>> {
    let mut data = Vec::new();
    GzDecoder::new(std::io::BufReader::new(std::fs::File::open(path)?)).read_to_end(&mut data)?;
    let bad = || std::io::Error::new(std::io::ErrorKind::InvalidData, "damaged recording");
    let mut frames: Vec<Vec<Detection>> = Vec::new();
    let mut at = 0;
    let take = |at: &mut usize, n: usize| -> std::io::Result<&[u8]> {
        let s = data.get(*at..*at + n).ok_or_else(bad)?;
        *at += n;
        Ok(s)
    };
    while at < data.len() {
        let camera = match take(&mut at, 1)?[0] {
            0 => CameraId::Left,
            1 => CameraId::Right,
            _ => return Err(bad()),
        };
        let n = u32::from_le_bytes(take(&mut at, 4)?.try_into().unwrap()) as usize;
        if camera == CameraId::Left || frames.is_empty() {
            frames.push(Vec::new());
        }
        let frame = frames.last_mut().unwrap();
        for _ in 0..n {
            let b = take(&mut at, DETECTION_BYTES)?;
            let f = |i: usize| f32::from_le_bytes(b[i..i + 4].try_into().unwrap());
            frame.push(Detection {
                camera,
                class_id: u16::from_le_bytes([b[0], b[1]]),
                confidence: f(2),
                center_x: f(6),
                center_y: f(10),
                width: f(14),
                height: f(18),
            });
        }
    }
    Ok(frames)
}

/// The settings a re-pan uses.
#[derive(Debug, Clone)]
pub struct RepanSettings {
    pub style: Style,
    /// Run the AI on every `every`th frame (a multiple of the recording's).
    pub every: u64,
    pub roi: Option<FieldRoi>,
    /// How far the AI camera may zoom out.
    pub widest: WidestView,
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct RepanStats {
    /// Detections of the detection frames before / after the confidence
    /// floor and the pitch outline.
    pub seen: u64,
    pub kept: u64,
    pub outside_pitch: u64,
}

/// Plays the recorded detections back to the pitch-outline filter.
struct Replay(Arc<Mutex<Vec<Detection>>>);

impl UnifiedDetector for Replay {
    fn name(&self) -> &'static str {
        "replay"
    }
    fn detect(
        &mut self,
        camera: CameraId,
        _frame: &DetectorFrame<'_>,
    ) -> Result<Vec<Detection>, DetectorError> {
        let all = self.0.lock().unwrap_or_else(|e| e.into_inner());
        Ok(all.iter().filter(|d| d.camera == camera).cloned().collect())
    }
}

/// One pose per frame (`[yaw, pitch, fov]`), as the AI pass records them.
pub type Poses = Vec<Option<[f32; 3]>>;

/// Rebuild the AI camera path (one pose per frame, like the AI pass's
/// `PanDecision`s, `None` never happens) from a recording.
pub fn repan(
    cal: &MatchCalibration,
    meta: &SeenMeta,
    frames: &[Vec<Detection>],
    settings: &RepanSettings,
) -> Result<(Poses, RepanStats), String> {
    let n = meta.frames as usize;
    if settings.every == 0 || !settings.every.is_multiple_of(meta.every) {
        return Err(format!(
            "recorded every {} frames, asked for every {}",
            meta.every, settings.every
        ));
    }
    if frames.len() < n.div_ceil(meta.every as usize) {
        return Err(format!(
            "recording has {} detection frames, {n} frames need {}",
            frames.len(),
            n.div_ceil(meta.every as usize)
        ));
    }
    let classes = meta.classes;
    let ball_mode = settings.style == Style::Ball;

    // The detector chain after the recorder (wrap_detector), on a replay.
    let shared = Arc::new(Mutex::new(Vec::new()));
    let mut filter: Box<dyn UnifiedDetector> = Box::new(Replay(shared.clone()));
    if let Some(roi) = settings.roi.clone() {
        filter = Box::new(
            reco_autocam::RoiFilteredDetector::new(filter, roi)
                .with_class_anchor(classes.roi_person, reco_autocam::RoiAnchor::Bottom),
        );
    }
    let empty = RawFrame {
        y: &[],
        chroma: ChromaFormat::Nv12 { uv: &[] },
        width: cal.left.width,
        height: cal.left.height,
    };
    let frame = DetectorFrame::Cpu(empty);

    // The pipeline's scene (render/pipeline.rs StitchPipeline::with_gpu).
    let scene = SceneGeometry::from_layout_with_aspect(
        &cal.layout,
        cal.left.width as f32 / cal.left.height as f32,
    );
    let map = |d: &Detection| MappedDetection {
        camera: d.camera,
        class_id: d.class_id,
        confidence: d.confidence,
        camera_center: (d.center_x, d.center_y),
        camera_size: (d.width, d.height),
        position: reco_core::projection::camera_to_panorama(
            d.camera, d.center_x, d.center_y, cal, &scene,
        ),
    };

    // setup_autocam's trackers and panner for this style (the config the AI
    // pass gives it).
    let preset = panner_config(settings.style, settings.widest).ok_or("unknown preset")?;
    let (mut players, mut ball, config): (Option<Box<dyn Tracker>>, Box<dyn Tracker>, _) =
        if ball_mode {
            let mut config = preset;
            config.ball_weight = 1.0;
            (
                None,
                Box::new(
                    reco_autocam::trackers::BallTracker::new(classes.ball).with_max_jump_rad(0.5),
                ),
                config,
            )
        } else {
            (
                classes.person.map(|p| {
                    Box::new(reco_autocam::trackers::ClassProvider::new(p)) as Box<dyn Tracker>
                }),
                Box::new(
                    reco_autocam::trackers::BallTracker::new(classes.ball).with_max_jump_rad(0.8),
                ),
                preset,
            )
        };
    let mut panner = reco_autocam::panners::FieldPanner::with_config(meta.fps, config);

    let mut stats = RepanStats::default();
    let mut last: Vec<MappedDetection> = Vec::new();
    let mut worlds: Vec<WorldState> = Vec::with_capacity(n);
    for i in 0..n as u64 {
        if i.is_multiple_of(settings.every) {
            let raw = &frames[(i / meta.every) as usize];
            let mut found: Vec<Detection> = raw
                .iter()
                .filter(|d| !ball_mode || d.confidence >= BALL_CONFIDENCE)
                .cloned()
                .collect();
            stats.seen += raw.len() as u64;
            let before = found.len() as u64;
            *shared.lock().unwrap_or_else(|e| e.into_inner()) = found;
            found = Vec::new();
            for camera in [CameraId::Left, CameraId::Right] {
                found.extend(filter.detect(camera, &frame).map_err(|e| e.to_string())?);
            }
            stats.outside_pitch += before - found.len() as u64;
            stats.kept += found.len() as u64;
            last = found.iter().map(map).collect();
        }
        // dispatch_detect_only: players first, then the ball.
        let mut world = WorldState::default();
        if let Some(t) = players.as_mut() {
            world.players = t.update(&last, 0.0);
        }
        ball.observe_world(&world);
        world.ball = ball.update(&last, 0.0).into_iter().next();
        worlds.push(world);
    }

    // run_buffered: the panner sees the next `lookahead` world states...
    let look = meta.lookahead_frames;
    let raw: Vec<ViewportPosition> = (0..n)
        .map(|i| {
            let ctx = PanContext {
                frame_index: i as u64,
                timestamp_ms: 0.0,
                previous_position: ViewportPosition::default(),
                calibration: cal,
            };
            let future = &worlds[(i + 1).min(n)..(i + 1 + look).min(n)];
            panner.decide_with_lookahead(&worlds[i], future, &ctx)
        })
        .collect();
    // ...and each frame is drawn with the centred average of its raw pose,
    // up to `half` poses ahead and `half` behind (centered_smooth: the raw
    // pose, then ahead nearest first, then behind oldest first).
    let half = (look / 2).max(1);
    let poses = (0..n)
        .map(|i| {
            let mut yaw = raw[i].yaw;
            let mut pitch = raw[i].pitch;
            let mut fov = raw[i].fov_degrees.unwrap_or(0.0);
            let mut fov_n = u32::from(raw[i].fov_degrees.is_some());
            let mut count = 1u32;
            let ahead = &raw[(i + 1).min(n)..(i + 1 + half).min(n)];
            let behind = &raw[i.saturating_sub(half)..i];
            for p in ahead.iter().chain(behind) {
                yaw += p.yaw;
                pitch += p.pitch;
                if let Some(f) = p.fov_degrees {
                    fov += f;
                    fov_n += 1;
                }
                count += 1;
            }
            let fov = if fov_n > 0 {
                fov / fov_n as f32
            } else {
                f32::NAN
            };
            Some([yaw / count as f32, pitch / count as f32, fov])
        })
        .collect();
    Ok((poses, stats))
}

/// The largest yaw, pitch (radians) and fov (degrees) difference of two
/// paths.
pub fn max_difference(a: &[[f32; 3]], b: &[[f32; 3]]) -> [f32; 3] {
    let mut d = [0.0f32; 3];
    for (p, q) in a.iter().zip(b) {
        for k in 0..3 {
            d[k] = d[k].max((p[k] - q[k]).abs());
        }
    }
    if a.len() != b.len() {
        d = [f32::INFINITY; 3];
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    fn det(camera: CameraId, class_id: u16, conf: f32, x: f32, y: f32) -> Detection {
        Detection {
            camera,
            class_id,
            confidence: conf,
            center_x: x,
            center_y: y,
            width: 0.02,
            height: 0.06,
        }
    }

    #[test]
    fn classes_like_setup_autocam() {
        let names: Vec<String> = ["Person", "bicycle", "sports ball"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let c = Classes::from_names(&names);
        assert_eq!(
            c,
            Classes {
                person: Some(0),
                ball: 2,
                roi_person: 0
            }
        );
        let c = Classes::from_names(&[]);
        assert_eq!((c.person, c.ball, c.roi_person), (None, 32, 0));
    }

    #[test]
    fn recording_round_trip_keeps_the_exact_numbers() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("seen.gz");
        let classes = Classes::from_names(&["person".into(), "car".into(), "sports ball".into()]);
        let mut w = SeenWriter::create(&path, classes).unwrap();
        let a = det(CameraId::Left, 0, 0.123_456_79, 0.1, 0.9);
        let car = det(CameraId::Left, 1, 0.9, 0.5, 0.5);
        let b = det(CameraId::Right, 2, 0.31, 1.0 / 3.0, 0.25);
        w.record(CameraId::Left, &[a, car]);
        w.record(CameraId::Right, std::slice::from_ref(&b));
        w.record(CameraId::Left, &[]);
        w.record(CameraId::Right, &[]);
        assert_eq!(w.frames, 2);
        w.finish().unwrap();
        let frames = read_frames(&path).unwrap();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].len(), 2, "the car is not kept");
        for (got, want) in frames[0].iter().zip([&a, &b]) {
            assert_eq!(got.camera, want.camera);
            assert_eq!(got.class_id, want.class_id);
            assert_eq!(got.confidence.to_bits(), want.confidence.to_bits());
            assert_eq!(got.center_x.to_bits(), want.center_x.to_bits());
            assert_eq!(got.height.to_bits(), want.height.to_bits());
        }
        assert!(frames[1].is_empty());
        std::fs::write(&path, b"nonsense").unwrap();
        assert!(read_frames(&path).is_err());
    }

    fn synth_meta(frames: u64, every: u64) -> SeenMeta {
        SeenMeta {
            version: VERSION,
            model: "m.onnx".into(),
            model_bytes: 1,
            classes: Classes {
                person: Some(0),
                ball: 32,
                roi_person: 0,
            },
            fps: 30.0,
            lookahead_frames: 45,
            every,
            frames,
            sync_offset: 0,
        }
    }

    /// Players drifting right and a ball crossing the picture.
    fn synth_frames(n: usize) -> Vec<Vec<Detection>> {
        (0..n)
            .map(|i| {
                let t = i as f32 / n as f32;
                let mut f: Vec<Detection> = (0..8)
                    .map(|k| det(CameraId::Left, 0, 0.6, 0.3 + 0.05 * k as f32 + 0.2 * t, 0.6))
                    .collect();
                f.push(det(CameraId::Left, 32, 0.4, 0.1 + 0.8 * t, 0.55));
                f.push(det(CameraId::Right, 0, 0.5, 0.2, 0.2)); // a spectator
                f.push(det(CameraId::Right, 32, 0.15, 0.7, 0.7)); // a faint "ball"
                f
            })
            .collect()
    }

    #[test]
    fn repan_styles_accuracy_and_pitch() {
        let cal: MatchCalibration = serde_json::from_str(crate::calib::tests::SYNTH_MATCH).unwrap();
        let frames = synth_frames(300);
        let meta = synth_meta(300, 1);
        let run = |style, every, roi| {
            let s = RepanSettings {
                style,
                every,
                roi,
                widest: WidestView::Widest,
            };
            repan(&cal, &meta, &frames, &s).unwrap()
        };
        let (broadcast, stats) = run(Style::Broadcast, 1, None);
        assert_eq!(broadcast.len(), 300);
        assert!(
            broadcast
                .iter()
                .flatten()
                .all(|p| p.iter().all(|v| v.is_finite()))
        );
        assert_eq!(
            (stats.seen, stats.kept, stats.outside_pitch),
            (3300, 3300, 0)
        );
        let path = |p: &[Option<[f32; 3]>]| p.iter().map(|x| x.unwrap()).collect::<Vec<_>>();
        // Deterministic.
        assert_eq!(run(Style::Broadcast, 1, None).0, broadcast);
        // Ball mode: the faint ball is below its floor, and the zoom stays.
        let (ball, stats) = run(Style::Ball, 1, None);
        assert_eq!(stats.kept, 3000);
        assert!(path(&ball).iter().all(|p| p[2] == 40.0));
        assert!(max_difference(&path(&ball), &path(&broadcast))[0] > 0.01);
        // Every 3rd frame differs, and needs a recording of every frame.
        let (third, stats) = run(Style::Broadcast, 3, None);
        assert_eq!(stats.seen, 1100);
        assert_ne!(third, broadcast);
        let coarse = synth_meta(300, 3);
        let s = RepanSettings {
            style: Style::Broadcast,
            every: 1,
            roi: None,
            widest: WidestView::Widest,
        };
        assert!(repan(&cal, &coarse, &frames, &s).is_err());
        // The pitch outline drops the spectator high up in the right camera.
        let roi = FieldRoi {
            left: vec![[0.0, 0.3], [1.0, 0.3], [1.0, 1.0], [0.0, 1.0]],
            right: vec![[0.0, 0.3], [1.0, 0.3], [1.0, 1.0], [0.0, 1.0]],
        };
        let (_, stats) = run(Style::Broadcast, 1, Some(roi));
        assert_eq!(stats.outside_pitch, 300);
        // Too short a recording is refused.
        assert!(repan(&cal, &meta, &frames[..100], &s).is_err());
    }

    /// The cap of every widest view on every style's preset: never wider
    /// than the cap, tight <= start <= wide, nothing for Reco to correct;
    /// Widest is the preset itself.
    #[test]
    fn widest_view_caps_every_preset() {
        let styles = [
            Style::Broadcast,
            Style::Action,
            Style::FrameAll,
            Style::Ball,
        ];
        for style in styles {
            let preset = FieldPannerConfig::from_preset_name(style.preset()).unwrap();
            assert_eq!(
                panner_config(style, WidestView::Widest),
                Some(preset.clone())
            );
            for widest in [WidestView::Natural, WidestView::Wide] {
                let cap = widest.max_fov_deg().unwrap();
                let c = panner_config(style, widest).unwrap();
                assert_eq!(c.fov_wide, preset.fov_wide.min(cap), "{style:?} {widest:?}");
                assert!(c.fov_tight <= c.fov_default && c.fov_default <= c.fov_wide);
                assert_eq!(c.clone().sanitized(), c, "Reco changes nothing");
                // Only the zoom range changes.
                let same = FieldPannerConfig {
                    fov_wide: preset.fov_wide,
                    fov_default: preset.fov_default,
                    fov_tight: preset.fov_tight,
                    ..c.clone()
                };
                assert_eq!(same, preset);
            }
        }
        // Natural: Reco's broadcast preset starts at 40 and may go to 58.
        let n = panner_config(Style::Broadcast, WidestView::Natural).unwrap();
        assert_eq!((n.fov_tight, n.fov_default, n.fov_wide), (22.0, 34.0, 34.0));
        let w = panner_config(Style::Broadcast, WidestView::Wide).unwrap();
        assert_eq!((w.fov_tight, w.fov_default, w.fov_wide), (22.0, 40.0, 44.0));
        let a = panner_config(Style::Action, WidestView::Natural).unwrap();
        assert_eq!((a.fov_tight, a.fov_default, a.fov_wide), (20.0, 34.0, 34.0));
        // A cap below the tightest zoom pins the zoom (not used, but safe).
        let mut tiny = FieldPannerConfig::broadcast();
        tiny.fov_wide = 10.0;
        let t = WidestView::Natural.limit(tiny);
        assert_eq!((t.fov_tight, t.fov_default, t.fov_wide), (10.0, 10.0, 10.0));
    }

    #[test]
    fn widest_view_names_and_defaults() {
        for (w, s) in [
            (WidestView::Natural, "natural"),
            (WidestView::Wide, "wide"),
            (WidestView::Widest, "widest"),
        ] {
            assert_eq!(serde_json::to_value(w).unwrap(), s);
            assert_eq!(serde_json::from_value::<WidestView>(s.into()).unwrap(), w);
        }
        assert!(serde_json::from_str::<WidestView>("\"fisheye\"").is_err());
        assert_eq!(WidestView::NEW_MATCH, WidestView::Natural);
        // A match from before the setting keeps the old camera.
        assert_eq!(WidestView::effective(None), WidestView::Widest);
        assert_eq!(
            WidestView::effective(Some(WidestView::Wide)),
            WidestView::Wide
        );
        assert!(
            WidestView::Natural
                .describe()
                .contains("34 deg tall (57 deg across)")
        );
        assert!(
            WidestView::Wide
                .describe()
                .contains("44 deg tall (71 deg across)")
        );
    }

    /// Natural keeps the AI camera at or inside its cap for every style,
    /// ball mode at that fixed zoom; it changes the zoom only, not where the
    /// camera looks.
    #[test]
    fn repan_with_a_widest_view() {
        let cal: MatchCalibration = serde_json::from_str(crate::calib::tests::SYNTH_MATCH).unwrap();
        let frames = synth_frames(300);
        let meta = synth_meta(300, 1);
        let run = |style, widest| {
            let s = RepanSettings {
                style,
                every: 1,
                roi: None,
                widest,
            };
            let (p, _) = repan(&cal, &meta, &frames, &s).unwrap();
            p.into_iter().map(|x| x.unwrap()).collect::<Vec<_>>()
        };
        let max_fov = |p: &[[f32; 3]]| p.iter().map(|x| x[2]).fold(f32::MIN, f32::max);
        for style in [Style::Broadcast, Style::Action, Style::FrameAll] {
            let widest = run(style, WidestView::Widest);
            let natural = run(style, WidestView::Natural);
            assert!(max_fov(&widest) > 34.5, "{style:?} zooms out past the cap");
            assert!(
                max_fov(&natural) <= 34.0 + 1e-3,
                "{style:?}: {}",
                max_fov(&natural)
            );
            assert!(max_fov(&run(style, WidestView::Wide)) <= 44.0 + 1e-3);
            // Reco's FieldPanner aims without looking at its zoom.
            let [dy, dp, df] = max_difference(&natural, &widest);
            assert_eq!((dy, dp), (0.0, 0.0), "{style:?}: only the zoom changes");
            assert!(df > 1.0, "{style:?} zoom changed by {df}");
        }
        let ball = run(Style::Ball, WidestView::Natural);
        assert!(ball.iter().all(|p| p[2] == 34.0));
        let [dy, dp, _] = max_difference(&ball, &run(Style::Ball, WidestView::Widest));
        assert_eq!((dy, dp), (0.0, 0.0), "ball mode: only the zoom changes");
    }
}
