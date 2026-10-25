//! The processing pipeline behind `POST /process`: check the files (and make
//! matching copies when the phones filmed in different formats), line up
//! and calibrate the cameras, make the preview video, run AI tracking.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use reco_calibrate::types::{CalibrationProgress, CalibrationStep};
use reco_calibrate::video::{CalibrateVideosError, CalibrateVideosOptions, calibrate_videos};
use reco_core::calibration::MatchCalibration;
use serde::{Deserialize, Serialize};

use crate::ai::{PoseSink, encode_path, fill_path};
use crate::brain::{self, BallStats, BrainConfig};
use crate::calib::{BLEND_WIDTH, LensChoice, calib_info, choose_lens};
use crate::jobs::{Context, JobError, Progress, check_free_space};
use crate::media::{
    Conversion, MatchJob, MatchPlan, ProxyPlan, RunError, WASHED_OUT, check_pair, has_filter,
    join_probes, make_matching_copy, make_proxy, matching_warning, plan_matching, probe, tile_size,
};
use crate::seen::{
    BALL_CONFIDENCE, Classes, RECORD_CONFIDENCE, RepanSettings, RepanStats, SeenMeta, SeenWriter,
    WidestView,
};
use crate::store::{
    AiRun, CalibSummary, DERIVED_FILES, Fps, ProbeInfo, ProjectMeta, Status, Step, matched_file,
    matched_record, new_id, remove_matched, uploaded_files, working_files, write_atomic,
};

const STEPS: u32 = 4;
const SIDES: [&str; 2] = ["left", "right"];

/// When the two views cannot be lined up, the most common cause is that
/// the left and right videos were added the wrong way round.
const NOT_LINED_UP: &str = "We couldn't line up the two videos. Maybe the left and right videos \
                            are the wrong way round: click “Swap left and right and try \
                            again”. Otherwise make sure both phones film the same pitch with \
                            some overlap in the middle, and try again.";

const NO_FFMPEG: &str =
    "VeoClone's video tools (ffmpeg) are missing. Please download VeoClone again.";

pub const DAMAGED: &str = "One of the files may be damaged: copy the videos from the phones again, \
                       add them to this match and press Start.";

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

    // 1. Check the files, and make matching copies when the phones filmed
    // in different formats (DESIGN.md 4.2).
    progress.step(Step::Probe, 0, "Checking the video files");
    let left = uploaded_files(&meta, &dir, "left");
    let right = uploaded_files(&meta, &dir, "right");
    let (Some(left), Some(right)) = (left, right) else {
        return Err(JobError::failed(
            "Both videos are needed. Add the left and the right phone's video.",
            "missing upload",
        ));
    };
    if ctx.tools.ffmpeg.is_none() || ctx.tools.ffprobe.is_none() {
        return Err(JobError::failed(
            NO_FFMPEG,
            "ffmpeg/ffprobe not found next to the helper or on PATH",
        ));
    }
    // A recording in parts (GoPro chapters) is checked part by part and
    // then counts as one video: its frames and length add up.
    let left_parts = probe_parts(ctx, &meta, "left", &left)?;
    progress.fraction(0.3, None);
    let right_parts = probe_parts(ctx, &meta, "right", &right)?;
    let lp = join_probes("left", &left_parts).map_err(|msg| JobError::failed(msg, "parts"))?;
    let rp = join_probes("right", &right_parts).map_err(|msg| JobError::failed(msg, "parts"))?;
    for (side, files) in [("left", &left), ("right", &right)] {
        if files.len() > 1 {
            tracing::info!(
                "The {side} video is {} files, joined in this order:",
                files.len()
            );
            for f in files {
                tracing::info!("  {}", f.display());
            }
        }
    }
    store.update(id, |m| {
        if let Some(f) = m.files.left.as_mut() {
            f.probe = Some(lp.clone());
        }
        if let Some(f) = m.files.right.as_mut() {
            f.probe = Some(rp.clone());
        }
    });
    let plan = plan_matching(&lp, &rp).map_err(|msg| JobError::failed(msg, "file check"))?;
    // Before the long work, so a broken AI setup shows straight away.
    progress.fraction(0.6, Some("Getting the AI ready"));
    let provider = crate::ai::check(ctx.model.as_deref())
        .map_err(|(msg, detail)| JobError::failed(msg, detail))?;
    tracing::info!("AI runs on: {provider}");
    cancelled(cancel)?;
    let [left_copy, right_copy] = match_videos(
        ctx,
        &dir,
        &plan,
        [(left.as_slice(), &lp), (right.as_slice(), &rp)],
        &mut progress,
        cancel,
    )?;
    // Calibration reads only each video's first file (a GoPro's first part
    // also carries its motion-sensor data, used to line up and level the
    // cameras); where it starts taking pictures depends on the left one's
    // length.
    let first_secs = left_copy
        .as_ref()
        .map_or(left_parts[0].duration, |c| c.probe.duration);
    let copies = [&left_copy, &right_copy];
    warnings.extend(matching_warning(
        &lp,
        &rp,
        copies.map(|c| c.as_ref().map(|c| c.tone_mapped)),
    ));
    if copies
        .iter()
        .any(|c| c.as_ref().is_some_and(|c| c.hdr_kept))
    {
        warnings.push(WASHED_OUT.into());
    }
    // From here on every step reads the working files.
    let lp = left_copy.map_or(lp, |c| c.probe);
    let rp = right_copy.map_or(rp, |c| c.probe);
    let (left, right) = (working_files(&dir, "left"), working_files(&dir, "right"));
    if left.is_empty() || right.is_empty() {
        return Err(JobError::failed(
            "Both videos are needed. Add the left and the right phone's video.",
            "upload disappeared",
        ));
    }
    for w in check_pair(&lp, &rp).map_err(|msg| JobError::failed(msg, "file check"))? {
        if !warnings.contains(&w) {
            warnings.push(w);
        }
    }
    // Reco's own frame-rate choice is what the stitcher will use.
    let fps = reco_io::adapters::FfmpegFileSource::frame_rate(&left[0])
        .ok()
        .filter(|(n, d)| *n > 0 && *d > 0)
        .map(|(n, d)| Fps {
            num: n as u32,
            den: d as u32,
        })
        .unwrap_or(lp.fps);
    set_warnings(ctx, id, &warnings);
    cancelled(cancel)?;

    // 2. Line up & calibrate (reused when the uploads and lens are unchanged).
    progress.step(Step::Calibrate, 1, "Lining up and calibrating the cameras");
    let match_path = dir.join("match.json");
    // One lens per phone, each scaled to its own video.
    let left_lens = choose_lens(meta.lens_id.as_deref(), &left[0], lp.width, lp.height);
    let right_lens = choose_lens(
        meta.right_lens_id.as_deref().or(meta.lens_id.as_deref()),
        &right[0],
        rp.width,
        rp.height,
    );
    let summary = match (&meta.calibration, MatchCalibration::from_file(&match_path)) {
        (Some(summary), Ok(_)) => {
            tracing::info!("Using the earlier calibration");
            summary.clone()
        }
        _ => {
            // A new calibration may line the videos up differently, so
            // nothing made with the old one may be opened again.
            for f in ["proxy.mp4", "calib.json", "ai_path.bin"] {
                let _ = std::fs::remove_file(dir.join(f));
            }
            crate::seen::remove(&dir);
            for (side, lens) in [("Left", &left_lens), ("Right", &right_lens)] {
                tracing::info!(
                    "{side} lens: {} (fx {:.1}, k1 {:.4})",
                    lens.name,
                    lens.params.fx,
                    lens.params.d[0]
                );
            }
            calibrate(
                &left[0],
                &right[0],
                first_secs,
                [&left_lens, &right_lens],
                fps,
                &match_path,
                &progress,
                cancel,
            )?
        }
    };
    if summary.confidence < 0.5 {
        warnings.push(
            "The two views did not line up very well. Check that the left and right videos \
             are not the wrong way round, and that both phones filmed the same pitch with \
             some overlap in the middle."
                .into(),
        );
    }
    for w in [left_lens.warning, right_lens.warning]
        .into_iter()
        .flatten()
    {
        if !warnings.contains(&w) {
            warnings.push(w);
        }
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
        // Room for the preview (a few Mbit/s) and the AI pass's scratch file.
        let secs = fps.frame_to_secs(frame_count);
        check_free_space(&dir, (secs * 5e6 / 8.0) as u64 + (1 << 30))?;
        // A new name every time: a leftover ffmpeg from a run that was cut
        // short can never write into this run's file.
        let tmp = dir.join(format!("proxy.{}.tmp.mp4", new_id()));
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

    // 4. AI tracking: quick when what the AI saw last time can be used.
    let settings = repan_settings(&meta);
    tracing::info!("Widest view: {}", settings.widest.describe());
    let (path, ball) = match usable_recording(ctx, &dir, &meta, summary.sync_offset_frames) {
        Some(seen) => {
            progress.step(Step::Track, 3, "Using what the AI saw last time");
            repan_recorded(&dir, &match_path, &meta, &seen, &progress, true)?
        }
        None => {
            progress.step(Step::Track, 3, "AI ball tracking");
            if meta.safe_mode() {
                warnings.push(
                    "VeoClone stopped while working on this match before, so it now uses a \
                     slower but safer way. This takes longer."
                        .into(),
                );
                set_warnings(ctx, id, &warnings);
            }
            let (live, kept) = track(
                ctx,
                &dir,
                &left,
                &right,
                &match_path,
                &meta,
                fps,
                frame_count,
                &progress,
                cancel,
            )?;
            // "Follow the ball" is made from what the AI saw; the other
            // styles only take the ball numbers from it.
            match kept.then(|| crate::seen::read_meta(&dir)).flatten() {
                Some(seen) if meta.style.uses_brain() => {
                    progress.fraction(0.95, Some("Following the ball"));
                    repan_recorded(&dir, &match_path, &meta, &seen, &progress, false)?
                }
                Some(seen) => (live, recorded_ball_stats(&dir, &match_path, &meta, &seen)),
                None if meta.style.uses_brain() => {
                    warnings.push(
                        "VeoClone couldn't keep what the AI saw, so this time the camera \
                         follows the players instead of the ball. Run the AI again to try once \
                         more."
                            .into(),
                    );
                    set_warnings(ctx, id, &warnings);
                    (live, None)
                }
                None => (live, None),
            }
        }
    };
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
    let ai_run = AiRun {
        style: meta.style,
        ai_accuracy: meta.ai_accuracy,
        pitch_id: meta.pitch.as_ref().map(|p| p.id.clone()),
        widest_view: Some(settings.widest),
        ball,
    };
    store.update(id, |m| {
        m.frame_count = Some(frame_count);
        m.ai_run = Some(ai_run);
    });
    Ok(())
}

/// Probe every file of one side's video (one file, or the parts of a
/// recording in order).
fn probe_parts(
    ctx: &Context,
    meta: &ProjectMeta,
    side: &str,
    files: &[PathBuf],
) -> Result<Vec<ProbeInfo>, JobError> {
    let names: Vec<String> = meta
        .files
        .side(side)
        .map(|f| f.parts.iter().flatten().map(|p| p.name.clone()).collect())
        .unwrap_or_default();
    let mut probes = Vec::new();
    for (i, f) in files.iter().enumerate() {
        let probed = probe(&ctx.tools, f).map_err(|detail| {
            let no_video = detail == crate::media::NO_VIDEO;
            let message = match (files.len() > 1, no_video) {
                (false, true) => format!("The {side} file has no video in it."),
                (false, false) => {
                    format!("We couldn't read the {side} video. Is it a video from the phone?")
                }
                (true, _) => {
                    let name = names.get(i).map_or(String::new(), |n| format!(" ({n})"));
                    let problem = if no_video {
                        "has no video in it"
                    } else {
                        "could not be read"
                    };
                    format!(
                        "Part {} of the {side} video{name} {problem}. Copy that file from the \
                         camera again, add all the files of the {side} video again and press \
                         Start.",
                        i + 1
                    )
                }
            };
            JobError::failed(message, detail)
        })?;
        probes.push(probed);
    }
    Ok(probes)
}

fn set_warnings(ctx: &Context, id: &str, warnings: &[String]) {
    ctx.store.update(id, |m| m.warnings = warnings.to_vec());
}

/// One side's matching copy, made now or on an earlier run.
struct MatchedCopy {
    probe: ProbeInfo,
    /// Its HDR colours were changed to normal colours.
    tone_mapped: bool,
    /// HDR video copied with its colours as they are (no `zscale`).
    hdr_kept: bool,
}

/// What a matching copy was made from (`matched-<side>.json`). The copy is
/// used again only while the upload and the plan are still the same.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MatchedRecord {
    source_bytes: u64,
    /// Last change of the upload, in milliseconds since 1970.
    source_modified: u64,
    conversion: Conversion,
    tone_mapped: bool,
}

/// Size and last change of an upload (all its parts: their total size and
/// the latest change), to notice a different upload.
fn file_stamp(files: &[PathBuf]) -> Option<(u64, u64)> {
    let mut stamp = (0, 0);
    for path in files {
        let m = std::fs::metadata(path).ok()?;
        let modified = m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
        stamp = (stamp.0 + m.len(), stamp.1.max(modified.as_millis() as u64));
    }
    (!files.is_empty()).then_some(stamp)
}

/// The earlier matching copy of `side`, if it was made from this upload
/// with this plan and can still be read.
fn reusable_copy(
    ctx: &Context,
    dir: &Path,
    side: &str,
    conversion: &Conversion,
    source: &[PathBuf],
) -> Option<MatchedCopy> {
    let (bytes, modified) = file_stamp(source)?;
    let record: MatchedRecord =
        serde_json::from_slice(&std::fs::read(matched_record(dir, side)).ok()?).ok()?;
    if (record.source_bytes, record.source_modified) != (bytes, modified)
        || &record.conversion != conversion
    {
        return None;
    }
    let probe = probe(&ctx.tools, &matched_file(dir, side)).ok()?;
    if (probe.width, probe.height) != (conversion.width, conversion.height) {
        return None;
    }
    Some(MatchedCopy {
        probe,
        tone_mapped: record.tone_mapped,
        hdr_kept: conversion.tone_map && !record.tone_mapped,
    })
}

/// Make the matching copies `plan` asks for (DESIGN.md 4.2), reusing ones
/// from an earlier run, and delete copies that are no longer needed.
/// Returns the copy for each side (left, right).
fn match_videos(
    ctx: &Context,
    dir: &Path,
    plan: &MatchPlan,
    originals: [(&[PathBuf], &ProbeInfo); 2],
    progress: &mut Progress,
    cancel: &AtomicBool,
) -> Result<[Option<MatchedCopy>; 2], JobError> {
    let mut copies = [None, None];
    let mut todo = Vec::new();
    let mut removed = false;
    for (i, side) in SIDES.into_iter().enumerate() {
        let Some(conversion) = plan.side(side) else {
            removed |= remove_matched(dir, side);
            continue;
        };
        let (source, source_probe) = originals[i];
        if let Some(copy) = reusable_copy(ctx, dir, side, conversion, source) {
            tracing::info!("Using the earlier matching copy of the {side} video");
            copies[i] = Some(copy);
            continue;
        }
        removed |= remove_matched(dir, side);
        let fps = conversion.fps.unwrap_or(source_probe.fps);
        let frames = match conversion.fps {
            Some(f) => (source_probe.duration * f.as_f64()).round() as u64,
            None => source_probe.frame_count,
        };
        todo.push((i, side, conversion, fps, frames));
    }
    if removed || !todo.is_empty() {
        // Results made from other videos than the ones used from now on.
        for f in DERIVED_FILES {
            let _ = std::fs::remove_file(dir.join(f));
        }
        crate::seen::remove(dir);
    }
    if todo.is_empty() {
        return Ok(copies);
    }

    let ffmpeg = ctx
        .tools
        .ffmpeg()
        .map_err(|e| JobError::failed(NO_FFMPEG, e))?;
    let hdr = todo.iter().any(|(_, _, c, _, _)| c.tone_map);
    let tone_map = hdr && has_filter(ffmpeg, "zscale");
    if hdr && !tone_map {
        tracing::warn!("This ffmpeg has no zscale filter: HDR colours are copied as they are");
    }
    // Room for the copies: high-quality H.264 takes up to about 0.2 bits
    // per pixel, plus some to spare.
    let need: u64 = todo
        .iter()
        .map(|(_, _, c, _, frames)| {
            (c.width as f64 * c.height as f64 * *frames as f64 * 0.025) as u64
        })
        .sum();
    check_free_space(dir, need + (1 << 30))?;

    progress.step(Step::Probe, 0, "Making the two videos match…");
    let total: u64 = todo.iter().map(|t| t.4).sum();
    let mut done_before = 0;
    for (i, side, conversion, fps, frames) in todo {
        tracing::info!("Making a matching copy of the {side} video: {conversion:?}");
        // A new name every time, like the preview.
        let tmp = dir.join(format!("matched-{side}.{}.tmp.mp4", new_id()));
        // A recording in parts becomes one file.
        let job = MatchJob {
            input: originals[i].0.to_vec(),
            output: tmp.clone(),
            conversion: conversion.clone(),
            fps,
            source_fps: originals[i].1.fps,
        };
        let made = make_matching_copy(&ctx.tools, &job, tone_map, cancel, |n| {
            progress.frames(done_before + n.min(frames), total)
        });
        let saved = match made {
            Ok(()) => std::fs::rename(&tmp, matched_file(dir, side)),
            Err(RunError::Cancelled) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(JobError::Cancelled);
            }
            Err(RunError::Failed(e)) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(JobError::failed(
                    format!("We couldn't make a matching copy of the {side} video."),
                    e,
                ));
            }
        };
        saved.map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            JobError::failed(
                format!("We couldn't save the matching copy of the {side} video."),
                e,
            )
        })?;
        let copy_probe = probe(&ctx.tools, &matched_file(dir, side)).map_err(|e| {
            remove_matched(dir, side);
            JobError::failed(
                format!("We couldn't read the matching copy of the {side} video."),
                e,
            )
        })?;
        // A copy that ends early would quietly cut the match short.
        if stopped_early(copy_probe.frame_count, frames, fps) {
            remove_matched(dir, side);
            return Err(JobError::failed(
                format!(
                    "We could only read the first {} of the {side} video. {DAMAGED}",
                    fps.clock(copy_probe.frame_count)
                ),
                format!(
                    "matching copy has {} of {frames} frames",
                    copy_probe.frame_count
                ),
            ));
        }
        let (source_bytes, source_modified) = file_stamp(originals[i].0).unwrap_or_default();
        let record = MatchedRecord {
            source_bytes,
            source_modified,
            conversion: conversion.clone(),
            tone_mapped: tone_map && conversion.tone_map,
        };
        write_atomic(
            &matched_record(dir, side),
            &serde_json::to_vec_pretty(&record).expect("json"),
        )
        .map_err(|e| JobError::failed("We couldn't save the matching copy.", e))?;
        tracing::info!(
            "Matching copy of the {side} video: {}x{}, {} frames",
            copy_probe.width,
            copy_probe.height,
            copy_probe.frame_count
        );
        copies[i] = Some(MatchedCopy {
            probe: copy_probe,
            tone_mapped: record.tone_mapped,
            hdr_kept: conversion.tone_map && !record.tone_mapped,
        });
        done_before += frames;
        cancelled(cancel)?;
    }
    Ok(copies)
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

/// The lens for the calibration summary: one name, or one per phone.
fn lens_summary(left: &LensChoice, right: &LensChoice) -> String {
    if left.name == right.name {
        left.name.clone()
    } else {
        format!("Left phone: {}; right phone: {}", left.name, right.name)
    }
}

/// Line up and calibrate the cameras from the first file of each video
/// (`left_secs` long on the left).
#[allow(clippy::too_many_arguments)]
fn calibrate(
    left: &Path,
    right: &Path,
    left_secs: f64,
    [left_lens, right_lens]: [&LensChoice; 2],
    fps: Fps,
    match_path: &Path,
    progress: &Progress,
    cancel: &AtomicBool,
) -> Result<CalibSummary, JobError> {
    let mut config = reco_calibrate::CalibrationConfig {
        num_frames: 4,
        skip_start_secs: (left_secs * 0.1).min(10.0),
        ..Default::default()
    };
    config.akaze.threshold = 0.0001;
    config.akaze.detect_y_min = 0.05;
    config.akaze.detect_y_max = 0.95;

    // Always an iPhone lens: Reco's own detection cannot recognise the
    // stock Camera app and would pick an action camera.
    let options = CalibrateVideosOptions {
        config: Some(config),
        left_params: Some(left_lens.params.clone()),
        right_params: Some(right_lens.params.clone()),
        ..Default::default()
    };

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
        Err(e @ CalibrateVideosError::Io(_)) => {
            return Err(JobError::failed(
                format!("We couldn't read part of the videos. {DAMAGED}"),
                e,
            ));
        }
        Err(e) => return Err(JobError::failed(NOT_LINED_UP, e)),
    };
    cancelled(cancel)?;
    let cal = &result.calibration;
    tracing::info!(
        "Calibration done: confidence {:.2}, sync offset {} frames, {} matches",
        result.confidence,
        cal.sync_offset,
        result.total_matches
    );
    if cal.rig_tilt != 0.0 || cal.rig_roll != 0.0 {
        // GoPro / DJI: kept as is; the editor's Straighten picture starts
        // from it and the AI pass renders with it.
        tracing::info!(
            "The cameras measured their own level: tilt {:.1} deg, roll {:.1} deg",
            cal.rig_tilt.to_degrees(),
            cal.rig_roll.to_degrees()
        );
    }
    write_atomic(match_path, cal.to_json_pretty().as_bytes())
        .map_err(|e| JobError::failed("We couldn't save the calibration.", e))?;
    // Check it now, not after the long preview step.
    MatchCalibration::from_file(match_path).map_err(|e| JobError::failed(NOT_LINED_UP, e))?;
    Ok(CalibSummary {
        confidence: result.confidence,
        sync_offset_frames: cal.sync_offset,
        sync_offset_seconds: cal.sync_offset as f64 / fps.as_f64(),
        lens: lens_summary(left_lens, right_lens),
    })
}

/// One camera's video for Reco: the file, or the parts of a recording
/// chained one after the other (Reco reads them as one video and pairs the
/// frames by count across the joins).
pub fn input_path(files: &[PathBuf]) -> reco_io::InputPath {
    match files {
        [one] => reco_io::InputPath::Single(one.clone()),
        parts => reco_io::InputPath::Chained(parts.to_vec()),
    }
}

/// Reco's lookahead (seconds), as reco-gui's default.
const LOOKAHEAD_SECS: f64 = 1.5;

/// The lookahead in frames, worked out exactly like `StitchJob::run`.
fn lookahead_frames(left: &Path) -> usize {
    let fps = reco_io::adapters::FfmpegFileSource::frame_rate(left)
        .map(|(n, d)| if d != 0 { n as f64 / d as f64 } else { 30.0 })
        .unwrap_or(30.0);
    (LOOKAHEAD_SECS * fps).round() as usize
}

/// What the AI needs from the match settings.
fn repan_settings(meta: &ProjectMeta) -> RepanSettings {
    RepanSettings {
        style: meta.style,
        every: meta.ai_accuracy.interval(),
        roi: meta.pitch.as_ref().map(|p| p.field_roi()),
        widest: WidestView::effective(meta.widest_view),
    }
}

/// A recording of what the AI saw that can make the AI path for these
/// settings without going through the video again (DESIGN.md 4.9).
fn usable_recording(
    ctx: &Context,
    dir: &Path,
    meta: &ProjectMeta,
    sync_offset: i64,
) -> Option<SeenMeta> {
    let seen = crate::seen::read_meta(dir)?;
    let (model, bytes) = crate::seen::model_identity(ctx.model.as_deref()?);
    let ok = seen.model == model
        && seen.model_bytes == bytes
        && seen.sync_offset == sync_offset
        && meta.ai_accuracy.interval().is_multiple_of(seen.every);
    if !ok {
        tracing::info!(
            "What the AI saw last time can't be used for this run (it looked at every {} \
             frame(s) with {}; now every {} with {model}): the AI goes through the video again",
            seen.every,
            seen.model,
            meta.ai_accuracy.interval()
        );
    }
    ok.then_some(seen)
}

/// The AI path from a recording of what the AI saw (a `quick` re-run, or
/// "Follow the ball" right after the AI pass): Reco's camera for its
/// styles, the brain's for "Follow the ball"; and the ball numbers.
fn repan_recorded(
    dir: &Path,
    match_path: &Path,
    meta: &ProjectMeta,
    seen: &SeenMeta,
    progress: &Progress,
    quick: bool,
) -> Result<(Vec<[f32; 3]>, Option<BallStats>), JobError> {
    let started = std::time::Instant::now();
    let fail = |e: String| {
        JobError::failed(
            "VeoClone couldn't reuse what the AI saw last time. Press Try again: the AI then \
             goes through the whole video again.",
            e,
        )
    };
    let cal = MatchCalibration::from_file(match_path).map_err(|e| fail(e.to_string()))?;
    progress.fraction(0.1, Some("Reading what the AI saw last time"));
    let frames = crate::seen::read_frames(&dir.join(crate::seen::SEEN_DATA)).map_err(|e| {
        crate::seen::remove(dir);
        fail(e.to_string())
    })?;
    let settings = repan_settings(meta);
    let (path, ball) = if meta.style.uses_brain() {
        progress.fraction(0.4, Some("Following the ball"));
        let (plan, stats) = brain::follow(&cal, seen, &frames, &settings, &BrainConfig::default())
            .map_err(|e| {
                crate::seen::remove(dir);
                fail(e)
            })?;
        log_stats(&settings, &stats);
        (plan.path, Some(plan.stats))
    } else {
        progress.fraction(0.4, Some("Steering the camera again"));
        let (poses, stats) = crate::seen::repan(&cal, seen, &frames, &settings).map_err(|e| {
            crate::seen::remove(dir);
            fail(e)
        })?;
        log_stats(&settings, &stats);
        let ball = ball_stats(&cal, seen, &frames, &settings);
        (fill_path(&poses, seen.frames as usize), ball)
    };
    if let Some(b) = &ball {
        tracing::info!("{}", brain::describe(b));
    }
    tracing::info!(
        "{}: AI path for {} frames made in {:.2} s from what the AI saw ({})",
        if quick {
            "Quick re-run"
        } else {
            "Follow the ball"
        },
        path.len(),
        started.elapsed().as_secs_f64(),
        if meta.style.uses_brain() {
            "VeoClone's ball tracking"
        } else {
            "Reco's camera"
        }
    );
    Ok((path, ball))
}

/// The ball numbers of a recording, for a style whose camera Reco makes.
fn ball_stats(
    cal: &MatchCalibration,
    seen: &SeenMeta,
    frames: &[Vec<reco_core::detect::detector::Detection>],
    settings: &RepanSettings,
) -> Option<BallStats> {
    match brain::follow(cal, seen, frames, settings, &BrainConfig::default()) {
        Ok((plan, _)) => Some(plan.stats),
        Err(e) => {
            tracing::warn!("No ball numbers: {e}");
            None
        }
    }
}

/// [`ball_stats`] of the recording in `dir`, logged.
fn recorded_ball_stats(
    dir: &Path,
    match_path: &Path,
    meta: &ProjectMeta,
    seen: &SeenMeta,
) -> Option<BallStats> {
    let cal = MatchCalibration::from_file(match_path).ok()?;
    let frames = crate::seen::read_frames(&dir.join(crate::seen::SEEN_DATA)).ok()?;
    let stats = ball_stats(&cal, seen, &frames, &repan_settings(meta))?;
    tracing::info!("{}", brain::describe(&stats));
    Some(stats)
}

fn log_stats(settings: &RepanSettings, stats: &RepanStats) {
    if settings.roi.is_some() {
        tracing::info!(
            "Pitch outline: {} of the {} people and balls the AI found were outside the pitch \
             and ignored",
            stats.outside_pitch,
            stats.seen
        );
    }
}

/// Run Reco's AI camera (exactly like reco-gui's export) and keep only the
/// per-frame camera poses, and record what the AI saw (crate::seen).
#[allow(clippy::too_many_arguments)]
fn track(
    ctx: &Context,
    dir: &Path,
    left: &[PathBuf],
    right: &[PathBuf],
    match_path: &Path,
    meta: &ProjectMeta,
    fps: Fps,
    frame_count: u64,
    progress: &Progress,
    cancel: &AtomicBool,
) -> Result<(Vec<[f32; 3]>, bool), JobError> {
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
    let source_fps: Arc<Mutex<Option<f32>>> = Arc::new(Mutex::new(None));

    let sink = PoseSink {
        poses: poses.clone(),
        max_frames: frame_count as usize * 2 + 10_000,
    };
    // Reco's camera for the style ("Follow the ball": broadcast; VeoClone's
    // brain then makes its camera from what the AI saw).
    let reco_style = meta.style.reco();
    let preset = reco_style.preset();
    let mode = reco_style.tracking_mode();
    let interval = meta.ai_accuracy.interval();
    // "Mark the pitch" and the widest view (the same settings as a re-run).
    let settings = RepanSettings {
        style: reco_style,
        ..repan_settings(meta)
    };
    // The style's preset with the widest view's zoom limit; repan uses the
    // same config, so a recording replays to exactly this path.
    let panner = crate::seen::panner_config(reco_style, settings.widest);
    if let Some(c) = &panner {
        tracing::info!(
            "AI camera zoom: {:.0} to {:.0} deg tall, starting at {:.0} deg",
            c.fov_tight,
            c.fov_wide,
            c.fov_default
        );
    }
    tracing::info!(
        "Camera style: {:?} (AI pass with Reco {mode:?} tracking, {preset} preset{}); AI \
         accuracy {:?} (the AI looks at every {})",
        meta.style,
        if meta.style.uses_brain() {
            ", then VeoClone's ball tracking from what the AI saw"
        } else {
            ""
        },
        meta.ai_accuracy,
        if interval == 1 {
            "frame".to_string()
        } else {
            format!("{interval}rd frame")
        }
    );
    // The model's classes, the way setup_autocam reads them.
    let names = reco_detect::create_ort_session(&model, Vec::new())
        .map(|(_, _, names)| names)
        .unwrap_or_default();
    let classes = Classes::from_names(&names);
    let (model_name, model_bytes) = crate::seen::model_identity(&model);
    // "Mark the pitch": people and balls outside it are ignored.
    let field_roi = match &settings.roi {
        Some(roi) => {
            tracing::info!(
                "Pitch outline: the AI ignores everything outside it ({} and {} corners)",
                roi.left.len(),
                roi.right.len()
            );
            Some(roi.clone())
        }
        None => cal
            .field_roi
            .clone()
            .filter(|r| r.left.len() >= 3 || r.right.len() >= 3),
    };
    // What the AI saw, for quick re-runs; the AI pass goes on without it if
    // it can't be written.
    let recording = dir.join(format!("ai_seen.{}.tmp.gz", new_id()));
    let writer = match SeenWriter::create(&recording, classes) {
        Ok(w) => Some(Arc::new(Mutex::new(w))),
        Err(e) => {
            tracing::warn!("Can't record what the AI sees: {e}");
            None
        }
    };
    let hook_writer = writer.clone();
    let hook_error = setup_error.clone();
    let hook_stop = stop.clone();
    let hook_fps = source_fps.clone();
    let d = done.clone();
    let job = reco_io::StitchJob::with_calibration(
        input_path(left),
        input_path(right),
        cal.clone(),
        scratch.clone(),
    )
    .codec(reco_io::output::Codec::H264)
    .quality(reco_io::output::Quality::Fast)
    .format(reco_io::output::Format::Mkv)
    .audio(reco_io::output::AudioMode::Disabled)
    .resolution(640, 360)
    .blend_width(BLEND_WIDTH)
    .lookahead(LOOKAHEAD_SECS)
    .on_progress(move |p| d.store(p.frames_completed, Ordering::Relaxed))
    .on_session(move |session, source| {
        let info = source.info();
        *hook_fps.lock().unwrap_or_else(|p| p.into_inner()) = Some(info.fps as f32);
        let is_10bit =
            source.gpu_pixel_format() == reco_core::render::renderer::GpuPixelFormat::P010;
        // Reco's own setup, except that the detector always finds
        // everything at the field-mode floor so the recording suits every
        // style; the ball-mode floor and the pitch outline are applied
        // after the recorder (crate::seen::wrap_detector), which gives the
        // trackers exactly the detections Reco's own setup would.
        let mut config = reco_autocam::AutocamConfig::new(&model)
            .with_tracking_mode(mode)
            .with_detection_interval(interval)
            .with_10bit(is_10bit);
        config.field_panner_config = panner;
        config.confidence_threshold = Some(RECORD_CONFIDENCE);
        let min_confidence = (mode == reco_autocam::TrackingMode::Ball).then_some(BALL_CONFIDENCE);
        let roi = field_roi.map(|r| (r, classes.roi_person));
        let mut target = crate::seen::Wiring {
            session: &mut *session,
            wrap: Some(move |detector| {
                crate::seen::wrap_detector(detector, hook_writer, min_confidence, roi)
            }),
        };
        let error = match reco_autocam::setup_autocam(
            &mut target,
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
    let job = if meta.safe_mode() {
        // No graphics-card video decoding (zero-copy on Windows).
        tracing::info!("Safe mode: decoding the videos without the graphics card");
        job.force_cpu_decode()
    } else {
        job
    };

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
    // Finished here so a failed or cancelled pass leaves nothing behind.
    let recorded = writer.map(|w| {
        let r = w.lock().unwrap_or_else(|p| p.into_inner()).finish();
        r.map(|_| ())
    });
    let discard = || {
        let _ = std::fs::remove_file(&recording);
    };

    if let Some(e) = setup_error.lock().unwrap_or_else(|p| p.into_inner()).take() {
        discard();
        return Err(JobError::failed(
            "The AI ball tracking could not start. Please download VeoClone again.",
            e,
        ));
    }
    if cancel.load(Ordering::SeqCst) {
        discard();
        return Err(JobError::Cancelled);
    }
    let r = result.map_err(|e| {
        discard();
        JobError::failed("The AI ball tracking stopped with an error.", e)
    })?;
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
        discard();
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
    // Reco stops at the first damaged spot of either file as if the video
    // ended there, while ffmpeg (the preview) reads past it; don't let that
    // quietly cut the match short.
    let expected = proxy_frames.unwrap_or(frame_count);
    if stopped_early(frames as u64, expected, fps) {
        discard();
        return Err(JobError::failed(
            format!(
                "We could only read the first {} of the videos. {DAMAGED}",
                fps.clock(frames as u64)
            ),
            format!("AI pass saw {frames} of {expected} frames"),
        ));
    }
    let path = fill_path(&poses, frames);

    // Keep the recording if it gives back exactly this path.
    let seen_meta = SeenMeta {
        version: crate::seen::VERSION,
        model: model_name,
        model_bytes,
        classes,
        fps: source_fps
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .unwrap_or(fps.as_f64() as f32),
        lookahead_frames: lookahead_frames(&left[0]),
        every: interval,
        frames: frames as u64,
        sync_offset: cal.sync_offset,
    };
    let kept = match recorded {
        Some(Ok(())) => keep_recording(dir, &cal, &recording, &seen_meta, &settings, &path),
        Some(Err(e)) => {
            tracing::warn!("What the AI saw could not be saved ({e}); re-runs take the long way");
            discard();
            false
        }
        None => false,
    };
    Ok((path, kept))
}

/// Check the recording against the AI pass (the same settings must give the
/// same path) and keep it for quick re-runs, replacing the earlier one.
/// Returns whether it was kept.
fn keep_recording(
    dir: &Path,
    cal: &MatchCalibration,
    recording: &Path,
    seen: &SeenMeta,
    settings: &RepanSettings,
    live: &[[f32; 3]],
) -> bool {
    let started = std::time::Instant::now();
    let checked = crate::seen::read_frames(recording)
        .map_err(|e| e.to_string())
        .and_then(|frames| crate::seen::repan(cal, seen, &frames, settings));
    let ok = match checked {
        Ok((poses, stats)) => {
            log_stats(settings, &stats);
            let replay = fill_path(&poses, seen.frames as usize);
            let [dy, dp, df] = crate::seen::max_difference(&replay, live);
            tracing::info!(
                "What the AI saw: {} bytes; replaying it gives the same camera path (largest \
                 difference: yaw {dy:.2e} rad, pitch {dp:.2e} rad, zoom {df:.2e} deg; checked \
                 in {:.2} s)",
                std::fs::metadata(recording).map(|m| m.len()).unwrap_or(0),
                started.elapsed().as_secs_f64()
            );
            dy <= 1e-4 && dp <= 1e-4 && df <= 1e-3
        }
        Err(e) => {
            tracing::warn!("What the AI saw can't be replayed: {e}");
            false
        }
    };
    let saved = ok
        && std::fs::rename(recording, dir.join(crate::seen::SEEN_DATA)).is_ok()
        && write_atomic(
            &dir.join(crate::seen::SEEN_META),
            &serde_json::to_vec_pretty(seen).expect("json"),
        )
        .is_ok();
    if !saved {
        tracing::warn!(
            "What the AI saw is not kept: changing the style will go through the video again"
        );
        let _ = std::fs::remove_file(recording);
        crate::seen::remove(dir);
    }
    saved
}

/// Fewer frames than expected by more than two seconds' worth.
pub fn stopped_early(frames: u64, expected: u64, fps: Fps) -> bool {
    frames + (2.0 * fps.as_f64()).ceil() as u64 + 1 < expected
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_reads_are_noticed() {
        let fps = Fps { num: 30, den: 1 };
        assert!(!stopped_early(6000, 6000, fps));
        assert!(!stopped_early(5940, 6000, fps));
        assert!(stopped_early(2399, 6000, fps));
        assert_eq!(fps.clock(2399), "1:19");
        assert_eq!(fps.clock(30 * 3725), "1:02:05");
    }

    #[test]
    fn lens_per_phone_summary() {
        let none = Path::new("");
        let left = choose_lens(Some("iphone-13-pro-max:ultra"), none, 1920, 1080);
        let right = choose_lens(Some("iphone-11:ultra"), none, 1920, 1080);
        assert_ne!(left.params.fx, right.params.fx);
        assert_eq!(
            lens_summary(&left, &right),
            "Left phone: iPhone 13 Pro Max · Ultra wide (0.5×); right phone: iPhone 11 · \
             Ultra wide (0.5×)"
        );
        assert_eq!(
            lens_summary(&left, &left),
            "iPhone 13 Pro Max · Ultra wide (0.5×)"
        );
    }

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
