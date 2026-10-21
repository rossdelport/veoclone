//! Lens profiles (iPhone list for the "Which iPhone filmed this?" question)
//! and the `CalibInfo` the editor needs to draw exactly what Reco renders.

use reco_calibrate::lens_database::LensDatabase;
use reco_calibrate::types::LensProfileSummary;
use reco_core::calibration::{CameraParams, MatchCalibration};
use reco_core::projection::CoverageBoundary;
use reco_core::render::scene::SceneGeometry;
use serde::Serialize;
use serde_json::{Value, json};

use crate::store::Fps;

/// Render constants shared with the editor (DESIGN.md section 3).
pub const BLEND_WIDTH: f32 = 0.15;
pub const LENS_CORRECTION: f32 = 1.0;
pub const OUTPUT_ASPECT: f32 = 16.0 / 9.0;
const SLICES: usize = 400;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Lens {
    pub id: String,
    pub label: String,
    pub width: u32,
    pub height: u32,
}

/// Database camera names are stored lower-case and title-cased on the way
/// out ("Apple Iphone 15 Pro"); put Apple's spelling back.
fn tidy_model(camera: &str) -> String {
    let model = camera.strip_prefix("Apple ").unwrap_or(camera);
    model
        .split_whitespace()
        .map(|w| match w.to_ascii_lowercase().as_str() {
            "iphone" => "iPhone".to_string(),
            "ipad" => "iPad".to_string(),
            "pro" => "Pro".to_string(),
            "max" => "Max".to_string(),
            "mini" => "mini".to_string(),
            "plus" => "Plus".to_string(),
            _ => w.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn resolution_name(w: u32, h: u32) -> String {
    match (w, h) {
        (3840, 2160) => "4K".into(),
        (1920, 1080) => "1080p".into(),
        (1280, 720) => "720p".into(),
        _ => format!("{w}x{h}"),
    }
}

/// Phone generation used to sort newest first (X/XR/XS count as 10).
fn generation(model: &str) -> u32 {
    let lower = model.to_ascii_lowercase();
    let rest = lower.strip_prefix("iphone").unwrap_or("").trim_start();
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    // Real iPhone generations only; junk entries such as "iPhone 26mm" sort last.
    if let Ok(n) = digits.parse::<u32>() {
        return if (3..=20).contains(&n) { n } else { 0 };
    }
    if rest.starts_with('x') {
        10
    } else if rest.starts_with("se") {
        9
    } else {
        0
    }
}

fn lens_id(s: &LensProfileSummary) -> String {
    format!("{}|{}|{}x{}", s.camera, s.lens, s.width, s.height)
}

fn label(s: &LensProfileSummary) -> String {
    let mut parts = vec![tidy_model(&s.camera)];
    if !s.lens.trim().is_empty() {
        parts.push(s.lens.trim().to_string());
    }
    parts.push(resolution_name(s.width, s.height));
    parts.join(" · ")
}

/// Every Apple profile in Reco's embedded lens database, newest phone first,
/// one entry per label.
pub fn iphone_lenses() -> &'static [Lens] {
    static LENSES: std::sync::OnceLock<Vec<Lens>> = std::sync::OnceLock::new();
    LENSES.get_or_init(|| lenses_from(LensDatabase::embedded().iter_profiles()))
}

/// Profiles for add-on lenses or other cameras of the phone, which would
/// give a wrong picture for the normal back camera.
const NOT_MAIN_CAMERA: [&str; 7] = [
    "anamorphic",
    "cinemorphic",
    "sirui",
    "magnet",
    "telephoto",
    "前置",
    "front",
];

fn lenses_from(profiles: impl Iterator<Item = LensProfileSummary>) -> Vec<Lens> {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<((u32, String, String, u32), Lens)> = Vec::new();
    for s in profiles {
        let text = format!("{} {}", s.camera, s.lens).to_lowercase();
        let aspect = s.width as f64 / s.height.max(1) as f64;
        // Phone video is 16:9; other shapes cannot be scaled to it.
        if !text.starts_with("apple ")
            || (aspect - 16.0 / 9.0).abs() > 0.02
            || NOT_MAIN_CAMERA.iter().any(|w| text.contains(w))
        {
            continue;
        }
        let lens = Lens {
            id: lens_id(&s),
            label: label(&s),
            width: s.width,
            height: s.height,
        };
        if seen.insert(lens.label.to_lowercase()) {
            let model = tidy_model(&s.camera);
            // Newest phone first, then by model, plain profiles before
            // named ones, bigger video first.
            let key = (
                u32::MAX - generation(&model),
                model.to_lowercase(),
                s.lens.trim().to_lowercase(),
                u32::MAX - s.width,
            );
            out.push((key, lens));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out.into_iter().map(|(_, l)| l).collect()
}

/// Load a profile by its id and scale it to the video size the way reco-gui
/// does when a lens is picked. Returns the params and a readable name.
pub fn lens_params(id: &str, width: u32, height: u32) -> Option<(CameraParams, String)> {
    let mut it = id.rsplitn(3, '|');
    let (res, lens, camera) = (it.next()?, it.next()?, it.next()?);
    let (pw, ph) = res.split_once('x')?;
    let summary = LensProfileSummary {
        camera: camera.to_string(),
        lens: lens.to_string(),
        width: pw.parse().ok()?,
        height: ph.parse().ok()?,
    };
    let p = LensDatabase::embedded().load_by_summary(&summary)?;
    let (sx, sy) = (
        width as f64 / p.width as f64,
        height as f64 / p.height as f64,
    );
    let scaled = CameraParams {
        width,
        height,
        fx: p.fx * sx,
        fy: p.fy * sy,
        cx: p.cx * sx,
        cy: p.cy * sy,
        d: p.d,
    };
    Some((scaled, label(&summary)))
}

/// Pitch-indexed table of the yaw range with picture, exactly as Reco's
/// `CoverageBoundary` sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub pitch_min: f32,
    pub pitch_max: f32,
    pub max_fov_deg: f32,
    pub slices: Vec<[f32; 2]>,
}

pub fn coverage(cal: &MatchCalibration) -> Coverage {
    let aspect = cal.left.width as f32 / cal.left.height as f32;
    let scene = SceneGeometry::from_layout_with_aspect(&cal.layout, aspect);
    let cov = CoverageBoundary::from_calibration(cal, &scene);
    // `yaw_range_at` interpolates with t*(n-1), so sampling at these exact
    // pitches returns Reco's own 400 rows.
    let slices = (0..SLICES)
        .map(|i| {
            let t = i as f32 / (SLICES - 1) as f32;
            let (lo, hi) = cov.yaw_range_at(cov.pitch_min + t * (cov.pitch_max - cov.pitch_min));
            [lo, hi]
        })
        .collect();
    Coverage {
        pitch_min: cov.pitch_min,
        pitch_max: cov.pitch_max,
        max_fov_deg: cov.max_fov_degrees(),
        slices,
    }
}

/// The `GET /calibration` document (stored as calib.json).
pub fn calib_info(
    match_json: &Value,
    fps: Fps,
    frame_count: u64,
    tile: (u32, u32),
    project_id: &str,
) -> Result<Value, String> {
    let cal: MatchCalibration =
        serde_json::from_value(match_json.clone()).map_err(|e| e.to_string())?;
    Ok(json!({
        "fps": fps,
        "frameCount": frame_count,
        "proxy": {
            "url": format!("/api/projects/{project_id}/proxy.mp4"),
            "tileWidth": tile.0,
            "tileHeight": tile.1,
            "layout": "vstack",
        },
        "match": match_json,
        "coverage": coverage(&cal),
        "render": {
            "blendWidth": BLEND_WIDTH,
            "lensCorrection": LENS_CORRECTION,
            "outputAspect": OUTPUT_ASPECT,
        },
    }))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub const SYNTH_MATCH: &str = r#"{
      "left_uniforms": {"width":1280,"height":720,"fx":616.39,"fy":615.41,"cx":642.38,"cy":356.44,
        "d":[0.4054,-0.38195,1.19412,-0.86433]},
      "right_uniforms": {"width":1280,"height":720,"fx":616.39,"fy":615.41,"cx":642.38,"cy":356.44,
        "d":[0.4054,-0.38195,1.19412,-0.86433]},
      "params": {"cameraAxisOffset":0.3,"intersect":0.6218,"xTy":-0.0467,"xRz":-0.1302,
        "zRx":-0.1079,"xRx":0.0,"zRz":0.0},
      "rig_tilt":0.0,"rig_roll":0.0,"sync_offset":12,"field_roi":null,
      "lens_correction_amount":1.0,"blend_width":0.05
    }"#;

    #[test]
    fn coverage_table_is_sane() {
        let cal: MatchCalibration = serde_json::from_str(SYNTH_MATCH).unwrap();
        let c = coverage(&cal);
        assert_eq!(c.slices.len(), 400);
        assert!(c.pitch_min < 0.0 && c.pitch_max > 0.0);
        assert!(c.max_fov_deg > 5.0 && c.max_fov_deg < 120.0);
        let mid = c.slices[200];
        assert!(mid[0] < 0.0 && mid[1] > 0.0, "{mid:?}");
        // Matches Reco's own lookup at an arbitrary pitch between rows.
        let scene = SceneGeometry::from_layout_with_aspect(&cal.layout, 1280.0 / 720.0);
        let cov = CoverageBoundary::from_calibration(&cal, &scene);
        let row = 123;
        let p = c.pitch_min + row as f32 / 399.0 * (c.pitch_max - c.pitch_min);
        let (lo, hi) = cov.yaw_range_at(p);
        assert!((lo - c.slices[row][0]).abs() < 1e-5 && (hi - c.slices[row][1]).abs() < 1e-5);
    }

    #[test]
    fn calib_info_shape() {
        let m: Value = serde_json::from_str(SYNTH_MATCH).unwrap();
        let v = calib_info(&m, Fps { num: 30, den: 1 }, 588, (1280, 720), "abc").unwrap();
        assert_eq!(v["fps"], json!({"num":30,"den":1}));
        assert_eq!(v["frameCount"], 588);
        assert_eq!(v["proxy"]["url"], "/api/projects/abc/proxy.mp4");
        assert_eq!(v["proxy"]["layout"], "vstack");
        assert_eq!(v["match"]["sync_offset"], 12);
        assert_eq!(v["coverage"]["slices"].as_array().unwrap().len(), 400);
        assert!(v["coverage"]["maxFovDeg"].as_f64().unwrap() > 0.0);
        assert!((v["render"]["blendWidth"].as_f64().unwrap() - 0.15).abs() < 1e-6);
        assert!((v["render"]["outputAspect"].as_f64().unwrap() - 16.0 / 9.0).abs() < 1e-6);
    }

    #[test]
    fn iphone_list() {
        let lenses = iphone_lenses();
        assert!(lenses.len() > 50, "{}", lenses.len());
        assert_eq!(lenses[0].label, "iPhone 15 · 4K", "{:?}", &lenses[..5]);
        assert!(lenses.iter().all(|l| !l.label.contains("Anamorphic")));
        assert!(
            lenses
                .iter()
                .all(|l| (l.width as f64 / l.height as f64 - 16.0 / 9.0).abs() <= 0.02)
        );
        let labels: std::collections::HashSet<_> =
            lenses.iter().map(|l| l.label.to_lowercase()).collect();
        assert_eq!(labels.len(), lenses.len());
        assert!(
            lenses
                .iter()
                .all(|l| l.label.starts_with("iPhone") || l.label.starts_with("iPad")),
            "{lenses:?}"
        );
        // Ids load back, scaled to the footage size.
        let l = lenses.iter().find(|l| l.width == 3840).unwrap();
        let (p, name) = lens_params(&l.id, 1920, 1080).unwrap();
        assert_eq!((p.width, p.height), (1920, 1080));
        assert!(p.fx > 100.0 && p.cx > 800.0 && p.cx < 1100.0, "{p:?}");
        assert_eq!(name, l.label);
        assert!(lens_params("nonsense", 1920, 1080).is_none());
    }

    #[test]
    fn sorting_helpers() {
        assert_eq!(tidy_model("Apple Iphone 15 Pro Max"), "iPhone 15 Pro Max");
        assert_eq!(generation("iPhone 15 Pro"), 15);
        assert_eq!(generation("iPhone 13pro"), 13);
        assert_eq!(generation("iPhone Xs"), 10);
        assert_eq!(generation("iPad Pro 11-inch (2020)"), 0);
        assert_eq!(generation("iPhone 26mm"), 0);
    }
}
