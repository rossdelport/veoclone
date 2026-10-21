//! The processing pipeline behind `POST /process`: check the files, line up
//! and calibrate the cameras, make the preview video, run AI tracking.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use reco_calibrate::types::{CalibrationProgress, CalibrationStep, ProfileSource};
use reco_calibrate::video::{CalibrateVideosError, CalibrateVideosOptions, calibrate_videos};
use reco_core::calibration::MatchCalibration;

use crate::ai::{PoseSink, encode_path, fill_path};
use crate::calib::{BLEND_WIDTH, calib_info, lens_params};
use crate::jobs::{Context, JobError, Progress};
use crate::media::{ProxyPlan, RunError, check_pair, make_proxy, probe, tile_size};
use crate::store::{
    CalibSummary, Fps, ProbeInfo, Status, Step, Style, original_file, write_atomic,
};

const STEPS: u32 = 4;
const GENERIC_LENS: &str = "Generic lens (automatic)";

/// Frames to drop from each camera so both start together. Positive
/// `sync_offset` = the right phone started first (Reco's convention).
pub fn skips(sync_offset: i64) -> (u64, u64) {
    ((-sync_offset).max(0) as u64, sync_offset.max(0) as u64)
}

/// Frames both cameras have after the sync skip.
pub fn synced_frame_count(left_frames: u64, right_frames: u64, sync_offset: i64) -> u64 {
    let (ls, rs) = skips(sync_offset);
    left_frames
        .saturating_sub(ls)
        .min(right_frames.saturating_sub(rs))
}

fn cancelled(cancel: &AtomicBool) -> Result<(), JobError> {
    if cancel.load(Ordering::SeqCst) {
        Err(JobError::Cancelled)
    } else {
        Ok(())
    }
}

pub fn run(ctx: &Context, id: &str, cancel: &AtomicBool) -> Result<(), JobError> {
    let store = &ctx.store;
    let dir = store.project_dir(id);
    let Some((meta, _)) = store.update(id, |m| {
        m.status = Status::Processing;
        m.error = None;
        m.warnings.clear();
    }) else {
        return Err(JobError::Cancelled);
    };
    let mut progress = Progress::new(store, id, None, STEPS);
    let mut warnings: Vec<String> = Vec::new();

    // 1. Check the files.
    progress.step(Step::Probe, 0, "Checking the video files");
    let left = original_file(&dir, "left");
    let right = original_file(&dir, "right");
    let (Some(left), Some(right)) = (left, right) else {
        return Err(JobError::failed(
            "Both videos are needed. Add the left and the right phone's video.",
            "missing upload",
        ));
    };
    if ctx.tools.ffmpeg.is_none() || ctx.tools.ffprobe.is_none() {
        return Err(JobError::failed(
            "VeoClone's video tools (ffmpeg) are missing. Please download VeoClone again.",
            "ffmpeg/ffprobe not found next to the helper or on PATH",
        ));
    }
    let lp = probe(&ctx.tools, &left).map_err(|e| probe_error("left", e))?;
    progress.fraction(0.3, None);
    let rp = probe(&ctx.tools, &right).map_err(|e| probe_error("right", e))?;
    store.update(id, |m| {
        if let Some(f) = m.files.left.as_mut() {
            f.probe = Some(lp.clone());
        }
        if let Some(f) = m.files.right.as_mut() {
            f.probe = Some(rp.clone());
        }
    });
    warnings.extend(check_pair(&lp, &rp).map_err(|msg| JobError::failed(msg, "file check"))?);
    // Reco's own frame-rate choice is what the stitcher will use.
    let fps = reco_io::adapters::FfmpegFileSource::frame_rate(&left)
        .ok()
        .filter(|(n, d)| *n > 0 && *d > 0)
        .map(|(n, d)| Fps {
            num: n as u32,
            den: d as u32,
        })
        .unwrap_or(lp.fps);
    progress.fraction(0.6, Some("Getting the AI ready"));
    let provider = crate::ai::check(ctx.model.as_deref())
        .map_err(|(msg, detail)| JobError::failed(msg, detail))?;
    tracing::info!("AI runs on: {provider}");
    set_warnings(ctx, id, &warnings);
    cancelled(cancel)?;

    // 2. Line up & calibrate (reused when the uploads and lens are unchanged).
    progress.step(Step::Calibrate, 1, "Lining up and calibrating the cameras");
    let match_path = dir.join("match.json");
    let summary = match (&meta.calibration, MatchCalibration::from_file(&match_path)) {
        (Some(summary), Ok(_)) => {
            tracing::info!("Using the earlier calibration");
            summary.clone()
        }
        _ => {
            // A new calibration may line the videos up differently.
            let _ = std::fs::remove_file(dir.join("proxy.mp4"));
            calibrate(
                &left,
                &right,
                &lp,
                &meta.lens_id,
                fps,
                &match_path,
                &progress,
                cancel,
            )?
        }
    };
    if summary.confidence < 0.5 {
        warnings.push(
            "The two views did not line up very well. Check that both phones filmed the same \
             pitch with some overlap in the middle."
                .into(),
        );
    }
    if summary.lens == GENERIC_LENS {
        warnings.push(
            "We didn't know which iPhone filmed this, so a general lens setting was used and \
             the picture may be slightly bent near the edges. Choose your iPhone model and \
             press Try again for a better result."
                .into(),
        );
    }
    let frame_count =
        synced_frame_count(lp.frame_count, rp.frame_count, summary.sync_offset_frames);
    if frame_count < 2 {
        return Err(JobError::failed(
            "The two videos hardly overlap in time. Start both phones at about the same time.",
            format!("synced frame count {frame_count}"),
        ));
    }
    store.update(id, |m| {
        m.calibration = Some(summary.clone());
        m.fps = Some(fps);
        m.frame_count = Some(frame_count);
    });
    set_warnings(ctx, id, &warnings);
    cancelled(cancel)?;

    // 3. Preview proxy (reused when it already exists).
    progress.step(Step::Proxy, 2, "Making the preview video");
    let (left_skip, right_skip) = skips(summary.sync_offset_frames);
    let tile = tile_size(lp.width, lp.height);
    let proxy = dir.join("proxy.mp4");
    if proxy.is_file() {
        tracing::info!("Using the earlier preview video");
    } else {
        let tmp = dir.join("proxy.tmp.mp4");
        let plan = ProxyPlan {
            left: left.clone(),
            right: right.clone(),
            output: tmp.clone(),
            fps,
            left_skip,
            right_skip,
            frame_count,
            tile_width: tile.0,
            tile_height: tile.1,
            audio: lp.has_audio,
        };
        match make_proxy(&ctx.tools, &plan, cancel, |n| {
            progress.frames(n, frame_count)
        }) {
            Ok(()) => std::fs::rename(&tmp, &proxy)
                .map_err(|e| JobError::failed("We couldn't save the preview video.", e))?,
            Err(RunError::Cancelled) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(JobError::Cancelled);
            }
            Err(RunError::Failed(e)) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(JobError::failed("We couldn't make the preview video.", e));
            }
        }
    }
    cancelled(cancel)?;

    // 4. AI tracking.
    progress.step(Step::Track, 3, "AI ball tracking");
    let style = meta.style;
    let path = track(
        ctx,
        &dir,
        &left,
        &right,
        &match_path,
        style,
        frame_count,
        &progress,
        cancel,
    )?;
    // Reco's own pairing decides the true length; trust it over the probe.
    let frame_count = path.len() as u64;
    write_atomic(&dir.join("ai_path.bin"), &encode_path(&path))
        .map_err(|e| JobError::failed("We couldn't save the AI camera path.", e))?;

    let match_json: serde_json::Value = serde_json::from_slice(
        &std::fs::read(&match_path)
            .map_err(|e| JobError::failed("Calibration file missing.", e))?,
    )
    .map_err(|e| JobError::failed("Calibration file damaged.", e))?;
    let info = calib_info(&match_json, fps, frame_count, tile, id)
        .map_err(|e| JobError::failed("Calibration file damaged.", e))?;
    write_atomic(
        &dir.join("calib.json"),
        &serde_json::to_vec(&info).expect("json"),
    )
    .map_err(|e| JobError::failed("We couldn't save the calibration.", e))?;
    store.update(id, |m| m.frame_count = Some(frame_count));
    Ok(())
}

fn probe_error(side: &str, detail: String) -> JobError {
    let message = if detail == crate::media::NO_VIDEO {
        format!("The {side} file has no video in it.")
    } else {
        format!("We couldn't read the {side} video. Is it a video from the phone?")
    };
    JobError::failed(message, detail)
}

fn set_warnings(ctx: &Context, id: &str, warnings: &[String]) {
    ctx.store.update(id, |m| m.warnings = warnings.to_vec());
}

fn calibration_message(step: CalibrationStep) -> (f64, &'static str) {
    match step {
        CalibrationStep::Probing | CalibrationStep::DetectingProfiles => {
            (0.05, "Reading the videos")
        }
        CalibrationStep::AudioSync => (0.1, "Lining up the two videos using their sound"),
        CalibrationStep::ExtractingFrames => (0.3, "Taking sample pictures from both videos"),
        CalibrationStep::Undistorting | CalibrationStep::FeatureMatching => {
            (0.5, "Matching the two camera views")
        }
        CalibrationStep::Optimizing => (0.8, "Working out where the cameras point"),
    }
}

#[allow(clippy::too_many_arguments)]
fn calibrate(
    left: &Path,
    right: &Path,
    probe: &ProbeInfo,
    lens_id: &Option<String>,
    fps: Fps,
    match_path: &Path,
    progress: &Progress,
    cancel: &AtomicBool,
) -> Result<CalibSummary, JobError> {
    let mut config = reco_calibrate::CalibrationConfig {
        num_frames: 4,
        skip_start_secs: (probe.duration * 0.1).min(10.0),
        ..Default::default()
    };
    config.akaze.threshold = 0.0001;
    config.akaze.detect_y_min = 0.05;
    config.akaze.detect_y_max = 0.95;

    let mut options = CalibrateVideosOptions {
        config: Some(config),
        ..Default::default()
    };
    let mut lens_name = None;
    if let Some(id) = lens_id {
        match lens_params(id, probe.width, probe.height) {
            Some((params, name)) => {
                tracing::info!("Lens profile: {name}");
                options.left_params = Some(params.clone());
                options.right_params = Some(params);
                lens_name = Some(name);
            }
            None => tracing::warn!("Lens profile {id} not found; using automatic detection"),
        }
    }

    let result = calibrate_videos(
        left,
        right,
        options,
        &mut |p: &CalibrationProgress| {
            let (f, msg) = calibration_message(p.step);
            tracing::info!("Calibration: {} ({})", p.step, p.detail);
            progress.fraction(f, Some(msg));
        },
        cancel,
    );
    let result = match result {
        Ok(r) => r,
        Err(CalibrateVideosError::Cancelled) => return Err(JobError::Cancelled),
        Err(e) => {
            return Err(JobError::failed(
                "We couldn't line up the two videos. Make sure both phones film the same \
                 pitch with some overlap in the middle, and try again.",
                e,
            ));
        }
    };
    cancelled(cancel)?;
    let cal = &result.calibration;
    tracing::info!(
        "Calibration done: confidence {:.2}, sync offset {} frames, {} matches",
        result.confidence,
        cal.sync_offset,
        result.total_matches
    );
    write_atomic(match_path, cal.to_json_pretty().as_bytes())
        .map_err(|e| JobError::failed("We couldn't save the calibration.", e))?;
    let lens = lens_name.unwrap_or_else(|| match &result.left_lens_profile {
        Some(p) if !matches!(p.source, ProfileSource::Fallback) => {
            format!("{} {}", p.camera, p.lens).trim().to_string()
        }
        _ => GENERIC_LENS.into(),
    });
    Ok(CalibSummary {
        confidence: result.confidence,
        sync_offset_frames: cal.sync_offset,
        sync_offset_seconds: cal.sync_offset as f64 / fps.as_f64(),
        lens,
    })
}

/// Run Reco's AI camera (exactly like reco-gui's export) and keep only the
/// per-frame camera poses.
#[allow(clippy::too_many_arguments)]
fn track(
    ctx: &Context,
    dir: &Path,
    left: &Path,
    right: &Path,
    match_path: &Path,
    style: Style,
    frame_count: u64,
    progress: &Progress,
    cancel: &AtomicBool,
) -> Result<Vec<[f32; 3]>, JobError> {
    let cal = MatchCalibration::from_file(match_path)
        .map_err(|e| JobError::failed("The calibration could not be read.", e))?;
    let model = ctx
        .model
        .clone()
        .ok_or_else(|| JobError::failed("The AI model is missing.", "no model"))?;
    let scratch: PathBuf = dir.join("ai_pass.tmp.mkv");
    let poses = Arc::new(Mutex::new(Vec::new()));
    let setup_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let stop = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicU64::new(0));

    let sink = PoseSink {
        poses: poses.clone(),
        max_frames: frame_count as usize * 2 + 10_000,
    };
    let preset = style.preset();
    let field_roi = cal.field_roi.clone();
    let hook_error = setup_error.clone();
    let hook_stop = stop.clone();
    let d = done.clone();
    let job = reco_io::StitchJob::with_calibration(
        PathBuf::from(left),
        PathBuf::from(right),
        cal,
        scratch.clone(),
    )
    .codec(reco_io::output::Codec::H264)
    .quality(reco_io::output::Quality::Fast)
    .format(reco_io::output::Format::Mkv)
    .audio(reco_io::output::AudioMode::Disabled)
    .resolution(640, 360)
    .blend_width(BLEND_WIDTH)
    .lookahead(1.5)
    .on_progress(move |p| d.store(p.frames_completed, Ordering::Relaxed))
    .on_session(move |session, source| {
        let info = source.info();
        let is_10bit =
            source.gpu_pixel_format() == reco_core::render::renderer::GpuPixelFormat::P010;
        let mut config = reco_autocam::AutocamConfig::new(&model)
            .with_tracking_mode(reco_autocam::TrackingMode::Field)
            .with_detection_interval(3)
            .with_10bit(is_10bit);
        config.field_panner_config =
            reco_autocam::panners::FieldPannerConfig::from_preset_name(preset);
        if let Some(roi) = field_roi {
            config = config.with_field_roi(roi);
        }
        let error = match reco_autocam::setup_autocam(
            session,
            &config,
            info.fps as f32,
            source.is_gpu_resident(),
        ) {
            Ok(true) => None,
            Ok(false) => Some("no detector backend available".to_string()),
            Err(e) => Some(e.to_string()),
        };
        if let Some(e) = error {
            *hook_error.lock().unwrap_or_else(|p| p.into_inner()) = Some(e);
            hook_stop.store(true, Ordering::SeqCst);
        }
        session.set_event_sink(Box::new(sink));
    });

    // Forward the user's cancel into the job's stop flag.
    let watcher_stop = stop.clone();
    let finished = Arc::new(AtomicBool::new(false));
    let result = std::thread::scope(|s| {
        let fin = finished.clone();
        s.spawn(move || {
            while !fin.load(Ordering::SeqCst) {
                if cancel.load(Ordering::SeqCst) {
                    watcher_stop.store(true, Ordering::SeqCst);
                }
                progress.frames(done.load(Ordering::Relaxed), frame_count);
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
        });
        let r = job.run(&stop);
        finished.store(true, Ordering::SeqCst);
        r
    });
    let _ = std::fs::remove_file(&scratch);

    if let Some(e) = setup_error.lock().unwrap_or_else(|p| p.into_inner()).take() {
        return Err(JobError::failed(
            "The AI ball tracking could not start. Please download VeoClone again.",
            e,
        ));
    }
    cancelled(cancel)?;
    let r =
        result.map_err(|e| JobError::failed("The AI ball tracking stopped with an error.", e))?;
    tracing::info!(
        "AI pass: {} frames in {:.0} s ({}, encoder {})",
        r.frames_processed,
        r.elapsed.as_secs_f64(),
        r.decode_mode,
        r.encoder_name
    );
    let poses = poses.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let decided = poses.iter().filter(|p| p.is_some()).count();
    if decided == 0 {
        return Err(JobError::failed(
            "The AI ball tracking produced no camera path.",
            "no pan decisions",
        ));
    }
    let frames = (r.frames_processed as usize).max(poses.len());
    let proxy_frames = crate::media::count_frames(&ctx.tools, &dir.join("proxy.mp4"));
    if frames as u64 != frame_count || proxy_frames != Some(frames as u64) {
        tracing::warn!(
            "AI pass saw {frames} frames, the files suggested {frame_count}, the preview has \
             {proxy_frames:?}"
        );
    }
    Ok(fill_path(&poses, frames))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_skips_follow_reco() {
        assert_eq!(skips(12), (0, 12));
        assert_eq!(skips(-5), (5, 0));
        assert_eq!(skips(0), (0, 0));
        assert_eq!(synced_frame_count(600, 600, 12), 588);
        assert_eq!(synced_frame_count(600, 600, -12), 588);
        assert_eq!(synced_frame_count(500, 600, 12), 500);
        assert_eq!(synced_frame_count(10, 5, 12), 0);
    }
}
