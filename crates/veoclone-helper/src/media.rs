//! Everything that shells out to the bundled `ffmpeg` / `ffprobe`: probing
//! uploads, making the stacked preview proxy and joining export parts.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use serde_json::Value;

use crate::store::{Fps, ProbeInfo};

/// Paths of the external tools, resolved once at startup.
#[derive(Debug, Clone, Default)]
pub struct Tools {
    pub ffmpeg: Option<PathBuf>,
    pub ffprobe: Option<PathBuf>,
}

impl Tools {
    /// Look next to the executable first, then on PATH.
    pub fn find() -> Tools {
        Tools {
            ffmpeg: find_tool("ffmpeg"),
            ffprobe: find_tool("ffprobe"),
        }
    }

    pub fn ffmpeg(&self) -> Result<&Path, String> {
        self.ffmpeg
            .as_deref()
            .ok_or_else(|| "ffmpeg not found".into())
    }

    pub fn ffprobe(&self) -> Result<&Path, String> {
        self.ffprobe
            .as_deref()
            .ok_or_else(|| "ffprobe not found".into())
    }
}

pub fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
}

fn find_tool(name: &str) -> Option<PathBuf> {
    let file = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    let next_to_exe = exe_dir().map(|d| d.join(&file));
    let on_path: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).map(|d| d.join(&file)).collect())
        .unwrap_or_default();
    next_to_exe.into_iter().chain(on_path).find(|p| p.is_file())
}

/// A `Command` that never opens a console window on Windows.
pub fn command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.stdin(Stdio::null());
    cmd
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/// Run ffprobe on one file.
pub fn probe(tools: &Tools, path: &Path) -> Result<ProbeInfo, String> {
    let out = command(tools.ffprobe()?)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
        ])
        .arg(path)
        .output()
        .map_err(|e| format!("could not run ffprobe: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    parse_probe(&String::from_utf8_lossy(&out.stdout))
}

fn parse_rational(s: &str) -> Option<Fps> {
    let (n, d) = s.split_once('/')?;
    let (n, d) = (n.trim().parse::<u32>().ok()?, d.trim().parse::<u32>().ok()?);
    let fps = Fps { num: n, den: d };
    (d != 0 && n != 0 && fps.as_f64() <= 1000.0).then_some(fps)
}

/// Same choice as Reco's decoder (`pick_frame_rate`): the nominal
/// `r_frame_rate`, unless it is a bogus field rate.
fn pick_fps(r: Option<Fps>, avg: Option<Fps>) -> Option<Fps> {
    match (r, avg) {
        (Some(r), Some(avg)) if avg.as_f64() < 70.0 && r.as_f64() > 210.0 => Some(avg),
        (Some(r), _) => Some(r),
        (None, avg) => avg,
    }
}

pub const NO_VIDEO: &str = "no video stream";

/// Parse `ffprobe -print_format json -show_streams -show_format` output.
pub fn parse_probe(json: &str) -> Result<ProbeInfo, String> {
    let v: Value = serde_json::from_str(json).map_err(|e| format!("bad ffprobe output: {e}"))?;
    let streams = v["streams"].as_array().cloned().unwrap_or_default();
    let video = streams
        .iter()
        .find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"] != 1)
        .ok_or(NO_VIDEO)?;
    let has_audio = streams.iter().any(|s| s["codec_type"] == "audio");
    let str_of = |v: &Value| v.as_str().unwrap_or("").to_string();
    let num_of = |v: &Value| -> Option<f64> {
        v.as_f64()
            .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
    };

    let width = video["width"].as_u64().unwrap_or(0) as u32;
    let height = video["height"].as_u64().unwrap_or(0) as u32;
    let fps = pick_fps(
        parse_rational(video["r_frame_rate"].as_str().unwrap_or("")),
        parse_rational(video["avg_frame_rate"].as_str().unwrap_or("")),
    )
    .ok_or("no frame rate")?;
    let duration = num_of(&video["duration"])
        .or_else(|| num_of(&v["format"]["duration"]))
        .unwrap_or(0.0);
    let frame_count = num_of(&video["nb_frames"])
        .filter(|n| *n > 0.0)
        .map(|n| n as u64)
        .unwrap_or_else(|| (duration * fps.as_f64()).round() as u64);

    // Display rotation: the display-matrix side data (counter-clockwise
    // degrees) or the older `rotate` tag (clockwise). Normalised to the
    // clockwise 0/90/180/270 Reco uses.
    let side_rotation = video["side_data_list"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|s| num_of(&s["rotation"]));
    let rotation = match side_rotation {
        Some(r) => -r,
        None => num_of(&video["tags"]["rotate"]).unwrap_or(0.0),
    };
    let rotation = ((rotation.round() as i32 % 360) + 360) % 360;

    let transfer = str_of(&video["color_transfer"]);
    Ok(ProbeInfo {
        width,
        height,
        fps,
        frame_count,
        duration,
        codec: str_of(&video["codec_name"]),
        pixel_format: str_of(&video["pix_fmt"]),
        color_transfer: (!transfer.is_empty()).then_some(transfer),
        rotation,
        has_audio,
    })
}

pub fn is_hdr(p: &ProbeInfo) -> bool {
    matches!(
        p.color_transfer.as_deref(),
        Some("arib-std-b67") | Some("smpte2084")
    )
}

/// Check the two uploads can be stitched. Returns warnings, or the
/// plain-language reason they cannot be used.
pub fn check_pair(left: &ProbeInfo, right: &ProbeInfo) -> Result<Vec<String>, String> {
    for (side, p) in [("left", left), ("right", right)] {
        if p.width == 0 || p.height == 0 {
            return Err(format!("The {side} file has no picture in it."));
        }
        if p.rotation == 90 || p.rotation == 270 {
            return Err(format!(
                "The {side} video was filmed upright (portrait). Hold both phones sideways \
                 (landscape) when filming."
            ));
        }
    }
    if (left.width, left.height) != (right.width, right.height) {
        return Err(format!(
            "The two videos are different sizes ({}x{} and {}x{}). Film with both phones set \
             to the same video format.",
            left.width, left.height, right.width, right.height
        ));
    }
    if (left.fps.as_f64() - right.fps.as_f64()).abs() > 0.5 {
        return Err(format!(
            "The two videos were filmed at different speeds ({:.0} and {:.0} frames per \
             second). Film with both phones set to the same video format.",
            left.fps.as_f64(),
            right.fps.as_f64()
        ));
    }
    let mut warnings = Vec::new();
    if is_hdr(left) || is_hdr(right) {
        warnings.push(
            "Colours may look washed out — turn off HDR Video on the phones next time.".into(),
        );
    }
    if left.fps.as_f64() > 31.0 {
        warnings.push("60 fps works but 30 fps is recommended.".into());
    }
    Ok(warnings)
}

// ---------------------------------------------------------------------------
// Running ffmpeg
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum RunError {
    Cancelled,
    Failed(String),
}

/// Pull the frame number out of an ffmpeg `-progress` line (`frame=123`).
pub fn parse_progress_frame(line: &str) -> Option<u64> {
    line.trim().strip_prefix("frame=")?.trim().parse().ok()
}

/// Run ffmpeg with `-progress pipe:1`, reporting the frame counter and
/// killing it when `cancel` is set.
pub fn run_ffmpeg(
    ffmpeg: &Path,
    args: &[String],
    cancel: &AtomicBool,
    mut on_frame: impl FnMut(u64),
) -> Result<(), RunError> {
    log::info!("ffmpeg {}", args.join(" "));
    let mut child = command(ffmpeg)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| RunError::Failed(format!("could not start ffmpeg: {e}")))?;

    let frames = Arc::new(AtomicU64::new(0));
    let stdout = child.stdout.take().expect("piped");
    let f = frames.clone();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(n) = parse_progress_frame(&line) {
                f.store(n, Ordering::Relaxed);
            }
        }
    });
    let mut stderr = child.stderr.take().expect("piped");
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let mut last = 0;
    let status = loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            let _ = err_reader.join();
            return Err(RunError::Cancelled);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => return Err(RunError::Failed(e.to_string())),
        }
        let n = frames.load(Ordering::Relaxed);
        if n != last {
            last = n;
            on_frame(n);
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let _ = reader.join();
    let stderr = err_reader.join().unwrap_or_default();
    on_frame(frames.load(Ordering::Relaxed));
    if status.success() {
        Ok(())
    } else {
        Err(RunError::Failed(tail(&stderr, 1500)))
    }
}

fn tail(s: &str, max: usize) -> String {
    let s = s.trim();
    match s.char_indices().rev().nth(max) {
        Some((i, _)) => format!("…{}", &s[i..]),
        None => s.to_string(),
    }
}

/// Encoders compiled into this ffmpeg (`ffmpeg -encoders`).
pub fn has_encoder(ffmpeg: &Path, name: &str) -> bool {
    command(ffmpeg)
        .args(["-hide_banner", "-encoders"])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .split_whitespace()
                .any(|w| w == name)
        })
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Preview proxy
// ---------------------------------------------------------------------------

/// Everything needed to build the stacked preview video.
#[derive(Debug, Clone)]
pub struct ProxyPlan {
    pub left: PathBuf,
    pub right: PathBuf,
    pub output: PathBuf,
    pub fps: Fps,
    pub left_skip: u64,
    pub right_skip: u64,
    pub frame_count: u64,
    pub tile_width: u32,
    pub tile_height: u32,
    /// Copy the left camera's sound.
    pub audio: bool,
}

/// Preview tile size: 1280 wide, 16:9 when the source is 16:9, otherwise the
/// source shape with an even height.
pub fn tile_size(width: u32, height: u32) -> (u32, u32) {
    if width == 0 || height == 0 || width * 9 == height * 16 {
        return (1280, 720);
    }
    let h = (1280.0 * height as f64 / width as f64 / 2.0).round() as u32 * 2;
    (1280, h.max(2))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoder {
    /// AMD hardware encoder (the target PC's RX 6800).
    Amf,
    X264,
}

/// ffmpeg arguments for the proxy. Frames are paired by count exactly like
/// Reco does (`trim=start_frame` then a fresh constant-rate clock), so proxy
/// frame N is synced frame N.
pub fn proxy_args(plan: &ProxyPlan, encoder: Encoder, hwaccel: bool) -> Vec<String> {
    let fps = format!("{}/{}", plan.fps.num, plan.fps.den);
    let (w, h) = (plan.tile_width, plan.tile_height);
    let mut a: Vec<String> = Vec::new();
    let mut push = |items: &[&str]| a.extend(items.iter().map(|s| s.to_string()));
    push(&["-hide_banner", "-nostdin", "-y", "-loglevel", "error"]);
    push(&["-progress", "pipe:1", "-nostats"]);
    for input in [&plan.left, &plan.right] {
        if hwaccel {
            push(&["-hwaccel", "auto"]);
        }
        push(&["-i", &input.to_string_lossy()]);
    }
    let tile = |input: u32, skip: u64, label: &str| {
        format!(
            "[{input}:v]trim=start_frame={skip},setpts=N/({fps})/TB,\
             scale={w}:{h}:flags=bicubic,setsar=1,format=yuv420p[{label}]"
        )
    };
    let mut filter = format!(
        "{};{};[l][r]vstack=inputs=2[v]",
        tile(0, plan.left_skip, "l"),
        tile(1, plan.right_skip, "r")
    );
    if plan.audio {
        let start = plan.fps.frame_to_secs(plan.left_skip);
        let end = start + plan.fps.frame_to_secs(plan.frame_count);
        filter.push_str(&format!(
            ";[0:a:0]atrim=start={start:.6}:end={end:.6},asetpts=PTS-STARTPTS[a]"
        ));
    }
    push(&["-filter_complex", &filter, "-map", "[v]"]);
    if plan.audio {
        push(&["-map", "[a]", "-c:a", "aac", "-b:a", "128k"]);
    }
    let gop = (plan.fps.as_f64().round() as u32).max(1).to_string();
    push(&["-frames:v", &plan.frame_count.to_string(), "-r", &fps]);
    match encoder {
        Encoder::Amf => push(&[
            "-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_i", "26", "-qp_p", "28",
        ]),
        Encoder::X264 => push(&["-c:v", "libx264", "-preset", "veryfast", "-crf", "26"]),
    }
    push(&[
        "-g",
        &gop,
        "-pix_fmt",
        "yuv420p",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-colorspace",
        "bt709",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        &plan.output.to_string_lossy(),
    ]);
    a
}

/// Make the proxy: AMD hardware encoding with hardware decoding first, then
/// plain software as a fallback.
pub fn make_proxy(
    tools: &Tools,
    plan: &ProxyPlan,
    cancel: &AtomicBool,
    mut on_frame: impl FnMut(u64),
) -> Result<(), RunError> {
    let ffmpeg = tools.ffmpeg().map_err(RunError::Failed)?;
    let first = if has_encoder(ffmpeg, "h264_amf") {
        Encoder::Amf
    } else {
        Encoder::X264
    };
    match run_ffmpeg(
        ffmpeg,
        &proxy_args(plan, first, true),
        cancel,
        &mut on_frame,
    ) {
        Err(RunError::Failed(e)) => {
            log::warn!("Preview encode failed ({e}); trying again with software encoding");
            on_frame(0);
            run_ffmpeg(
                ffmpeg,
                &proxy_args(plan, Encoder::X264, false),
                cancel,
                &mut on_frame,
            )
        }
        other => other,
    }
}

/// Number of video frames in a file (packet count, fast).
pub fn count_frames(tools: &Tools, path: &Path) -> Option<u64> {
    let out = command(tools.ffprobe().ok()?)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_packets",
            "-show_entries",
            "stream=nb_read_packets",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

// ---------------------------------------------------------------------------
// Export join
// ---------------------------------------------------------------------------

/// The ffconcat list for parts that live in the same folder as the list.
pub fn concat_list(parts: &[String]) -> String {
    let mut s = String::from("ffconcat version 1.0\n");
    for p in parts {
        s.push_str(&format!("file '{}'\n", p.replace('\'', "'\\''")));
    }
    s
}

pub fn concat_args(list: &Path, output: &Path, reencode_audio: bool) -> Vec<String> {
    let mut a: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-loglevel",
        "error",
        "-progress",
        "pipe:1",
        "-nostats",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    a.push(list.to_string_lossy().into_owned());
    a.extend(["-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy"].map(String::from));
    if reencode_audio {
        a.extend(["-c:a", "aac", "-b:a", "192k"].map(String::from));
    } else {
        a.extend(["-c:a", "copy"].map(String::from));
    }
    a.extend(["-movflags", "+faststart", "-f", "mp4"].map(String::from));
    a.push(output.to_string_lossy().into_owned());
    a
}

/// Join the export parts into one MP4 that starts playing straight away.
pub fn concat(
    tools: &Tools,
    list: &Path,
    output: &Path,
    cancel: &AtomicBool,
) -> Result<(), RunError> {
    let ffmpeg = tools.ffmpeg().map_err(RunError::Failed)?;
    match run_ffmpeg(ffmpeg, &concat_args(list, output, false), cancel, |_| {}) {
        // MP4 cannot hold every phone audio format as-is (e.g. raw PCM).
        Err(RunError::Failed(e)) => {
            log::warn!("Joining with copied sound failed ({e}); converting the sound to AAC");
            run_ffmpeg(ffmpeg, &concat_args(list, output, true), cancel, |_| {})
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const IPHONE: &str = r#"{
      "streams": [
        {"index":0,"codec_name":"hevc","codec_type":"video","width":3840,"height":2160,
         "pix_fmt":"yuv420p10le","color_transfer":"arib-std-b67","r_frame_rate":"30/1",
         "avg_frame_rate":"18000/601","duration":"5400.100000","nb_frames":"162003",
         "side_data_list":[{"side_data_type":"Display Matrix","rotation":-180}]},
        {"index":1,"codec_name":"aac","codec_type":"audio"},
        {"index":2,"codec_name":"none","codec_type":"data"}
      ],
      "format": {"duration":"5400.2"}
    }"#;

    #[test]
    fn parses_iphone_probe() {
        let p = parse_probe(IPHONE).unwrap();
        assert_eq!((p.width, p.height), (3840, 2160));
        assert_eq!(p.fps, Fps { num: 30, den: 1 });
        assert_eq!(p.frame_count, 162003);
        assert_eq!(p.rotation, 180);
        assert!(p.has_audio);
        assert!(is_hdr(&p));
        assert_eq!(p.codec, "hevc");
        assert_eq!(p.color_transfer.as_deref(), Some("arib-std-b67"));
    }

    #[test]
    fn probe_fallbacks_and_rotation() {
        let p = parse_probe(
            r#"{"streams":[{"codec_type":"video","width":1920,"height":1080,
            "r_frame_rate":"0/0","avg_frame_rate":"30000/1001","tags":{"rotate":"90"}}],
            "format":{"duration":"10.0"}}"#,
        )
        .unwrap();
        assert_eq!(
            p.fps,
            Fps {
                num: 30000,
                den: 1001
            }
        );
        assert_eq!(p.frame_count, 300);
        assert_eq!(p.rotation, 90);
        assert!(!p.has_audio);
        assert!(!is_hdr(&p));
        let p = parse_probe(
            r#"{"streams":[{"codec_type":"video","width":1920,"height":1080,
            "r_frame_rate":"30/1","side_data_list":[{"rotation":90}]}]}"#,
        )
        .unwrap();
        assert_eq!(p.rotation, 270);
        assert!(parse_probe(r#"{"streams":[{"codec_type":"audio"}]}"#).is_err());
        assert!(parse_probe("not json").is_err());
    }

    fn probe_info(w: u32, h: u32, fps: u32, rot: i32) -> ProbeInfo {
        ProbeInfo {
            width: w,
            height: h,
            fps: Fps { num: fps, den: 1 },
            frame_count: 100,
            duration: 10.0,
            codec: "h264".into(),
            pixel_format: "yuv420p".into(),
            color_transfer: None,
            rotation: rot,
            has_audio: true,
        }
    }

    #[test]
    fn pair_checks() {
        let a = probe_info(3840, 2160, 30, 0);
        assert!(check_pair(&a, &a).unwrap().is_empty());
        assert!(check_pair(&a, &probe_info(1920, 1080, 30, 0)).is_err());
        assert!(check_pair(&a, &probe_info(3840, 2160, 60, 0)).is_err());
        assert!(check_pair(&a, &probe_info(3840, 2160, 30, 90)).is_err());
        assert!(check_pair(&a, &probe_info(3840, 2160, 30, 180)).is_ok());
        let fast = probe_info(3840, 2160, 60, 0);
        assert_eq!(check_pair(&fast, &fast).unwrap().len(), 1);
        let mut hdr = a.clone();
        hdr.color_transfer = Some("smpte2084".into());
        assert!(check_pair(&hdr, &a).unwrap()[0].contains("HDR"));
    }

    #[test]
    fn tiles() {
        assert_eq!(tile_size(3840, 2160), (1280, 720));
        assert_eq!(tile_size(1920, 1080), (1280, 720));
        assert_eq!(tile_size(1920, 1440), (1280, 960));
        assert_eq!(tile_size(1000, 333), (1280, 426));
    }

    #[test]
    fn proxy_arguments() {
        let plan = ProxyPlan {
            left: "L.mov".into(),
            right: "R.mov".into(),
            output: "proxy.mp4".into(),
            fps: Fps { num: 30, den: 1 },
            left_skip: 0,
            right_skip: 12,
            frame_count: 588,
            tile_width: 1280,
            tile_height: 720,
            audio: true,
        };
        let a = proxy_args(&plan, Encoder::X264, true).join(" ");
        assert!(a.contains("-hwaccel auto -i L.mov -hwaccel auto -i R.mov"));
        assert!(a.contains(
            "[0:v]trim=start_frame=0,setpts=N/(30/1)/TB,scale=1280:720:flags=bicubic,setsar=1,format=yuv420p[l]"
        ));
        assert!(a.contains("[1:v]trim=start_frame=12,"));
        assert!(a.contains("[l][r]vstack=inputs=2[v]"));
        assert!(a.contains("[0:a:0]atrim=start=0.000000:end=19.600000,asetpts=PTS-STARTPTS[a]"));
        assert!(a.contains("-frames:v 588 -r 30/1"));
        assert!(a.contains("-c:v libx264 -preset veryfast -crf 26 -g 30"));
        assert!(a.contains("-movflags +faststart"));
        assert!(a.ends_with("proxy.mp4"));

        let plan = ProxyPlan {
            audio: false,
            left_skip: 30,
            right_skip: 0,
            fps: Fps {
                num: 60000,
                den: 1001,
            },
            ..plan
        };
        let a = proxy_args(&plan, Encoder::Amf, false).join(" ");
        assert!(!a.contains("hwaccel"));
        assert!(!a.contains("[a]"));
        assert!(a.contains("trim=start_frame=30,setpts=N/(60000/1001)/TB"));
        assert!(a.contains("-c:v h264_amf -quality speed -rc cqp -qp_i 26 -qp_p 28 -g 60"));
    }

    #[test]
    fn progress_lines() {
        assert_eq!(parse_progress_frame("frame=123"), Some(123));
        assert_eq!(parse_progress_frame("frame= 7 "), Some(7));
        assert_eq!(parse_progress_frame("fps=30.0"), None);
    }

    #[test]
    fn concat_listing() {
        let l = concat_list(&["part-000.mkv".into(), "it's.mkv".into()]);
        assert_eq!(
            l,
            "ffconcat version 1.0\nfile 'part-000.mkv'\nfile 'it'\\''s.mkv'\n"
        );
        let a = concat_args(Path::new("list.txt"), Path::new("out.mp4"), false).join(" ");
        assert!(a.contains("-f concat -safe 0 -i list.txt"));
        assert!(a.contains("-c:v copy -c:a copy -movflags +faststart -f mp4 out.mp4"));
        let a = concat_args(Path::new("list.txt"), Path::new("out.mp4"), true).join(" ");
        assert!(a.contains("-c:a aac"));
    }

    #[test]
    fn tail_keeps_end() {
        assert_eq!(tail("abc", 10), "abc");
        assert_eq!(tail("abcdef", 2), "…def");
    }
}
