//! Seeking the CPU file source far ahead (the path `StitchJob::start_time`
//! takes for trims over 10 s) must land on frame `n` by count, also when
//! the frames' timestamps are slightly off the exact `n / fps` grid, as in
//! phone videos (variable frame rate, 1/600 s ticks).
//!
//! Needs the `ffmpeg` program on PATH to make the test clip; skipped
//! without it.

#![cfg(feature = "ffmpeg")]

use std::path::Path;
use std::process::Command;

use reco_core::source::{FrameSource, StereoFrame};
use reco_io::adapters::FfmpegFileSource;

/// 15 s at 30 fps where frame n has luma 30 + 13 * (n % 16) and every odd
/// frame starts one tick (1/600 s) early.
fn jittered_clip(path: &Path) -> bool {
    let video = "color=c=black:s=64x36:r=30:d=15,format=yuv420p,\
                 geq=lum='30+13*mod(N,16)':cb=128:cr=128,\
                 settb=1/600,setpts='N*20-mod(N,2)'";
    Command::new("ffmpeg")
        .args(["-y", "-v", "error", "-f", "lavfi", "-i", video])
        .args(["-fps_mode", "passthrough", "-enc_time_base", "1/600"])
        .args(["-c:v", "libx264", "-g", "30", "-bf", "2", "-crf", "10"])
        .args(["-video_track_timescale", "600", "-pix_fmt", "yuv420p"])
        .arg(path)
        .status()
        .is_ok_and(|s| s.success())
}

/// Frame number codes of the next left and right frames.
fn next_codes(source: &mut FfmpegFileSource) -> (u64, u64) {
    let Some(StereoFrame::Yuv420p(pair)) = source.next_frame().unwrap() else {
        panic!("no frame");
    };
    let code = |y: &[u8]| {
        let mean = y.iter().map(|&v| v as f64).sum::<f64>() / y.len() as f64;
        ((mean - 30.0) / 13.0).round() as u64
    };
    (code(&pair.left.y), code(&pair.right.y))
}

#[test]
fn far_seeks_land_on_the_counted_frame() {
    let dir = tempfile::tempdir().unwrap();
    let clip = dir.path().join("jitter.mp4");
    if !jittered_clip(&clip) {
        eprintln!("skipped: the ffmpeg program is not available");
        return;
    }
    // Right camera started 12 frames earlier.
    let mut source = FfmpegFileSource::open_with_offset(&clip, &clip, 12).unwrap();
    // Forward over 10 s, backward, odd (early) and even frames.
    for frame in [341, 400, 333, 0, 310] {
        source.seek(frame).unwrap();
        assert_eq!(
            next_codes(&mut source),
            (frame % 16, (frame + 12) % 16),
            "after seeking to frame {frame}"
        );
    }
}
