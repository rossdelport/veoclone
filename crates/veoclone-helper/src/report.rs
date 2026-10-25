//! The AI report (DESIGN.md 4.13): one small zip with what the AI saw and
//! what VeoClone made of it, so the camera can be tuned with real matches
//! later. No video and nothing personal: not the match name, not the file
//! names (the recording only holds boxes and numbers).
//!
//! ```text
//! veoclone-ai-report/
//!   README.txt        what this is
//!   settings.json     ReportSettings: style, AI accuracy, widest view, pitch outline,
//!                     straightening, frame count, fps, the AI run and its ball numbers
//!   ai_seen.bin.gz    what the AI saw (crate::seen)
//!   ai_seen.json      how it was recorded
//!   match.json        the calibration
//!   calib.json        the editor's calibration data (if there)
//!   ai_path.bin       the AI camera path
//! ```
//!
//! [`tool`] (`veoclone-helper --ai-report <zip>`, wrapped by
//! `scripts/ai_report.py`) runs the camera again from such a report, with
//! other brain settings if asked, and compares it with the report's path and,
//! when given, where the ball really was.

use std::io::Write;
use std::path::{Path, PathBuf};

use reco_core::calibration::MatchCalibration;
use reco_core::detect::detector::CameraId;
use reco_core::projection::CoverageBoundary;
use reco_core::render::scene::SceneGeometry;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::brain::{self, BrainConfig};
use crate::seen::{RepanSettings, SeenMeta, WidestView};
use crate::store::{AiAccuracy, AiRun, Fps, PitchOutline, ProjectMeta, Style};

/// The folder inside the zip.
pub const PREFIX: &str = "veoclone-ai-report/";
/// The report format.
pub const VERSION: u32 = 1;

/// The files of a project that go into the report, and whether it needs
/// them.
const FILES: [(&str, bool); 5] = [
    (crate::seen::SEEN_DATA, true),
    (crate::seen::SEEN_META, true),
    ("match.json", true),
    ("ai_path.bin", true),
    ("calib.json", false),
];

const README: &str = "VeoClone AI report\n\
\n\
What the AI saw in one match (people and balls as boxes and numbers, no\n\
pictures), the camera calibration and the camera path VeoClone made, so the\n\
camera can be tuned with real matches. No video, no match name, no file\n\
names. The VeoClone developers open it with scripts/ai_report.py.\n";

/// The settings the AI used (`settings.json`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportSettings {
    pub version: u32,
    /// The VeoClone version that made it.
    pub helper: String,
    pub brain: u32,
    pub style: Style,
    pub ai_accuracy: AiAccuracy,
    /// The widest view in effect (a match without one: widest).
    pub widest_view: WidestView,
    pub pitch: Option<PitchOutline>,
    /// The editor's "Straighten picture" (`edits.json`), if set.
    pub straighten: Option<Value>,
    pub fps: Option<Fps>,
    pub frame_count: Option<u64>,
    /// What the AI path was made with, and the ball numbers.
    pub ai_run: Option<AiRun>,
}

/// Why there is no report.
#[derive(Debug, PartialEq)]
pub enum ReportError {
    /// Something the report needs is missing (plain words).
    Missing(String),
    Failed(String),
}

/// The report of the project in `dir` as zip bytes.
pub fn build(dir: &Path, meta: &ProjectMeta, helper: &str) -> Result<Vec<u8>, ReportError> {
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    for (name, needed) in FILES {
        match std::fs::read(dir.join(name)) {
            Ok(bytes) => files.push((name.to_string(), bytes)),
            Err(_) if !needed => {}
            Err(_) => {
                return Err(ReportError::Missing(
                    "There is no AI report for this match yet: VeoClone has no record of what \
                     the AI saw. Run the AI again (Change the camera style, or Try again), then \
                     save the report."
                        .into(),
                ));
            }
        }
    }
    let straighten = std::fs::read(dir.join("edits.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("straighten").cloned());
    let settings = ReportSettings {
        version: VERSION,
        helper: helper.to_string(),
        brain: brain::VERSION,
        style: meta.style,
        ai_accuracy: meta.ai_accuracy,
        widest_view: WidestView::effective(meta.widest_view),
        pitch: meta.pitch.clone(),
        straighten,
        fps: meta.fps,
        frame_count: meta.frame_count,
        ai_run: meta.ai_run.clone(),
    };
    let settings =
        serde_json::to_vec_pretty(&settings).map_err(|e| ReportError::Failed(e.to_string()))?;
    files.push(("settings.json".into(), settings));
    files.push(("README.txt".into(), README.as_bytes().to_vec()));
    let entries: Vec<(String, &[u8])> = files
        .iter()
        .map(|(n, b)| (format!("{PREFIX}{n}"), b.as_slice()))
        .collect();
    zip(&entries).map_err(ReportError::Failed)
}

/// The download's name: no match name in it.
pub fn file_name() -> String {
    format!(
        "veoclone-ai-report-{}.zip",
        chrono::Local::now().format("%Y-%m-%d")
    )
}

/// A zip file (deflated, except files that are compressed already), the
/// kind `crate::unzip` reads.
pub fn zip(files: &[(String, &[u8])]) -> Result<Vec<u8>, String> {
    const LOCAL: u32 = 0x0403_4b50;
    const CENTRAL: u32 = 0x0201_4b50;
    const EOCD: u32 = 0x0605_4b50;
    let now = chrono::Local::now();
    use chrono::{Datelike, Timelike};
    let time = ((now.hour() << 11) | (now.minute() << 5) | (now.second() / 2)) as u16;
    let date =
        (((now.year().clamp(1980, 2107) - 1980) as u32) << 9 | now.month() << 5 | now.day()) as u16;
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in files {
        let mut crc = flate2::Crc::new();
        crc.update(data);
        let (method, body): (u16, std::borrow::Cow<[u8]>) = if name.ends_with(".gz") {
            (0, std::borrow::Cow::Borrowed(data))
        } else {
            let mut enc =
                flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
            enc.write_all(data).map_err(|e| e.to_string())?;
            (
                8,
                std::borrow::Cow::Owned(enc.finish().map_err(|e| e.to_string())?),
            )
        };
        let too_big =
            |n: usize| u32::try_from(n).map_err(|_| format!("{name} is too big for a zip"));
        let (size, packed, offset) = (
            too_big(data.len())?,
            too_big(body.len())?,
            too_big(out.len())?,
        );
        let common = |v: &mut Vec<u8>| {
            v.extend_from_slice(&20u16.to_le_bytes()); // version needed
            v.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 names
            v.extend_from_slice(&method.to_le_bytes());
            v.extend_from_slice(&time.to_le_bytes());
            v.extend_from_slice(&date.to_le_bytes());
            v.extend_from_slice(&crc.sum().to_le_bytes());
            v.extend_from_slice(&packed.to_le_bytes());
            v.extend_from_slice(&size.to_le_bytes());
            v.extend_from_slice(&(name.len() as u16).to_le_bytes());
            v.extend_from_slice(&0u16.to_le_bytes()); // extra
        };
        out.extend_from_slice(&LOCAL.to_le_bytes());
        common(&mut out);
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&body);
        central.extend_from_slice(&CENTRAL.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // made by
        common(&mut central);
        central.extend_from_slice(&[0; 10]); // comment, disk, internal, external
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let cd_offset = u32::try_from(out.len()).map_err(|_| "the report is too big for a zip")?;
    let count = u16::try_from(files.len()).map_err(|_| "too many files")?;
    out.extend_from_slice(&central);
    out.extend_from_slice(&EOCD.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    Ok(out)
}

// ---------------------------------------------------------------------------
// The dev tool
// ---------------------------------------------------------------------------

/// What `--ai-report` was asked to do.
#[derive(Debug, Clone, Default)]
pub struct ToolArgs {
    pub report: PathBuf,
    /// Write the path (and the ball track) here as CSV.
    pub csv: Option<PathBuf>,
    /// A JSON file with brain settings to change (`BrainConfig` names).
    pub brain_config: Option<PathBuf>,
    /// Where the ball really was: CSV `frame,camera,x,y` (camera `left` or
    /// `right`, x/y from 0 to 1 in that camera's picture, y down).
    pub truth: Option<PathBuf>,
    /// Another camera style than the report's.
    pub style: Option<Style>,
}

/// An unpacked report, read.
struct Report {
    settings: ReportSettings,
    cal: MatchCalibration,
    seen: SeenMeta,
    frames: Vec<Vec<reco_core::detect::detector::Detection>>,
    path: Option<Vec<[f32; 3]>>,
}

fn read_report(zip: &Path) -> Result<Report, String> {
    let dir = std::env::temp_dir().join(format!("veoclone-ai-report-{}", crate::store::new_id()));
    let result = (|| {
        crate::unzip::extract(zip, PREFIX, &dir)?;
        let read = |name: &str| std::fs::read(dir.join(name)).map_err(|e| format!("{name}: {e}"));
        let settings: ReportSettings = serde_json::from_slice(&read("settings.json")?)
            .map_err(|e| format!("settings.json: {e}"))?;
        let cal = MatchCalibration::from_file(&dir.join("match.json"))
            .map_err(|e| format!("match.json: {e}"))?;
        let seen: SeenMeta = serde_json::from_slice(&read(crate::seen::SEEN_META)?)
            .map_err(|e| format!("ai_seen.json: {e}"))?;
        let frames = crate::seen::read_frames(&dir.join(crate::seen::SEEN_DATA))
            .map_err(|e| e.to_string())?;
        let path = read("ai_path.bin")
            .ok()
            .and_then(|b| crate::ai::decode_path(&b));
        Ok(Report {
            settings,
            cal,
            seen,
            frames,
            path,
        })
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

/// The settings a re-run of the report's match uses.
fn repan_settings(s: &ReportSettings, style: Style) -> RepanSettings {
    RepanSettings {
        style,
        every: s.ai_accuracy.interval(),
        roi: s.pitch.as_ref().map(|p| p.field_roi()),
        widest: s.widest_view,
    }
}

/// The camera path of a style from the report, as the helper makes it.
fn camera(
    r: &Report,
    style: Style,
    cfg: &BrainConfig,
) -> Result<(Vec<[f32; 3]>, Option<brain::Plan>), String> {
    let settings = repan_settings(&r.settings, style);
    let (plan, _) = brain::follow(&r.cal, &r.seen, &r.frames, &settings, cfg)?;
    if style.uses_brain() {
        return Ok((plan.path.clone(), Some(plan)));
    }
    let (poses, _) = crate::seen::repan(&r.cal, &r.seen, &r.frames, &settings)?;
    Ok((
        crate::ai::fill_path(&poses, r.seen.frames as usize),
        Some(plan),
    ))
}

/// Read a truth file: frame → world yaw/pitch of the ball.
fn read_truth(path: &Path, cal: &MatchCalibration) -> Result<Vec<(usize, [f32; 2])>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let scene = SceneGeometry::from_layout_with_aspect(
        &cal.layout,
        cal.left.width as f32 / cal.left.height as f32,
    );
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let cols: Vec<&str> = line.split(',').map(str::trim).collect();
        if cols.len() < 4 || cols[0].parse::<usize>().is_err() {
            continue; // the header, or an empty line
        }
        let bad = || format!("{}: line {} is not frame,camera,x,y", path.display(), i + 1);
        let frame: usize = cols[0].parse().map_err(|_| bad())?;
        let camera = match cols[1] {
            "left" | "0" => CameraId::Left,
            "right" | "1" => CameraId::Right,
            _ => return Err(bad()),
        };
        let x: f32 = cols[2].parse().map_err(|_| bad())?;
        let y: f32 = cols[3].parse().map_err(|_| bad())?;
        if let Some(p) = reco_core::projection::camera_to_panorama(camera, x, y, cal, &scene) {
            out.push((frame, [p.yaw, p.pitch]));
        }
    }
    Ok(out)
}

/// How well a path shows the ball: the camera as the editor shows it (the
/// widest view's limit, then the clamp), against where the ball was.
fn score(
    path: &[[f32; 3]],
    truth: &[(usize, [f32; 2])],
    cov: &CoverageBoundary,
    widest: WidestView,
) -> Value {
    let aspect = 16.0 / 9.0;
    let cap = widest
        .max_fov_deg()
        .unwrap_or(f32::INFINITY)
        .min(cov.max_fov_degrees());
    let mut err: Vec<f32> = Vec::new();
    let mut inside = 0usize;
    for &(f, b) in truth {
        let Some(p) = path.get(f) else { continue };
        let fov = p[2].min(cap);
        let c = cov.safe_clamp(p[0], p[1], fov, aspect, 0.0);
        let v = (fov / 2.0).to_radians();
        let h = (aspect * v.tan()).atan();
        let (dy, dp) = ((b[0] - c.yaw) * b[1].cos(), b[1] - c.pitch);
        err.push(dy.abs().to_degrees());
        if dy.abs() < h && dp.abs() < v {
            inside += 1;
        }
    }
    let n = err.len().max(1) as f32;
    let mut sorted = err.clone();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let q = |x: f32| {
        sorted
            .get(((sorted.len().max(1) - 1) as f32 * x).round() as usize)
            .copied()
            .unwrap_or(0.0)
    };
    json!({
        "frames": err.len(),
        "ballInPicture": inside as f32 / n,
        "yawErrorDeg": { "mean": err.iter().sum::<f32>() / n, "median": q(0.5), "p95": q(0.95), "max": q(1.0) },
    })
}

/// `--ai-report`: run the camera again from a report, print what came out
/// (JSON), write the CSV.
pub fn tool(args: &ToolArgs) -> Result<Value, String> {
    let r = read_report(&args.report)?;
    let mut cfg = BrainConfig::default();
    if let Some(p) = &args.brain_config {
        let text = std::fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?;
        cfg = serde_json::from_slice(&text).map_err(|e| format!("{}: {e}", p.display()))?;
    }
    cfg.check()?;
    let style = args.style.unwrap_or(r.settings.style);
    let started = std::time::Instant::now();
    let (path, plan) = camera(&r, style, &cfg)?;
    let secs = started.elapsed().as_secs_f64();
    let mut out = json!({
        "style": style,
        "aiAccuracy": r.settings.ai_accuracy,
        "widestView": r.settings.widest_view,
        "frames": path.len(),
        "seconds": secs,
        "brainConfig": cfg,
        "ball": plan.as_ref().map(|p| p.stats),
        "reportBall": r.settings.ai_run.as_ref().and_then(|a| a.ball),
    });
    if let Some(saved) = &r.path {
        let same_style = style == r.settings.style;
        out["sameAsReport"] = json!({
            "comparable": same_style,
            "maxDifference": crate::seen::max_difference(&path, saved),
        });
    }
    let truth = match &args.truth {
        Some(t) => Some(read_truth(t, &r.cal)?),
        None => None,
    };
    if let Some(truth) = &truth {
        let cov = CoverageBoundary::from_calibration(
            &r.cal,
            &SceneGeometry::from_layout_with_aspect(
                &r.cal.layout,
                r.cal.left.width as f32 / r.cal.left.height as f32,
            ),
        );
        let mut scores = serde_json::Map::new();
        scores.insert(
            format!("{style:?}"),
            score(&path, truth, &cov, r.settings.widest_view),
        );
        // The other cameras on the same recording, for comparison: Reco's
        // ball mode (VeoClone's "Follow the ball" before the brain), Reco's
        // broadcast camera, and that camera given the brain's ball track
        // instead of Reco's ball tracker.
        for other in [Style::Ball, Style::Broadcast] {
            let settings = repan_settings(&r.settings, other);
            if let Ok((poses, _)) = crate::seen::repan(&r.cal, &r.seen, &r.frames, &settings) {
                let p = crate::ai::fill_path(&poses, r.seen.frames as usize);
                let name = if other == Style::Ball {
                    "RecoBallMode"
                } else {
                    "RecoBroadcast"
                };
                scores.insert(name.into(), score(&p, truth, &cov, r.settings.widest_view));
            }
        }
        if let Some(plan) = &plan {
            let settings = repan_settings(&r.settings, Style::Broadcast);
            if let Ok((poses, _)) =
                crate::seen::repan_with_ball(&r.cal, &r.seen, &r.frames, &settings, &plan.ball)
            {
                let p = crate::ai::fill_path(&poses, r.seen.frames as usize);
                scores.insert(
                    "RecoBroadcastWithBrainBall".into(),
                    score(&p, truth, &cov, r.settings.widest_view),
                );
            }
        }
        out["truth"] = Value::Object(scores);
    }
    if let Some(csv) = &args.csv {
        let mut text = String::from(
            "frame,yaw,pitch,fov,ball_yaw,ball_pitch,ball_weight,truth_yaw,truth_pitch\n",
        );
        let truth_at: std::collections::HashMap<usize, [f32; 2]> =
            truth.iter().flatten().copied().collect();
        for (f, p) in path.iter().enumerate() {
            let b = plan.as_ref().and_then(|x| x.ball[f]);
            let w = plan.as_ref().map_or(0.0, |x| x.weight[f]);
            let t = truth_at.get(&f);
            let opt = |v: Option<f32>| v.map_or(String::new(), |v| format!("{v}"));
            text += &format!(
                "{f},{},{},{},{},{},{w},{},{}\n",
                p[0],
                p[1],
                p[2],
                opt(b.map(|b| b[0])),
                opt(b.map(|b| b[1])),
                opt(t.map(|t| t[0])),
                opt(t.map(|t| t[1])),
            );
        }
        std::fs::write(csv, text).map_err(|e| format!("{}: {e}", csv.display()))?;
        out["csv"] = json!(csv);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zip_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let big: Vec<u8> = (0..100_000u32)
            .flat_map(|i| (i % 251).to_le_bytes())
            .collect();
        let files = vec![
            (format!("{PREFIX}a.json"), br#"{"x": 1}"#.as_slice()),
            (format!("{PREFIX}b.bin.gz"), big.as_slice()),
        ];
        let zip_path = tmp.path().join("r.zip");
        std::fs::write(&zip_path, zip(&files).unwrap()).unwrap();
        let names = crate::unzip::extract(&zip_path, PREFIX, &tmp.path().join("out")).unwrap();
        assert_eq!(names, vec!["a.json", "b.bin.gz"]);
        assert_eq!(std::fs::read(tmp.path().join("out/b.bin.gz")).unwrap(), big);
        assert_eq!(
            std::fs::read(tmp.path().join("out/a.json")).unwrap(),
            br#"{"x": 1}"#
        );
        assert!(file_name().starts_with("veoclone-ai-report-20") && file_name().ends_with(".zip"));
    }

    /// A match folder with a recording, its "Follow the ball" path and the
    /// calibration: the report holds them without the match's name, and the
    /// dev tool makes exactly the same path from it.
    #[test]
    fn report_reproduces_the_path() {
        use crate::seen::{Classes, SeenWriter};
        use reco_core::detect::detector::Detection;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("project");
        std::fs::create_dir_all(&dir).unwrap();
        let mut meta = crate::store::tests::sample("abc");
        meta.style = Style::Ball;
        meta.widest_view = Some(WidestView::Natural);
        assert!(matches!(
            build(&dir, &meta, "test"),
            Err(ReportError::Missing(_))
        ));

        let classes = Classes {
            person: Some(0),
            ball: 32,
            roi_person: 0,
        };
        let mut w = SeenWriter::create(&dir.join(crate::seen::SEEN_DATA), classes).unwrap();
        let det = |class_id: u16, conf: f32, x: f32, y: f32| Detection {
            camera: CameraId::Left,
            class_id,
            confidence: conf,
            center_x: x,
            center_y: y,
            width: 0.01,
            height: if class_id == 0 { 0.08 } else { 0.015 },
        };
        let ball_x = |i: usize| 0.3 + 0.4 * i as f32 / 240.0;
        for i in 0..240 {
            let mut found: Vec<Detection> = (0..8)
                .map(|k| det(0, 0.6, 0.3 + 0.05 * k as f32, 0.6))
                .collect();
            if i % 4 != 0 {
                found.push(det(32, 0.4, ball_x(i), 0.62));
            }
            found.push(det(32, 0.35, 0.1, 0.8)); // a mark on the grass
            w.record(CameraId::Left, &found);
            w.record(CameraId::Right, &[]);
        }
        w.finish().unwrap();
        let seen = SeenMeta {
            version: crate::seen::VERSION,
            model: "m.onnx".into(),
            model_bytes: 1,
            classes,
            fps: 30.0,
            lookahead_frames: 45,
            every: 1,
            frames: 240,
            sync_offset: 0,
        };
        std::fs::write(
            dir.join(crate::seen::SEEN_META),
            serde_json::to_vec(&seen).unwrap(),
        )
        .unwrap();
        std::fs::write(dir.join("match.json"), crate::calib::tests::SYNTH_MATCH).unwrap();
        let cal: MatchCalibration = serde_json::from_str(crate::calib::tests::SYNTH_MATCH).unwrap();
        let frames = crate::seen::read_frames(&dir.join(crate::seen::SEEN_DATA)).unwrap();
        let settings = RepanSettings {
            style: Style::Ball,
            every: 1,
            roi: None,
            widest: WidestView::Natural,
        };
        let (plan, _) =
            brain::follow(&cal, &seen, &frames, &settings, &BrainConfig::default()).unwrap();
        std::fs::write(dir.join("ai_path.bin"), crate::ai::encode_path(&plan.path)).unwrap();
        std::fs::write(
            dir.join("edits.json"),
            br#"{"straighten":{"tiltDeg":4,"rollDeg":0}}"#,
        )
        .unwrap();

        let bytes = build(&dir, &meta, "test").unwrap();
        let zip_path = tmp.path().join("report.zip");
        std::fs::write(&zip_path, &bytes).unwrap();
        let out = tmp.path().join("out");
        let names = crate::unzip::extract(&zip_path, PREFIX, &out).unwrap();
        assert_eq!(
            names,
            [
                "README.txt",
                "ai_path.bin",
                "ai_seen.bin.gz",
                "ai_seen.json",
                "match.json",
                "settings.json"
            ]
        );
        let text = std::fs::read_to_string(out.join("settings.json")).unwrap();
        assert!(!text.contains("Saturday"), "no match name: {text}");
        let s: ReportSettings = serde_json::from_str(&text).unwrap();
        assert_eq!((s.style, s.widest_view), (Style::Ball, WidestView::Natural));
        assert_eq!(s.straighten, Some(json!({"tiltDeg": 4, "rollDeg": 0})));

        // The ball's true place, for the score.
        let truth = tmp.path().join("truth.csv");
        let rows: String = (0..240)
            .map(|i| format!("{i},left,{},0.62\n", ball_x(i)))
            .collect();
        std::fs::write(&truth, format!("frame,camera,x,y\n{rows}")).unwrap();
        let csv = tmp.path().join("path.csv");
        let args = ToolArgs {
            report: zip_path.clone(),
            csv: Some(csv.clone()),
            truth: Some(truth),
            ..Default::default()
        };
        let res = tool(&args).unwrap();
        assert_eq!(
            res["sameAsReport"]["maxDifference"],
            json!([0.0, 0.0, 0.0]),
            "{res}"
        );
        assert_eq!(res["ball"]["rejectedStatic"], 240, "{res}");
        let score = &res["truth"]["Ball"];
        assert!(score["ballInPicture"].as_f64().unwrap() > 0.95, "{res}");
        assert!(res["truth"]["RecoBallMode"]["frames"] == 240, "{res}");
        let lines = std::fs::read_to_string(&csv).unwrap();
        assert_eq!(lines.lines().count(), 241);
        assert!(lines.starts_with("frame,yaw,pitch,fov,ball_yaw"));

        // Other brain settings change the path.
        let tune = tmp.path().join("tune.json");
        std::fs::write(&tune, br#"{"ballHeight": 0.5, "playerPull": 0}"#).unwrap();
        let res = tool(&ToolArgs {
            report: zip_path.clone(),
            brain_config: Some(tune.clone()),
            ..Default::default()
        })
        .unwrap();
        assert_ne!(res["sameAsReport"]["maxDifference"], json!([0.0, 0.0, 0.0]));
        std::fs::write(&tune, br#"{"ballHieght": 0.5}"#).unwrap();
        assert!(
            tool(&ToolArgs {
                report: zip_path,
                brain_config: Some(tune),
                ..Default::default()
            })
            .is_err()
        );
    }
}
