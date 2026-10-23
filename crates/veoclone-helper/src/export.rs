//! Export (`POST /exports`): render each keep-range with Reco following the
//! editor's final camera path, join the parts into one MP4, then burn in the
//! editor's text boxes, if any (DESIGN.md 5.4).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use base64::Engine;
use reco_core::calibration::MatchCalibration;
use reco_core::detect::director::ViewportPosition;
use reco_core::detect::panner::{PanContext, Panner};
use reco_core::detect::tracker::WorldState;
use serde::Deserialize;

use crate::calib::BLEND_WIDTH;
use crate::jobs::{Context, JobError, Progress, check_free_space};
use crate::media::{OverlayPlan, RunError, Tools, add_overlays, concat, concat_list, probe};
use crate::process::{input_path, skips};
use crate::store::{ExportStatus, Fps, Quality, Step, working_files};

/// A keep-range in synced frames, end exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub start_frame: u64,
    pub end_frame: u64,
}

/// Most text boxes in one export (DESIGN.md 5.4).
pub const MAX_OVERLAYS: usize = 50;
/// Largest picture of one text box (they are mostly see-through, so small).
pub const MAX_OVERLAY_PNG: usize = 4 * 1024 * 1024;

/// One text box of `POST /exports`: a PNG the size of the video, drawn by
/// the editor, and when it shows.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayBody {
    pub png_base64: String,
    /// `[start, end]` seconds of the finished video. `null` is what a
    /// browser sends for a number JSON cannot hold (NaN, infinity).
    pub ranges: Vec<Vec<Option<f64>>>,
}

/// Largest "Straighten picture" tilt, in degrees either way (DESIGN.md 5.5).
pub const MAX_RIG_TILT_DEG: f64 = 35.0;
/// Largest "Straighten picture" level (roll), in degrees either way (Reco's
/// IMU path keeps up to 25).
pub const MAX_RIG_ROLL_DEG: f64 = 25.0;

/// The JSON body of `POST /exports`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportBody {
    pub segments: Vec<Segment>,
    pub width: u32,
    pub height: u32,
    pub quality: Quality,
    pub path_base64: String,
    #[serde(default)]
    pub overlays: Vec<OverlayBody>,
    /// "Straighten picture": Reco's `rig_tilt` in degrees for this export,
    /// instead of match.json's. Missing: match.json's (older editors);
    /// `null` (what a browser sends for NaN) is refused.
    #[serde(default, deserialize_with = "present")]
    pub rig_tilt_deg: Option<Option<f64>>,
    /// Like `rig_tilt_deg`, for Reco's `rig_roll`.
    #[serde(default, deserialize_with = "present")]
    pub rig_roll_deg: Option<Option<f64>>,
}

/// Tells a field that is there but `null` (`Some(None)`) from a missing one
/// (`None`, through `#[serde(default)]`).
fn present<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(de).map(Some)
}

/// A checked text box.
#[derive(Debug)]
pub struct Overlay {
    pub png: Vec<u8>,
    /// [start, end) seconds of the finished video, sorted, not overlapping.
    pub ranges: Vec<(f64, f64)>,
}

/// A checked export request.
#[derive(Debug)]
pub struct ExportRequest {
    pub segments: Vec<Segment>,
    pub width: u32,
    pub height: u32,
    pub quality: Quality,
    pub path: Arc<Vec<[f32; 3]>>,
    /// Text boxes to burn in, in drawing order; empty for none.
    pub overlays: Vec<Overlay>,
    /// Rig tilt and roll in radians for every part, replacing match.json's;
    /// `None` keeps match.json's.
    pub rig_tilt: Option<f64>,
    pub rig_roll: Option<f64>,
}

impl ExportRequest {
    /// The calibration to render with: match.json's, with this export's
    /// "Straighten picture" rig tilt/roll. Reco's StitchJob hands them to the
    /// renderer's view and to the session that turns the path's world poses
    /// into render poses (`world_to_render_pose`). The file is not changed.
    pub fn calibration_for(&self, from_file: &MatchCalibration) -> MatchCalibration {
        let mut cal = from_file.clone();
        if let Some(t) = self.rig_tilt {
            cal.rig_tilt = t;
        }
        if let Some(r) = self.rig_roll {
            cal.rig_roll = r;
        }
        cal
    }
}

/// Check one "Straighten picture" angle (degrees) and return it in radians.
fn rig_angle(value: Option<Option<f64>>, what: &str, max: f64) -> Result<Option<f64>, String> {
    match value {
        None => Ok(None),
        Some(Some(v)) if v.is_finite() && v.abs() <= max => Ok(Some(v.to_radians())),
        Some(Some(v)) if v.is_finite() => Err(format!(
            "Straighten picture: the {what} must be between -{max} and {max} degrees (it was \
             {v:.1}). Please set it again."
        )),
        _ => Err(format!(
            "Straighten picture: the {what} is not a number. Please set it again."
        )),
    }
}

/// Width and height from a PNG's header, or None when it is not a PNG.
pub fn png_size(png: &[u8]) -> Option<(u32, u32)> {
    const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    if png.len() < 24 || &png[..8] != SIGNATURE || &png[12..16] != b"IHDR" {
        return None;
    }
    let be = |i: usize| u32::from_be_bytes([png[i], png[i + 1], png[i + 2], png[i + 3]]);
    Some((be(16), be(20)))
}

/// Check the text boxes of an export of `width` x `height`. Boxes that show
/// at no time (they were only in cut parts) are dropped.
fn validate_overlays(
    bodies: Vec<OverlayBody>,
    width: u32,
    height: u32,
) -> Result<Vec<Overlay>, String> {
    if bodies.len() > MAX_OVERLAYS {
        return Err(format!(
            "A video can have at most {MAX_OVERLAYS} texts. Please delete some."
        ));
    }
    let mut out = Vec::new();
    for (i, body) in bodies.into_iter().enumerate() {
        let n = i + 1;
        let unreadable = || format!("Text {n} could not be read. Please try again.");
        let png = base64::engine::general_purpose::STANDARD
            .decode(body.png_base64.trim())
            .map_err(|_| unreadable())?;
        if png.len() > MAX_OVERLAY_PNG {
            return Err(format!("Text {n} is too big. Please try again."));
        }
        match png_size(&png) {
            None => return Err(unreadable()),
            Some(size) if size != (width, height) => {
                return Err(format!(
                    "Text {n} was made for a different video size. Please press Make video \
                     again."
                ));
            }
            Some(_) => {}
        }
        let bad_times =
            || format!("The times of text {n} are not valid. Please check it on the timeline.");
        let mut ranges = Vec::new();
        let mut prev_end = 0.0;
        for r in &body.ranges {
            let [Some(a), Some(b)] = r[..] else {
                return Err(bad_times());
            };
            // Finite, not negative, in order and not overlapping.
            if !a.is_finite() || !b.is_finite() || a < prev_end || b <= a {
                return Err(bad_times());
            }
            prev_end = b;
            ranges.push((a, b));
        }
        if !ranges.is_empty() {
            out.push(Overlay { png, ranges });
        }
    }
    Ok(out)
}

/// Check an export body against the project. Errors are plain words.
pub fn validate(body: ExportBody, frame_count: u64) -> Result<ExportRequest, String> {
    let (w, h) = (body.width, body.height);
    let aspect = w as f64 / h.max(1) as f64;
    if !(320..=3840).contains(&w) || w % 2 != 0 || h % 2 != 0 || (aspect - 16.0 / 9.0).abs() > 0.01
    {
        return Err(format!("The video size {w}x{h} is not supported."));
    }
    if body.segments.is_empty() {
        return Err("Nothing to export: keep at least one part of the match.".into());
    }
    let mut prev_end = 0;
    for s in &body.segments {
        if s.start_frame >= s.end_frame || s.end_frame > frame_count || s.start_frame < prev_end {
            return Err("The parts to keep are not valid. Please check the timeline.".into());
        }
        prev_end = s.end_frame;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(body.path_base64.trim())
        .map_err(|_| "The camera path could not be read.".to_string())?;
    let path = crate::ai::decode_path(&bytes)
        .filter(|p| p.len() as u64 == frame_count)
        .ok_or_else(|| "The camera path does not match this match's length.".to_string())?;
    if path.iter().flatten().any(|v| !v.is_finite()) {
        return Err("The camera path contains invalid numbers.".into());
    }
    let overlays = validate_overlays(body.overlays, w, h)?;
    let rig_tilt = rig_angle(body.rig_tilt_deg, "tilt", MAX_RIG_TILT_DEG)?;
    let rig_roll = rig_angle(body.rig_roll_deg, "level", MAX_RIG_ROLL_DEG)?;
    Ok(ExportRequest {
        segments: body.segments,
        width: w,
        height: h,
        quality: body.quality,
        path: Arc::new(path),
        overlays,
        rig_tilt,
        rig_roll,
    })
}

/// Pose for synced frame `f`; beyond the end the last pose holds.
pub fn pose_at(path: &[[f32; 3]], f: u64) -> [f32; 3] {
    path[(f as usize).min(path.len() - 1)]
}

/// Replays the editor's path: frame `k` of a segment that starts at synced
/// frame `start` gets `path[start + k]`.
///
/// Frame alignment, verified by the `export_frame_alignment` test (frame
/// numbers encoded in the picture, short and long trims, a sync offset and a
/// pose switch at a known frame): with `force_cpu_decode` and no lookahead
/// Reco runs its immediate loop, where `PanContext::frame_index` is the
/// output frame counter starting at 0 on the first frame after `start_time`,
/// and that frame shows synced frame `start` from both cameras. No offset is
/// needed. Reco's Windows D3D11 zero-copy immediate path skips its first
/// frame (`session/frame_processing.rs`, not testable here) and would be one
/// frame off, which is one reason the export forces CPU decode.
pub struct PathPanner {
    pub path: Arc<Vec<[f32; 3]>>,
    pub start: u64,
}

impl Panner for PathPanner {
    fn decide(&mut self, _world: &WorldState, ctx: &PanContext<'_>) -> ViewportPosition {
        let [yaw, pitch, fov] = pose_at(&self.path, self.start + ctx.frame_index);
        ViewportPosition {
            yaw,
            pitch,
            fov_degrees: Some(fov),
        }
    }
}

fn reco_quality(q: Quality) -> reco_io::output::Quality {
    match q {
        Quality::Fast => reco_io::output::Quality::Fast,
        Quality::Balanced => reco_io::output::Quality::Balanced,
        Quality::High => reco_io::output::Quality::High,
    }
}

/// One camera's video for the export.
#[derive(Debug, Clone)]
pub struct Footage {
    /// One file, or the parts of a recording in order.
    pub files: Vec<PathBuf>,
    /// The number of frames in each part (not needed for one file).
    pub frames: Vec<u64>,
}

/// What one export part reads: which files of each camera's video, and
/// where in them it starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reads {
    /// The files of the left and right video, in order.
    pub left: std::ops::Range<usize>,
    pub right: std::ops::Range<usize>,
    /// Reco's start, in frames from the start of those files.
    pub start: u64,
    /// Reco's sync offset for those files.
    pub sync_offset: i64,
}

/// Where to read synced frames `seg` from. One file per camera: the whole
/// files, from `seg.start_frame` with the match's sync offset, as always.
/// A recording in parts (GoPro chapters): from the part that holds the
/// first frame, counting frames from the start of that part. Reco finds a
/// start by its time, and the parts don't add up exactly in time (each
/// part's sound runs a little longer than its picture), so a time from the
/// start of the recording would land a frame or two off in later parts.
pub fn reads(left_frames: &[u64], right_frames: &[u64], sync_offset: i64, seg: Segment) -> Reads {
    let (left_skip, right_skip) = skips(sync_offset);
    let last = seg.end_frame.max(seg.start_frame + 1) - 1;
    let (l0, l_at) = locate(left_frames, seg.start_frame + left_skip);
    let (l1, _) = locate(left_frames, last + left_skip);
    let (r0, r_at) = locate(right_frames, seg.start_frame + right_skip);
    let (r1, _) = locate(right_frames, last + right_skip);
    Reads {
        left: l0..l1 + 1,
        right: r0..r1 + 1,
        start: l_at.min(r_at),
        sync_offset: r_at as i64 - l_at as i64,
    }
}

/// The part holding frame `n` of a video whose parts have `frames` frames
/// each, and the frame's number within that part. One file (no counts):
/// that file.
fn locate(frames: &[u64], n: u64) -> (usize, u64) {
    let mut first = 0;
    for (i, &count) in frames.iter().enumerate() {
        if n < first + count || i + 1 == frames.len() {
            return (i, n - first);
        }
        first += count;
    }
    (0, n)
}

/// Inputs for rendering the parts.
pub struct RenderPlan<'a> {
    pub left: &'a Footage,
    pub right: &'a Footage,
    pub calibration: &'a MatchCalibration,
    pub fps: Fps,
    pub request: &'a ExportRequest,
    pub out_dir: &'a Path,
}

/// Render every segment to `part-NNN.mkv` in `out_dir`. `on_frames` gets the
/// number of frames done over all segments.
pub fn render_parts(
    plan: &RenderPlan,
    cancel: &AtomicBool,
    on_frames: &(dyn Fn(u64) + Sync),
) -> Result<Vec<String>, JobError> {
    let mut parts = Vec::new();
    let mut done_before = 0;
    for (i, seg) in plan.request.segments.iter().enumerate() {
        let name = format!("part-{i:03}.mkv");
        let out = plan.out_dir.join(&name);
        let counter = Arc::new(AtomicU64::new(0));
        let c = counter.clone();
        let path = plan.request.path.clone();
        let start = seg.start_frame;
        let expected = seg.end_frame - seg.start_frame;
        let at = reads(
            &plan.left.frames,
            &plan.right.frames,
            plan.calibration.sync_offset,
            *seg,
        );
        if plan.left.files.len() > 1 || plan.right.files.len() > 1 {
            tracing::info!(
                "Part {}: left files {}-{}, right files {}-{}, from frame {} (sync offset {})",
                i + 1,
                at.left.start + 1,
                at.left.end,
                at.right.start + 1,
                at.right.end,
                at.start,
                at.sync_offset
            );
        }
        let job = reco_io::StitchJob::with_calibration(
            input_path(&plan.left.files[at.left.clone()]),
            input_path(&plan.right.files[at.right.clone()]),
            plan.calibration.clone(),
            &out,
        )
        .codec(reco_io::output::Codec::H264)
        .quality(reco_quality(plan.request.quality))
        .format(reco_io::output::Format::Mkv)
        .resolution(plan.request.width, plan.request.height)
        .blend_width(BLEND_WIDTH)
        .force_cpu_decode()
        .sync_offset(at.sync_offset)
        .start_time(plan.fps.frame_to_secs(at.start))
        .end_time(plan.fps.frame_to_secs(at.start + expected))
        .on_progress(move |p| c.store(p.frames_completed, Ordering::Relaxed))
        .on_session(move |session, _source| {
            session.set_panner(Box::new(PathPanner { path, start }));
        });
        let result = run_reporting(|| job.run(cancel), &counter, |n| on_frames(done_before + n));
        if cancel.load(Ordering::SeqCst) {
            return Err(JobError::Cancelled);
        }
        let r = result.map_err(|e| JobError::failed("Making the video failed.", e))?;
        tracing::info!(
            "Part {}: frames {}..{} -> {} frames ({}, {})",
            i + 1,
            seg.start_frame,
            seg.end_frame,
            r.frames_processed,
            r.decode_mode,
            r.encoder_name
        );
        if r.frames_processed != expected {
            tracing::warn!(
                "Part {} has {} frames, expected {expected}",
                i + 1,
                r.frames_processed
            );
        }
        // Reco stops at a damaged spot as if the video ended there.
        if crate::process::stopped_early(r.frames_processed, expected, plan.fps) {
            return Err(JobError::failed(
                format!(
                    "The videos could not be read past {} of the match. One of the files may \
                     be damaged.",
                    plan.fps.clock(seg.start_frame + r.frames_processed)
                ),
                format!(
                    "part {} has {} of {expected} frames",
                    i + 1,
                    r.frames_processed
                ),
            ));
        }
        done_before += expected;
        parts.push(name);
    }
    Ok(parts)
}

/// Run `f` while a helper thread reports `counter` every quarter second.
pub fn run_reporting<R>(
    f: impl FnOnce() -> R,
    counter: &AtomicU64,
    report: impl Fn(u64) + Sync,
) -> R {
    let finished = AtomicBool::new(false);
    std::thread::scope(|s| {
        s.spawn(|| {
            while !finished.load(Ordering::SeqCst) {
                report(counter.load(Ordering::Relaxed));
                std::thread::sleep(Duration::from_millis(250));
            }
        });
        let r = f();
        finished.store(true, Ordering::SeqCst);
        r
    })
}

/// Join the parts into `output` (a faststart MP4).
pub fn join_parts(
    tools: &Tools,
    out_dir: &Path,
    parts: &[String],
    output: &Path,
    cancel: &AtomicBool,
) -> Result<(), JobError> {
    let list = out_dir.join("parts.txt");
    std::fs::write(&list, concat_list(parts))
        .map_err(|e| JobError::failed("We couldn't write the video file.", e))?;
    match concat(tools, &list, output, cancel) {
        Ok(()) => {}
        Err(RunError::Cancelled) => return Err(JobError::Cancelled),
        Err(RunError::Failed(e)) => {
            return Err(JobError::failed(
                "We couldn't put the video parts together.",
                e,
            ));
        }
    }
    let _ = std::fs::remove_file(&list);
    for p in parts {
        let _ = std::fs::remove_file(out_dir.join(p));
    }
    Ok(())
}

/// Burn the text boxes into `joined`, writing `output`; the pictures and
/// `joined` are removed afterwards. Reports `total` frames of progress.
fn add_text(
    tools: &Tools,
    out_dir: &Path,
    joined: &Path,
    output: &Path,
    req: &ExportRequest,
    fps: Fps,
    cancel: &AtomicBool,
    on_frames: impl FnMut(u64),
) -> Result<(), JobError> {
    let mut pngs = Vec::new();
    for (i, o) in req.overlays.iter().enumerate() {
        let path = out_dir.join(format!("text-{i:03}.png"));
        std::fs::write(&path, &o.png)
            .map_err(|e| JobError::failed("We couldn't write the video file.", e))?;
        pngs.push(path);
    }
    let plan = OverlayPlan {
        input: joined.to_path_buf(),
        pngs: pngs.clone(),
        ranges: req.overlays.iter().map(|o| o.ranges.clone()).collect(),
        fps,
        quality: req.quality,
        output: output.to_path_buf(),
    };
    tracing::info!("Adding {} text(s)", pngs.len());
    match add_overlays(tools, &plan, cancel, on_frames) {
        Ok(()) => {}
        Err(RunError::Cancelled) => return Err(JobError::Cancelled),
        Err(RunError::Failed(e)) => {
            return Err(JobError::failed(
                "We couldn't add your text to the video.",
                e,
            ));
        }
    }
    for p in pngs.iter().map(PathBuf::as_path).chain([joined]) {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

/// A safe file name: `<project name> <date>.mp4`.
pub fn file_name(project_name: &str, when: chrono::DateTime<chrono::Local>) -> String {
    let clean: String = project_name
        .chars()
        .map(|c| {
            if c.is_control() || "\\/:*?\"<>|".contains(c) {
                ' '
            } else {
                c
            }
        })
        .collect();
    let mut clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    clean = clean.trim_matches('.').trim().chars().take(80).collect();
    if clean.is_empty() {
        clean = "Match".into();
    }
    format!("{clean} {}.mp4", when.format("%Y-%m-%d %H.%M"))
}

/// Rough size of the finished video in bytes (it varies with the picture).
fn size_estimate(req: &ExportRequest, secs: f64) -> u64 {
    let mbps_1080p = match req.quality {
        Quality::Fast => 6.0,
        Quality::Balanced => 10.0,
        Quality::High => 16.0,
    };
    let pixels = (req.width * req.height) as f64 / (1920.0 * 1080.0);
    (mbps_1080p * pixels * 1e6 / 8.0 * secs) as u64
}

pub fn run(
    ctx: &Context,
    id: &str,
    export_id: &str,
    req: &ExportRequest,
    cancel: &AtomicBool,
) -> Result<(), JobError> {
    let store = &ctx.store;
    let dir = store.project_dir(id);
    let Some((meta, _)) = store.update(id, |m| {
        if let Some(ex) = m.exports.iter_mut().find(|e| e.id == export_id) {
            ex.status = ExportStatus::Running;
            ex.progress = 0.0;
        }
    }) else {
        return Err(JobError::Cancelled);
    };
    // Rendering, joining and, with text boxes, adding the text. That
    // re-encodes the whole video, so it gets the last 40 % of the progress.
    let with_text = !req.overlays.is_empty();
    let mut progress = Progress::new(store, id, Some(export_id), if with_text { 3 } else { 2 });
    if with_text {
        progress.span(0.0, 0.6);
    }
    progress.step(Step::Export, 0, "Making your video");

    let not_ready = |d: &str| {
        JobError::failed(
            "This match is not ready to export. Process it first.",
            d.to_string(),
        )
    };
    let fps = meta.fps.ok_or_else(|| not_ready("no fps"))?;
    // The videos processing used: the matching copies, if there are any.
    let footage = |side: &str| -> Result<Footage, JobError> {
        let files = working_files(&dir, side);
        if files.is_empty() {
            return Err(not_ready(&format!("{side} file missing")));
        }
        // A recording in parts: how many frames each part has.
        let frames = if files.len() > 1 {
            files
                .iter()
                .map(|f| probe(&ctx.tools, f).map(|p| p.frame_count))
                .collect::<Result<Vec<u64>, String>>()
                .map_err(|e| {
                    JobError::failed(
                        format!(
                            "We couldn't read the {side} video. {}",
                            crate::process::DAMAGED
                        ),
                        e,
                    )
                })?
        } else {
            Vec::new()
        };
        Ok(Footage { files, frames })
    };
    let (left, right) = (footage("left")?, footage("right")?);
    let from_file = MatchCalibration::from_file(&dir.join("match.json"))
        .map_err(|e| not_ready(&e.to_string()))?;
    let calibration = req.calibration_for(&from_file);
    tracing::info!(
        "Straighten picture: rig tilt {:.2} deg, roll {:.2} deg{}",
        calibration.rig_tilt.to_degrees(),
        calibration.rig_roll.to_degrees(),
        if req.rig_tilt.is_none() && req.rig_roll.is_none() {
            " (from match.json)"
        } else {
            ""
        }
    );
    let out_dir = dir.join("exports").join(export_id);
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| JobError::failed("We couldn't create the export folder.", e))?;

    let total: u64 = req
        .segments
        .iter()
        .map(|s| s.end_frame - s.start_frame)
        .sum();
    // The parts and the joined video exist together for a moment.
    let need = size_estimate(req, fps.frame_to_secs(total)) * 2;
    if let Err(e) = check_free_space(&out_dir, need) {
        let _ = std::fs::remove_dir_all(&out_dir);
        return Err(e);
    }
    let plan = RenderPlan {
        left: &left,
        right: &right,
        calibration: &calibration,
        fps,
        request: req,
        out_dir: &out_dir,
    };
    let rendered = render_parts(&plan, cancel, &|n| progress.frames(n, total));
    let parts = match rendered {
        Ok(p) => p,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&out_dir);
            return Err(e);
        }
    };

    progress.step(Step::Finalize, 1, "Finishing the video file");
    let tmp = out_dir.join("export.tmp.mp4");
    let joined = if with_text {
        out_dir.join("joined.tmp.mp4")
    } else {
        tmp.clone()
    };
    if let Err(e) = join_parts(&ctx.tools, &out_dir, &parts, &joined, cancel) {
        let _ = std::fs::remove_dir_all(&out_dir);
        return Err(e);
    }
    if with_text {
        progress.step(Step::Overlay, 2, "Adding text");
        progress.span(0.6, 1.0);
        let on_frames = |n| progress.frames(n, total);
        let added = add_text(
            &ctx.tools, &out_dir, &joined, &tmp, req, fps, cancel, on_frames,
        );
        if let Err(e) = added {
            let _ = std::fs::remove_dir_all(&out_dir);
            return Err(e);
        }
    }
    let name = file_name(&meta.name, chrono::Local::now());
    let final_path: PathBuf = out_dir.join(&name);
    std::fs::rename(&tmp, &final_path)
        .map_err(|e| JobError::failed("We couldn't save the finished video.", e))?;
    let size = std::fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0);
    tracing::info!("Saved {}", final_path.display());
    store.update(id, |m| {
        if let Some(ex) = m.exports.iter_mut().find(|e| e.id == export_id) {
            ex.file_name = Some(name.clone());
            ex.size_bytes = Some(size);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;

    fn body(segments: Vec<(u64, u64)>, w: u32, h: u32, path: &[[f32; 3]]) -> ExportBody {
        ExportBody {
            segments: segments
                .into_iter()
                .map(|(s, e)| Segment {
                    start_frame: s,
                    end_frame: e,
                })
                .collect(),
            width: w,
            height: h,
            quality: Quality::Balanced,
            path_base64: STANDARD.encode(crate::ai::encode_path(path)),
            overlays: Vec::new(),
            rig_tilt_deg: None,
            rig_roll_deg: None,
        }
    }

    /// The start of a PNG of `w` x `h` (all the checks look at).
    fn png_header(w: u32, h: u32) -> Vec<u8> {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        png.extend(w.to_be_bytes());
        png.extend(h.to_be_bytes());
        png.extend([8, 6, 0, 0, 0]);
        png
    }

    fn text(png: &[u8], ranges: &[[Option<f64>; 2]]) -> OverlayBody {
        OverlayBody {
            png_base64: STANDARD.encode(png),
            ranges: ranges.iter().map(|r| r.to_vec()).collect(),
        }
    }

    #[test]
    fn reads_png_sizes() {
        assert_eq!(png_size(&png_header(1920, 1080)), Some((1920, 1080)));
        assert_eq!(png_size(&png_header(3840, 2160)), Some((3840, 2160)));
        assert_eq!(png_size(&png_header(1920, 1080)[..20]), None);
        let mut not_png = png_header(1920, 1080);
        not_png[1] = b'X';
        assert_eq!(png_size(&not_png), None);
        let mut no_header = png_header(1920, 1080);
        no_header[12..16].copy_from_slice(b"IDAT");
        assert_eq!(png_size(&no_header), None);
    }

    #[test]
    fn validates_text_boxes() {
        let path = vec![[0.0, 0.0, 30.0]; 100];
        let with = |overlays: Vec<OverlayBody>| {
            let mut b = body(vec![(0, 100)], 1920, 1080, &path);
            b.overlays = overlays;
            validate(b, 100)
        };
        let png = png_header(1920, 1080);
        let (a, b) = (Some(0.0), Some(1.5));
        let ok = with(vec![
            text(&png, &[[a, b], [Some(2.0), Some(3.0)]]),
            text(&png, &[[Some(1.5), Some(3.3)]]),
        ])
        .unwrap();
        assert_eq!(ok.overlays.len(), 2);
        assert_eq!(ok.overlays[0].ranges, vec![(0.0, 1.5), (2.0, 3.0)]);
        assert_eq!(ok.overlays[0].png, png);
        assert!(with(vec![]).unwrap().overlays.is_empty());
        // Shown at no time (only in cut parts): nothing to add.
        assert!(with(vec![text(&png, &[])]).unwrap().overlays.is_empty());

        // The picture must be a PNG the size of the video.
        let err = with(vec![text(&png_header(1280, 720), &[[a, b]])]).unwrap_err();
        assert!(err.contains("different video size"), "{err}");
        let err = with(vec![text(&png[..16], &[[a, b]])]).unwrap_err();
        assert!(err.contains("Text 1 could not be read"), "{err}");
        let mut bad = text(&png, &[[a, b]]);
        bad.png_base64 = "!!!".into();
        assert!(with(vec![bad]).is_err());
        let mut big = png.clone();
        big.resize(MAX_OVERLAY_PNG + 1, 0);
        assert!(
            with(vec![text(&big, &[[a, b]])])
                .unwrap_err()
                .contains("too big")
        );
        let mut max = png.clone();
        max.resize(MAX_OVERLAY_PNG, 0);
        assert!(with(vec![text(&max, &[[a, b]])]).is_ok());

        // Times: numbers, not negative, sorted, not overlapping.
        let nan = Some(f64::NAN);
        for ranges in [
            vec![[None, b]],
            vec![[a, None]],
            vec![[nan, b]],
            vec![[a, Some(f64::INFINITY)]],
            vec![[Some(-0.5), b]],
            vec![[Some(2.0), Some(1.0)]],
            vec![[Some(1.0), Some(1.0)]],
            vec![[Some(2.0), Some(3.0)], [a, b]],
            vec![[a, Some(2.0)], [b, Some(3.0)]],
        ] {
            let err = with(vec![text(&png, &[[a, b]]), text(&png, &ranges)]).unwrap_err();
            assert!(err.contains("times of text 2"), "{ranges:?}: {err}");
        }
        let mut short = text(&png, &[]);
        short.ranges = vec![vec![Some(1.0)]];
        assert!(with(vec![short]).is_err());

        // At most 50.
        assert!(with((0..50).map(|_| text(&png, &[[a, b]])).collect()).is_ok());
        let err = with((0..51).map(|_| text(&png, &[[a, b]])).collect()).unwrap_err();
        assert!(err.contains("at most 50"), "{err}");
    }

    #[test]
    fn text_boxes_in_the_json_body() {
        let path = STANDARD.encode(crate::ai::encode_path(&[[0.0, 0.0, 30.0]; 10]));
        let json = |overlays: &str| {
            format!(
                r#"{{"segments":[{{"startFrame":0,"endFrame":10}}],"width":1920,"height":1080,
                "quality":"fast","pathBase64":"{path}"{overlays}}}"#
            )
        };
        // Without overlays (older editors) nothing changes.
        let body: ExportBody = serde_json::from_str(&json("")).unwrap();
        assert!(validate(body, 10).unwrap().overlays.is_empty());
        // A browser turns NaN into null: refused in plain words, not as broken JSON.
        let png = STANDARD.encode(png_header(1920, 1080));
        let body: ExportBody = serde_json::from_str(&json(&format!(
            r#","overlays":[{{"pngBase64":"{png}","ranges":[[null,1]]}}]"#
        )))
        .unwrap();
        assert!(validate(body, 10).unwrap_err().contains("not valid"));
        let body: ExportBody = serde_json::from_str(&json(&format!(
            r#","overlays":[{{"pngBase64":"{png}","ranges":[[0,0.3333333333333333]]}}]"#
        )))
        .unwrap();
        assert_eq!(
            validate(body, 10).unwrap().overlays[0].ranges,
            vec![(0.0, 1.0 / 3.0)]
        );
    }

    #[test]
    fn validates_requests() {
        let path = vec![[0.0, 0.0, 30.0]; 100];
        let ok = validate(body(vec![(0, 10), (20, 100)], 1920, 1080, &path), 100).unwrap();
        assert_eq!(ok.segments.len(), 2);
        assert_eq!(ok.path.len(), 100);
        assert!(validate(body(vec![(0, 10)], 3840, 2160, &path), 100).is_ok());
        assert!(validate(body(vec![(0, 10)], 640, 360, &path), 100).is_ok());
        assert!(validate(body(vec![(0, 10)], 1920, 1440, &path), 100).is_err());
        assert!(validate(body(vec![(0, 10)], 7680, 4320, &path), 100).is_err());
        assert!(validate(body(vec![], 1920, 1080, &path), 100).is_err());
        assert!(validate(body(vec![(10, 10)], 1920, 1080, &path), 100).is_err());
        assert!(validate(body(vec![(0, 101)], 1920, 1080, &path), 100).is_err());
        assert!(validate(body(vec![(20, 30), (0, 10)], 1920, 1080, &path), 100).is_err());
        assert!(validate(body(vec![(0, 20), (10, 30)], 1920, 1080, &path), 100).is_err());
        assert!(validate(body(vec![(0, 10)], 1920, 1080, &path[..99]), 100).is_err());
        let mut bad = path.clone();
        bad[5][0] = f32::NAN;
        assert!(validate(body(vec![(0, 10)], 1920, 1080, &bad), 100).is_err());
        let mut b = body(vec![(0, 10)], 1920, 1080, &path);
        b.path_base64 = "!!!".into();
        assert!(validate(b, 100).is_err());
    }

    #[test]
    fn straighten_picture_settings() {
        let path = STANDARD.encode(crate::ai::encode_path(&[[0.0, 0.0, 30.0]; 10]));
        let json = |extra: &str| {
            format!(
                r#"{{"segments":[{{"startFrame":0,"endFrame":10}}],"width":1920,"height":1080,
                "quality":"fast","pathBase64":"{path}"{extra}}}"#
            )
        };
        let check = |extra: &str| {
            let body: ExportBody = serde_json::from_str(&json(extra)).unwrap();
            validate(body, 10)
        };
        // Older editors send none: match.json's values are kept.
        let req = check("").unwrap();
        assert_eq!((req.rig_tilt, req.rig_roll), (None, None));
        let req = check(r#","rigTiltDeg":14.5,"rigRollDeg":-3"#).unwrap();
        assert!((req.rig_tilt.unwrap() - 14.5_f64.to_radians()).abs() < 1e-12);
        assert!((req.rig_roll.unwrap() + 3_f64.to_radians()).abs() < 1e-12);
        let req = check(r#","rigTiltDeg":0,"rigRollDeg":0"#).unwrap();
        assert_eq!((req.rig_tilt, req.rig_roll), (Some(0.0), Some(0.0)));
        // Only one given: the other stays match.json's.
        let req = check(r#","rigRollDeg":20"#).unwrap();
        assert_eq!(req.rig_tilt, None);
        assert!(check(r#","rigTiltDeg":35,"rigRollDeg":-25"#).is_ok());

        let err = check(r#","rigTiltDeg":35.5"#).unwrap_err();
        assert!(
            err.contains("tilt must be between -35 and 35 degrees"),
            "{err}"
        );
        let err = check(r#","rigRollDeg":-25.5"#).unwrap_err();
        assert!(
            err.contains("level must be between -25 and 25 degrees"),
            "{err}"
        );
        let err = check(r#","rigTiltDeg":null"#).unwrap_err();
        assert!(err.contains("tilt is not a number"), "{err}");
        let err = check(r#","rigRollDeg":null"#).unwrap_err();
        assert!(err.contains("level is not a number"), "{err}");
        // Not a number at all: the body does not parse (a 400 from read_json).
        assert!(serde_json::from_str::<ExportBody>(&json(r#","rigTiltDeg":"5""#)).is_err());
    }

    #[test]
    fn straighten_picture_reaches_the_calibration() {
        let cal: MatchCalibration = serde_json::from_str(crate::calib::tests::SYNTH_MATCH).unwrap();
        assert_eq!((cal.rig_tilt, cal.rig_roll), (0.0, 0.0));
        let path = vec![[0.0, 0.0, 30.0]; 10];
        let mut b = body(vec![(0, 10)], 1920, 1080, &path);
        b.rig_tilt_deg = Some(Some(-14.0));
        b.rig_roll_deg = Some(Some(2.5));
        let req = validate(b, 10).unwrap();
        let used = req.calibration_for(&cal);
        assert!((used.rig_tilt + 14_f64.to_radians()).abs() < 1e-12);
        assert!((used.rig_roll - 2.5_f64.to_radians()).abs() < 1e-12);
        // everything else as in match.json
        let mut back = used.clone();
        back.rig_tilt = 0.0;
        back.rig_roll = 0.0;
        assert_eq!(
            serde_json::to_value(&back).unwrap(),
            serde_json::to_value(&cal).unwrap()
        );
        // Without the settings match.json's own values stay (an IMU camera's).
        let mut imu = cal.clone();
        imu.rig_tilt = 0.2;
        imu.rig_roll = -0.1;
        let plain = validate(body(vec![(0, 10)], 1920, 1080, &path), 10).unwrap();
        let used = plain.calibration_for(&imu);
        assert_eq!((used.rig_tilt, used.rig_roll), (0.2, -0.1));
    }

    /// Where each export part starts reading (DESIGN.md 4.3).
    #[test]
    fn reads_start_in_the_right_part() {
        let seg = |start_frame, end_frame| Segment {
            start_frame,
            end_frame,
        };
        // One file per camera: from the start frame with the match's sync
        // offset, as always.
        for (offset, start) in [(12, 40), (-7, 300), (0, 0)] {
            assert_eq!(
                reads(&[], &[], offset, seg(start, start + 100)),
                Reads {
                    left: 0..1,
                    right: 0..1,
                    start,
                    sync_offset: offset,
                }
            );
        }
        // Parts: left 400 + 400 + 400 frames, right 380 + 420 + 400, the
        // right camera started 12 frames earlier (synced frame f = left
        // frame f = right frame f + 12).
        let (l, r) = ([400, 400, 400], [380, 420, 400]);
        // In the first parts: like one file.
        assert_eq!(
            reads(&l, &r, 12, seg(40, 120)),
            Reads {
                left: 0..1,
                right: 0..1,
                start: 40,
                sync_offset: 12,
            }
        );
        // Across the joins (left frame 400, right frame 380).
        assert_eq!(
            reads(&l, &r, 12, seg(360, 450)),
            Reads {
                left: 0..2,
                right: 0..2,
                start: 360,
                sync_offset: 12,
            }
        );
        // Starting in the second right part but the first left one.
        assert_eq!(
            reads(&l, &r, 12, seg(375, 390)),
            Reads {
                left: 0..1,
                right: 1..2,
                start: 7,
                sync_offset: -368,
            }
        );
        // Later parts: counted from the part the first frame is in.
        assert_eq!(
            reads(&l, &r, 12, seg(750, 830)),
            Reads {
                left: 1..3,
                right: 1..3,
                start: 350,
                sync_offset: 32,
            }
        );
        assert_eq!(
            reads(&l, &r, -5, seg(1100, 1195)),
            Reads {
                left: 2..3,
                right: 2..3,
                start: 300,
                sync_offset: -5,
            }
        );
        // Past the end: the last part (Reco then stops early, which the
        // export notices).
        assert_eq!(locate(&l, 1300), (2, 500));
        assert_eq!(locate(&l, 399), (0, 399));
        assert_eq!(locate(&l, 400), (1, 0));
    }

    #[test]
    fn panner_maps_segment_frames_to_path() {
        let path: Vec<[f32; 3]> = (0..10).map(|i| [i as f32, 0.0, 30.0]).collect();
        let mut panner = PathPanner {
            path: Arc::new(path),
            start: 4,
        };
        let cal: MatchCalibration = serde_json::from_str(crate::calib::tests::SYNTH_MATCH).unwrap();
        let world = WorldState::default();
        let mut decide = |frame_index| {
            let ctx = PanContext {
                frame_index,
                timestamp_ms: 0.0,
                previous_position: ViewportPosition {
                    yaw: 0.0,
                    pitch: 0.0,
                    fov_degrees: None,
                },
                calibration: &cal,
            };
            panner.decide(&world, &ctx)
        };
        assert_eq!(decide(0).yaw, 4.0);
        assert_eq!(decide(3).yaw, 7.0);
        assert_eq!(decide(5).yaw, 9.0);
        assert_eq!(decide(50).yaw, 9.0);
        assert_eq!(decide(0).fov_degrees, Some(30.0));
    }

    #[test]
    fn file_names_are_safe() {
        use chrono::TimeZone;
        let when = chrono::Local
            .with_ymd_and_hms(2026, 10, 21, 14, 5, 0)
            .unwrap();
        assert_eq!(
            file_name("Saturday: Reds v Blues?", when),
            "Saturday Reds v Blues 2026-10-21 14.05.mp4"
        );
        assert_eq!(file_name("../..", when), "Match 2026-10-21 14.05.mp4");
        assert_eq!(
            file_name("Ünïcode ⚽", when),
            "Ünïcode ⚽ 2026-10-21 14.05.mp4"
        );
    }

    fn one_file(path: &Path) -> Footage {
        Footage {
            files: vec![path.to_path_buf()],
            frames: Vec::new(),
        }
    }

    /// Run a command and return stdout, panicking with stderr on failure.
    fn sh(program: &str, args: &[&str]) -> Vec<u8> {
        let out = std::process::Command::new(program)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{program} {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        out.stdout
    }

    /// Footage whose brightness encodes the frame number: frame n has luma
    /// 30 + 13 * (n % 16). Like phone videos, the timestamps are not exactly
    /// on the n / 30 s grid: every odd frame starts a 1/600 s tick early.
    fn coded_clip(path: &Path, frames: u32) {
        let video = format!(
            "color=c=black:s=64x36:r=30:d={},format=yuv420p,\
             geq=lum='30+13*mod(N,16)':cb=128:cr=128,scale=1280:720:flags=neighbor,\
             settb=1/600,setpts='N*20-mod(N,2)'",
            frames as f64 / 30.0
        );
        let audio = format!("sine=f=440:sample_rate=48000:d={}", frames as f64 / 30.0);
        sh(
            "ffmpeg",
            &[
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                &video,
                "-f",
                "lavfi",
                "-i",
                &audio,
                "-fps_mode",
                "passthrough",
                "-enc_time_base",
                "1/600",
                "-video_track_timescale",
                "600",
                "-c:v",
                "libx264",
                "-g",
                "30",
                "-bf",
                "2",
                "-crf",
                "12",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-shortest",
                path.to_str().unwrap(),
            ],
        );
    }

    /// Mean luma of a 32x32 patch at (x, y) for every frame, as frame codes.
    /// Reads the raw Y plane (no range conversion), every frame once (the
    /// joined export has small gaps in its frame times where its parts'
    /// sound ran on, which a constant-rate read would fill).
    fn codes(video: &Path, x: u32, y: u32) -> Vec<i32> {
        let filter = format!("crop=32:32:{x}:{y},scale=2:2:flags=area");
        sh(
            "ffmpeg",
            &[
                "-v",
                "error",
                "-i",
                video.to_str().unwrap(),
                "-fps_mode",
                "passthrough",
                "-vf",
                &filter,
                "-f",
                "rawvideo",
                "-pix_fmt",
                "yuv420p",
                "-",
            ],
        )
        .chunks_exact(6)
        .map(|f| {
            let luma = f[..4].iter().map(|&v| v as f32).sum::<f32>() / 4.0;
            ((luma - 30.0) / 13.0).round() as i32
        })
        .collect()
    }

    /// End-to-end check that exported frame k shows synced frame
    /// `start + k` with the pose `path[start + k]`, across trims (short and
    /// long seeks, one to a frame that starts early) and the sync offset;
    /// also checks the preview proxy.
    /// Needs ffmpeg on PATH and a working GPU (llvmpipe is fine):
    /// `cargo test -p veoclone-helper -- --ignored export_frame_alignment`
    #[test]
    #[ignore]
    fn export_frame_alignment() {
        let tmp = tempfile::tempdir().unwrap();
        let (left, right) = (tmp.path().join("left.mp4"), tmp.path().join("right.mp4"));
        coded_clip(&left, 450);
        coded_clip(&right, 450);
        let mut cal: MatchCalibration =
            serde_json::from_str(crate::calib::tests::SYNTH_MATCH).unwrap();
        cal.sync_offset = 12; // right phone started 12 frames earlier
        let fps = Fps { num: 30, den: 1 };
        let frame_count = crate::process::synced_frame_count(450, 450, 12);
        assert_eq!(frame_count, 438);
        // Positive yaw pans left: look into the left camera before frame
        // 200 and into the right camera from frame 200 on.
        let switch = 200;
        let path: Vec<[f32; 3]> = (0..frame_count)
            .map(|f| [if f < switch { 1.2 } else { -1.2 }, 0.0, 20.0])
            .collect();
        let expected = |f: u64| -> i32 {
            if f < switch {
                (f % 16) as i32
            } else {
                ((f + 12) % 16) as i32
            }
        };
        let segments = [(40, 120), (180, 220), (341, 430)];
        let request = ExportRequest {
            segments: segments
                .iter()
                .map(|&(s, e)| Segment {
                    start_frame: s,
                    end_frame: e,
                })
                .collect(),
            width: 640,
            height: 360,
            quality: Quality::Fast,
            path: Arc::new(path),
            overlays: Vec::new(),
            rig_tilt: None,
            rig_roll: None,
        };
        let out_dir = tmp.path().join("export");
        std::fs::create_dir_all(&out_dir).unwrap();
        let plan = RenderPlan {
            left: &one_file(&left),
            right: &one_file(&right),
            calibration: &cal,
            fps,
            request: &request,
            out_dir: &out_dir,
        };
        let cancel = AtomicBool::new(false);
        let parts = render_parts(&plan, &cancel, &|_| {}).unwrap_or_else(|e| panic!("{e:?}"));
        let tools = Tools::find();
        let output = out_dir.join("out.mp4");
        join_parts(&tools, &out_dir, &parts, &output, &cancel).unwrap_or_else(|e| panic!("{e:?}"));

        let got = codes(&output, 304, 164);
        let want: Vec<i32> = segments
            .iter()
            .flat_map(|&(s, e)| (s..e).map(expected))
            .collect();
        assert_eq!(got.len(), want.len(), "frame count");
        let wrong: Vec<_> = (0..got.len()).filter(|&k| got[k] != want[k]).collect();
        assert!(
            wrong.is_empty(),
            "{} wrong frames, first at output frame {:?}: got {:?} want {:?}",
            wrong.len(),
            wrong.first(),
            &got[wrong[0]..(wrong[0] + 5).min(got.len())],
            &want[wrong[0]..(wrong[0] + 5).min(want.len())]
        );
        let dur: f64 = String::from_utf8(sh(
            "ffprobe",
            &[
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
                output.to_str().unwrap(),
            ],
        ))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
        assert!((dur - 209.0 / 30.0).abs() < 0.1, "duration {dur}");
        let streams = String::from_utf8(sh(
            "ffprobe",
            &[
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type",
                "-of",
                "csv=p=0",
                output.to_str().unwrap(),
            ],
        ))
        .unwrap();
        assert!(streams.contains("audio"), "{streams}");

        // The preview proxy: left tile on top shows synced frame f from the
        // left camera, the bottom tile the same moment from the right one.
        let proxy = tmp.path().join("proxy.mp4");
        let plan = crate::media::ProxyPlan {
            left: vec![left.clone()],
            right: vec![right.clone()],
            output: proxy.clone(),
            fps,
            left_skip: 0,
            right_skip: 12,
            frame_count,
            tile_width: 1280,
            tile_height: 720,
            audio: true,
        };
        crate::media::make_proxy(&tools, &plan, &cancel, |_| {}).unwrap();
        let top = codes(&proxy, 624, 344);
        let bottom = codes(&proxy, 624, 720 + 344);
        assert_eq!(top.len() as u64, frame_count);
        for f in 0..frame_count {
            assert_eq!(top[f as usize], (f % 16) as i32, "proxy left, frame {f}");
            assert_eq!(
                bottom[f as usize],
                ((f + 12) % 16) as i32,
                "proxy right, frame {f}"
            );
        }
    }

    /// Like `export_frame_alignment`, for GoPro-style recordings in parts
    /// (each part with its own sound, the joins at different moments in
    /// the two cameras): parts inside one file, across the joins, and
    /// starting in a later part, short and long seeks. Also the preview.
    /// `cargo test -p veoclone-helper -- --ignored export_frame_alignment_in_parts`
    #[test]
    #[ignore]
    fn export_frame_alignment_in_parts() {
        use crate::media::tests::coded_parts;
        let tmp = tempfile::tempdir().unwrap();
        let tools = Tools::find();
        let footage = |name: &str, frames: &[u64]| {
            let files = coded_parts(tmp.path(), name, frames, 30);
            let counted: Vec<u64> = files
                .iter()
                .map(|f| crate::media::probe(&tools, f).unwrap().frame_count)
                .collect();
            assert_eq!(counted, frames);
            Footage {
                files,
                frames: counted,
            }
        };
        let left = footage("GX0", &[400, 400, 400]);
        let right = footage("GH0", &[380, 420, 400]);
        let mut cal: MatchCalibration =
            serde_json::from_str(crate::calib::tests::SYNTH_MATCH).unwrap();
        cal.sync_offset = 12;
        let fps = Fps { num: 30, den: 1 };
        let frame_count = crate::process::synced_frame_count(1200, 1200, 12);
        let switch = 780;
        let path: Vec<[f32; 3]> = (0..frame_count)
            .map(|f| [if f < switch { 1.2 } else { -1.2 }, 0.0, 20.0])
            .collect();
        let expected = |f: u64| -> i32 {
            if f < switch {
                (f % 16) as i32
            } else {
                ((f + 12) % 16) as i32
            }
        };
        let segments = [(40, 120), (360, 450), (375, 390), (750, 830), (1130, 1185)];
        let request = ExportRequest {
            segments: segments
                .iter()
                .map(|&(s, e)| Segment {
                    start_frame: s,
                    end_frame: e,
                })
                .collect(),
            width: 640,
            height: 360,
            quality: Quality::Fast,
            path: Arc::new(path),
            overlays: Vec::new(),
            rig_tilt: None,
            rig_roll: None,
        };
        let out_dir = tmp.path().join("export");
        std::fs::create_dir_all(&out_dir).unwrap();
        let plan = RenderPlan {
            left: &left,
            right: &right,
            calibration: &cal,
            fps,
            request: &request,
            out_dir: &out_dir,
        };
        let cancel = AtomicBool::new(false);
        let parts = render_parts(&plan, &cancel, &|_| {}).unwrap_or_else(|e| panic!("{e:?}"));
        let output = out_dir.join("out.mp4");
        join_parts(&tools, &out_dir, &parts, &output, &cancel).unwrap_or_else(|e| panic!("{e:?}"));

        let got = codes(&output, 304, 164);
        let want: Vec<i32> = segments
            .iter()
            .flat_map(|&(s, e)| (s..e).map(expected))
            .collect();
        assert_eq!(got.len(), want.len(), "frame count");
        let wrong: Vec<_> = (0..got.len()).filter(|&k| got[k] != want[k]).collect();
        assert!(
            wrong.is_empty(),
            "{} wrong frames, first at output frame {:?}: got {:?} want {:?}",
            wrong.len(),
            wrong.first(),
            &got[wrong[0]..(wrong[0] + 5).min(got.len())],
            &want[wrong[0]..(wrong[0] + 5).min(want.len())]
        );
        // The sound runs on through the joins.
        let duration = |stream: &str| -> f64 {
            String::from_utf8(sh(
                "ffprobe",
                &[
                    "-v",
                    "error",
                    "-select_streams",
                    stream,
                    "-show_entries",
                    "stream=duration",
                    "-of",
                    "csv=p=0",
                    output.to_str().unwrap(),
                ],
            ))
            .unwrap()
            .trim()
            .parse()
            .unwrap()
        };
        let secs = want.len() as f64 / 30.0;
        assert!(
            (duration("v:0") - secs).abs() < 0.05,
            "video {}",
            duration("v:0")
        );
        assert!(
            (duration("a:0") - secs).abs() < 0.15,
            "sound {}",
            duration("a:0")
        );

        // The preview from the parts: every synced frame from both cameras.
        let proxy = tmp.path().join("proxy.mp4");
        let plan = crate::media::ProxyPlan {
            left: left.files.clone(),
            right: right.files.clone(),
            output: proxy.clone(),
            fps,
            left_skip: 0,
            right_skip: 12,
            frame_count,
            tile_width: 1280,
            tile_height: 720,
            audio: true,
        };
        crate::media::make_proxy(&tools, &plan, &cancel, |_| {}).unwrap();
        let top = codes(&proxy, 624, 344);
        let bottom = codes(&proxy, 624, 720 + 344);
        assert_eq!(top.len() as u64, frame_count);
        for f in 0..frame_count {
            assert_eq!(top[f as usize], (f % 16) as i32, "proxy left, frame {f}");
            assert_eq!(
                bottom[f as usize],
                ((f + 12) % 16) as i32,
                "proxy right, frame {f}"
            );
        }
    }
}
