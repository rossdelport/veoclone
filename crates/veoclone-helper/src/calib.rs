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

/// One answer to "Which iPhone filmed this?" (DESIGN.md 4.6).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LensOption {
    /// Stored as `ProjectMeta.lensId`, e.g. "iphone-15-pro:ultra".
    pub id: String,
    /// "iPhone 15 Pro", or "Not sure".
    pub model: String,
    /// "ultra" (0.5× ultra wide) or "main" (1×, normal).
    pub lens: &'static str,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip)]
    profile: Profile,
}

/// The lens of new matches.
pub const DEFAULT_LENS: &str = "generic:ultra";
const NOT_SURE: &str = "Not sure";

/// A 3840x2160 profile in Reco's lens database, and the phone it is for.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Profile {
    camera: &'static str,
    lens: &'static str,
    model: &'static str,
}

const fn profile(camera: &'static str, lens: &'static str, model: &'static str) -> Profile {
    Profile {
        camera,
        lens,
        model,
    }
}

impl Profile {
    fn load(&self, width: u32, height: u32) -> Option<CameraParams> {
        let summary = LensProfileSummary {
            camera: self.camera.into(),
            lens: self.lens.into(),
            width: 3840,
            height: 2160,
        };
        scaled(
            LensDatabase::embedded().load_by_summary(&summary)?,
            width,
            height,
        )
    }
}

// The database's ~160 Apple profiles are crowd-sourced, with unreliable
// names, so these were picked by their numbers: 4K and the stock Camera
// app. The stock app steadies video by cropping a little, which gives
// fx ≈ 0.44 × width for the Ultra Wide and ≈ 0.83 × width for the Main
// lens; profiles near 0.38 / 0.72 were made with steadying off (other
// camera apps). Log, ProRes, cinematic, telephoto, front, add-on lens and
// vertical profiles are left out.
const UW_11: Profile = profile("Apple IPhone 11", "ultra wide 13mm", "iPhone 11");
const UW_11_PRO_MAX: Profile = profile(
    "Apple IPhone 11 Pro Max",
    "Ultra Wide 13mm 0.5x",
    "iPhone 11 Pro Max",
);
const UW_12: Profile = profile("Apple IPhone 12", "0.5", "iPhone 12");
const UW_13_MINI: Profile = profile(
    "Apple IPhone 13 Mini",
    "ultra wide (dolby vision)",
    "iPhone 13 mini",
);
const UW_13_PRO: Profile = profile("Apple IPhone 13 Pro", "0.5x", "iPhone 13 Pro");
const UW_13_PRO_MAX: Profile = profile("Apple IPhone 13 Pro Max", "0.5 Wide", "iPhone 13 Pro Max");
const UW_14_PRO_MAX: Profile = profile("Apple IPhone 14 Pro Max", "", "iPhone 14 Pro Max");
const MAIN_11: Profile = profile("Apple IPhone 11", "wide 26mm", "iPhone 11");
const MAIN_11_PRO_MAX: Profile = profile(
    "Apple IPhone 11 Pro Max",
    "Wide 26mm 1x",
    "iPhone 11 Pro Max",
);
const MAIN_12_MINI: Profile = profile("Apple IPhone 12 Mini", "1x", "iPhone 12 mini");
const MAIN_12: Profile = profile("Apple IPhone 12", "1.0", "iPhone 12");
const MAIN_12_PRO: Profile = profile("Apple IPhone 12 Pro", "1 (Camera)", "iPhone 12 Pro");
const MAIN_12_PRO_MAX: Profile = profile("Apple IPhone 12 Pro Max", "1x", "iPhone 12 Pro Max");
const MAIN_13: Profile = profile("Apple IPhone 13", "1x", "iPhone 13");
const MAIN_13_PRO: Profile = profile("Apple IPhone 13 Pro", "Wide", "iPhone 13 Pro");
const MAIN_13_PRO_MAX: Profile =
    profile("Apple IPhone 13 Pro Max", "26mm (30)", "iPhone 13 Pro Max");
const MAIN_14: Profile = profile("Apple IPhone 14", "", "iPhone 14");
const MAIN_14_PRO: Profile = profile("Apple IPhone 14 Pro", "Main 24mm", "iPhone 14 Pro");
const MAIN_14_PRO_MAX: Profile = profile("Apple IPhone 14 Pro Max", "pro max", "iPhone 14 Pro Max");
const MAIN_15: Profile = profile("Apple IPhone 15", "", "iPhone 15");
const MAIN_15_PRO: Profile = profile("Apple IPhone 15 Pro", "24mm", "iPhone 15 Pro");
const MAIN_15_PRO_MAX: Profile = profile("Apple IPhone 15 Pro Max", "24mm", "iPhone 15 Pro Max");

/// Every iPhone with an Ultra Wide lens from the 11 on (plus the 16e and
/// Air, which only have the main lens), newest first, with the profiles for
/// its Ultra Wide and Main lens. Phones the database lacks borrow the
/// closest phone's: same lens generation, Pro with Pro.
const PHONES: [(&str, Profile, Profile); 28] = [
    ("iPhone 17 Pro Max", UW_14_PRO_MAX, MAIN_15_PRO_MAX),
    ("iPhone 17 Pro", UW_14_PRO_MAX, MAIN_15_PRO),
    ("iPhone Air", UW_14_PRO_MAX, MAIN_15),
    ("iPhone 17", UW_14_PRO_MAX, MAIN_15),
    ("iPhone 16e", UW_14_PRO_MAX, MAIN_15),
    ("iPhone 16 Pro Max", UW_14_PRO_MAX, MAIN_15_PRO_MAX),
    ("iPhone 16 Pro", UW_14_PRO_MAX, MAIN_15_PRO),
    ("iPhone 16 Plus", UW_14_PRO_MAX, MAIN_15),
    ("iPhone 16", UW_14_PRO_MAX, MAIN_15),
    ("iPhone 15 Pro Max", UW_14_PRO_MAX, MAIN_15_PRO_MAX),
    ("iPhone 15 Pro", UW_14_PRO_MAX, MAIN_15_PRO),
    ("iPhone 15 Plus", UW_13_MINI, MAIN_15),
    ("iPhone 15", UW_13_MINI, MAIN_15),
    ("iPhone 14 Pro Max", UW_14_PRO_MAX, MAIN_14_PRO_MAX),
    ("iPhone 14 Pro", UW_14_PRO_MAX, MAIN_14_PRO),
    ("iPhone 14 Plus", UW_13_MINI, MAIN_14),
    ("iPhone 14", UW_13_MINI, MAIN_14),
    ("iPhone 13 Pro Max", UW_13_PRO_MAX, MAIN_13_PRO_MAX),
    ("iPhone 13 Pro", UW_13_PRO, MAIN_13_PRO),
    ("iPhone 13", UW_13_MINI, MAIN_13),
    ("iPhone 13 mini", UW_13_MINI, MAIN_13),
    ("iPhone 12 Pro Max", UW_12, MAIN_12_PRO_MAX),
    ("iPhone 12 Pro", UW_12, MAIN_12_PRO),
    ("iPhone 12", UW_12, MAIN_12),
    ("iPhone 12 mini", UW_12, MAIN_12_MINI),
    ("iPhone 11 Pro Max", UW_11_PRO_MAX, MAIN_11_PRO_MAX),
    ("iPhone 11 Pro", UW_11_PRO_MAX, MAIN_11_PRO_MAX),
    ("iPhone 11", UW_11, MAIN_11),
];

/// Phones above without an Ultra Wide (0.5×) lens.
const NO_ULTRA_WIDE: [&str; 2] = ["iPhone Air", "iPhone 16e"];

/// "Not sure": a typical recent iPhone of each lens type (never Reco's
/// resolution-only fallback, which is an action camera).
const NOT_SURE_PROFILES: (&str, Profile, Profile) = (NOT_SURE, UW_14_PRO_MAX, MAIN_14);

/// All lens choices: "Not sure" first, then the iPhones newest first, each
/// with an Ultra Wide and a Main option.
pub fn lens_options() -> &'static [LensOption] {
    static OPTIONS: std::sync::OnceLock<Vec<LensOption>> = std::sync::OnceLock::new();
    OPTIONS.get_or_init(|| {
        let mut out = Vec::new();
        for (model, ultra, main) in std::iter::once(NOT_SURE_PROFILES).chain(PHONES) {
            let slug = if model == NOT_SURE {
                "generic".to_string()
            } else {
                model.to_lowercase().replace(' ', "-")
            };
            for (lens, name, profile) in [
                ("ultra", "Ultra wide (0.5×)", ultra),
                ("main", "Normal (1×)", main),
            ] {
                let note = if model == NOT_SURE {
                    Some(format!("Uses typical settings ({})", profile.model))
                } else if lens == "ultra" && NO_ULTRA_WIDE.contains(&model) {
                    Some(format!(
                        "This iPhone has no 0.5× lens; uses the {} settings",
                        profile.model
                    ))
                } else if profile.model != model {
                    Some(format!(
                        "Uses the {} settings (closest match)",
                        profile.model
                    ))
                } else {
                    None
                };
                out.push(LensOption {
                    id: format!("{slug}:{lens}"),
                    model: model.to_string(),
                    lens,
                    label: format!("{model} · {name}"),
                    note,
                    profile,
                });
            }
        }
        out
    })
}

pub fn is_lens_option(id: &str) -> bool {
    lens_options().iter().any(|o| o.id == id)
}

/// The lens settings for a match, scaled to its video size.
#[derive(Debug)]
pub struct LensChoice {
    pub params: CameraParams,
    /// Readable name for the calibration summary.
    pub name: String,
    /// Plain words for the match's warnings when the lens was guessed.
    pub warning: Option<String>,
}

/// The lens for `lens_id`: one of [`lens_options`], else an id from an
/// older VeoClone (a raw database profile) that still loads, else the
/// default with a warning. No lens (older matches) means "Not sure".
pub fn choose_lens(lens_id: Option<&str>, width: u32, height: u32) -> LensChoice {
    let id = lens_id.unwrap_or(DEFAULT_LENS);
    if let Some((params, name)) = lens_params(id, width, height) {
        return LensChoice {
            params,
            name,
            warning: None,
        };
    }
    let (option, warning) = match lens_options().iter().find(|o| o.id == id) {
        Some(o) if o.model == NOT_SURE => {
            let lens = if o.lens == "main" {
                "normal (1×)"
            } else {
                "ultra wide (0.5×)"
            };
            let warning = format!(
                "We didn't know which iPhone filmed this, so typical settings for an iPhone's \
                 {lens} lens were used. If the picture looks bent or the two halves don't \
                 join up, click “Change phone or lens” and pick your iPhone."
            );
            (o, Some(warning))
        }
        Some(o) => (o, None),
        None => (
            &lens_options()[0],
            Some(
                "The iPhone chosen for this match is no longer in the list, so typical \
                 settings for an iPhone's ultra wide (0.5×) lens were used. For the best \
                 result, click “Change phone or lens” and pick your iPhone."
                    .into(),
            ),
        ),
    };
    LensChoice {
        params: option
            .profile
            .load(width, height)
            .expect("every lens option loads (tested)"),
        name: option.label.clone(),
        warning,
    }
}

/// Scale a profile to the video size the way reco-gui does when a lens is
/// picked. `None` for a broken profile (one database entry has a negative
/// focal length).
fn scaled(p: CameraParams, width: u32, height: u32) -> Option<CameraParams> {
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
    let usable = [scaled.fx, scaled.fy, scaled.cx, scaled.cy]
        .iter()
        .chain(&scaled.d)
        .all(|v| v.is_finite())
        && scaled.fx > 0.0
        && scaled.fy > 0.0;
    usable.then_some(scaled)
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

/// The name older VeoClone versions showed for a raw database profile.
fn label(s: &LensProfileSummary) -> String {
    let mut parts = vec![tidy_model(&s.camera)];
    if !s.lens.trim().is_empty() {
        parts.push(s.lens.trim().to_string());
    }
    parts.push(resolution_name(s.width, s.height));
    parts.join(" · ")
}

/// Load a raw database profile by the id older VeoClone versions stored
/// ("camera|lens|WxH"), scaled to the video size. Returns the params and a
/// readable name.
fn lens_params(id: &str, width: u32, height: u32) -> Option<(CameraParams, String)> {
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
    Some((scaled(p, width, height)?, label(&summary)))
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
    fn lens_options_follow_design() {
        let options = lens_options();
        assert_eq!(options.len(), 2 * (PHONES.len() + 1));
        assert_eq!(options[0].id, DEFAULT_LENS);
        assert_eq!(options[0].label, "Not sure · Ultra wide (0.5×)");
        assert_eq!(options[1].id, "generic:main");
        assert_eq!(options[2].id, "iphone-17-pro-max:ultra");
        let o = options
            .iter()
            .find(|o| o.id == "iphone-15-pro:ultra")
            .unwrap();
        assert_eq!(
            (o.model.as_str(), o.lens, o.label.as_str()),
            (
                "iPhone 15 Pro",
                "ultra",
                "iPhone 15 Pro · Ultra wide (0.5×)"
            )
        );
        assert_eq!(
            o.note.as_deref(),
            Some("Uses the iPhone 14 Pro Max settings (closest match)")
        );
        let o = options
            .iter()
            .find(|o| o.id == "iphone-15-pro:main")
            .unwrap();
        assert_eq!(o.note, None);
        let o = options.iter().find(|o| o.id == "iphone-16e:ultra").unwrap();
        assert!(o.note.as_deref().unwrap().contains("no 0.5× lens"));
        assert!(options.iter().any(|o| o.id == "iphone-12-mini:main"));
        assert!(options.iter().any(|o| o.id == "iphone-air:main"));

        // Exactly one option per (model, lens), both lenses for every model.
        let ids: std::collections::HashSet<_> = options.iter().map(|o| &o.id).collect();
        assert_eq!(ids.len(), options.len());
        for pair in options.chunks(2) {
            assert_eq!(pair[0].model, pair[1].model);
            assert_eq!((pair[0].lens, pair[1].lens), ("ultra", "main"));
        }

        let v = serde_json::to_value(&options[2]).unwrap();
        let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["id", "model", "lens", "label", "note"]);
    }

    /// Every chosen profile loads and scales to 4K and 1080p, with the
    /// focal length of its lens type and a centred picture.
    #[test]
    fn every_lens_option_loads() {
        for o in lens_options() {
            for (w, h) in [(3840, 2160), (1920, 1080)] {
                let p = o
                    .profile
                    .load(w, h)
                    .unwrap_or_else(|| panic!("{} does not load: {:?}", o.id, o.profile));
                assert_eq!((p.width, p.height), (w, h));
                let f = p.fx / w as f64;
                let range = if o.lens == "ultra" {
                    0.42..0.46
                } else {
                    0.80..0.87
                };
                assert!(range.contains(&f), "{}: fx/width {f}", o.id);
                assert!((p.fy / p.fx - 1.0).abs() < 0.01, "{}", o.id);
                assert!((p.cx / w as f64 - 0.5).abs() < 0.03, "{}", o.id);
                assert!((p.cy / h as f64 - 0.5).abs() < 0.03, "{}", o.id);
            }
            let c = choose_lens(Some(&o.id), 1920, 1080);
            assert_eq!(c.name, o.label);
            assert_eq!(c.warning.is_some(), o.model == NOT_SURE, "{}", o.id);
        }
    }

    #[test]
    fn choosing_a_lens() {
        // "Not sure" is an iPhone lens, not Reco's resolution-only
        // fallback (an action camera).
        let (fallback, _) = LensDatabase::embedded()
            .find_by_resolution(3840, 2160)
            .unwrap();
        for id in [None, Some(DEFAULT_LENS)] {
            let c = choose_lens(id, 3840, 2160);
            assert_eq!(c.name, "Not sure · Ultra wide (0.5×)");
            assert!(c.warning.unwrap().contains("ultra wide (0.5×)"));
            assert_ne!(c.params.fx, fallback.fx);
        }
        let c = choose_lens(Some("generic:main"), 3840, 2160);
        assert!(c.warning.unwrap().contains("normal (1×)"));

        // Ids from older versions keep working while they load.
        let c = choose_lens(Some("Apple IPhone 15||3840x2160"), 1920, 1080);
        assert_eq!(c.name, "iPhone 15 · 4K");
        assert!(c.warning.is_none());
        assert!((c.params.fx - 3312.6 / 2.0).abs() < 1.0, "{:?}", c.params);
        // ...otherwise "Not sure" with a warning, also for the broken one.
        for id in ["nonsense", "Apple IPhone 15| (cinematic wide)|3840x2160"] {
            let c = choose_lens(Some(id), 1920, 1080);
            assert_eq!(c.name, "Not sure · Ultra wide (0.5×)");
            assert!(c.warning.unwrap().contains("no longer in the list"));
        }
        assert!(is_lens_option("iphone-11:ultra"));
        assert!(!is_lens_option("Apple IPhone 15||3840x2160"));
    }

    #[test]
    fn old_lens_names() {
        assert_eq!(tidy_model("Apple Iphone 15 Pro Max"), "iPhone 15 Pro Max");
    }
}
