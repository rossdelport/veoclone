//! AI tracking support: checking the ONNX runtime and model, recording the
//! AI camera path, and the path file format shared with the editor.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use reco_core::detect::pipeline_event::{PipelineEvent, PipelineEventSink};
use serde::Serialize;

/// Set by the logging layer when ort reports that DirectML registered.
pub static DIRECTML_REGISTERED: AtomicBool = AtomicBool::new(false);

/// FOV used when the AI never chose one (FieldPanner's default).
const DEFAULT_FOV: f32 = 40.0;

#[derive(Debug, Clone, Serialize)]
pub struct AiStatus {
    pub available: bool,
    pub provider: String,
    pub model: Option<String>,
}

/// The AI model: `--model` / `VEOCLONE_MODEL`, else `models/yolo26n.onnx`
/// next to the executable, else the faster 640 model.
pub fn find_model(explicit: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = explicit {
        return Some(p.to_path_buf());
    }
    let dir = crate::media::exe_dir()?.join("models");
    ["yolo26n.onnx", "yolo26n_640.onnx"]
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.is_file())
}

/// Load the ONNX runtime and the model once. Fails fast with a plain
/// message instead of after a long video pass. Returns the provider that
/// will run the model: "DirectML" only if ort really registered it.
pub fn check(model: Option<&Path>) -> Result<String, (String, String)> {
    const BROKEN: &str = "The AI ball tracking could not start because some of VeoClone's \
                          files are missing or damaged. Please download VeoClone again.";
    let model = model.ok_or_else(|| (BROKEN.to_string(), "no AI model file found".to_string()))?;
    reco_autocam::validate_model_path(model).map_err(|e| (BROKEN.to_string(), e.to_string()))?;
    reco_detect::ort_session::ort_runtime_available().map_err(|e| (BROKEN.to_string(), e))?;
    DIRECTML_REGISTERED.store(false, Ordering::SeqCst);
    let result = std::panic::catch_unwind(|| reco_detect::create_ort_session(model, Vec::new()));
    match result {
        Ok(Ok(_session)) => Ok(if DIRECTML_REGISTERED.load(Ordering::SeqCst) {
            "DirectML".into()
        } else {
            "CPU".into()
        }),
        Ok(Err(e)) => Err((BROKEN.into(), format!("{}: {e}", model.display()))),
        Err(_) => Err((BROKEN.into(), "loading the AI model crashed".into())),
    }
}

pub fn status(model: Option<&Path>) -> AiStatus {
    let name = model.map(|m| {
        m.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    });
    match check(model) {
        Ok(provider) => AiStatus {
            available: true,
            provider,
            model: name,
        },
        Err((_, detail)) => {
            log::warn!("AI not available: {detail}");
            AiStatus {
                available: false,
                provider: "none".into(),
                model: name,
            }
        }
    }
}

/// Keeps only the smoothed world-space pose of every `PanDecision`
/// (the full event stream would be gigabytes for a whole match).
pub struct PoseSink {
    pub poses: Arc<Mutex<Vec<Option<[f32; 3]>>>>,
    /// Ignore absurd frame numbers instead of allocating for them.
    pub max_frames: usize,
}

impl PipelineEventSink for PoseSink {
    fn emit(&mut self, event: PipelineEvent) {
        if let PipelineEvent::PanDecision { frame_index, pose } = event {
            let i = frame_index as usize;
            if i >= self.max_frames {
                return;
            }
            let mut poses = self.poses.lock().unwrap_or_else(|e| e.into_inner());
            if poses.len() <= i {
                poses.resize(i + 1, None);
            }
            poses[i] = Some([pose.yaw, pose.pitch, pose.fov_degrees.unwrap_or(f32::NAN)]);
        }
    }
}

/// One pose per frame: missing frames (and a missing FOV) hold the previous
/// value; frames before the first decision use the first one.
pub fn fill_path(poses: &[Option<[f32; 3]>], frame_count: usize) -> Vec<[f32; 3]> {
    let first = poses.iter().flatten().next().copied();
    let mut last = first.unwrap_or([0.0, 0.0, DEFAULT_FOV]);
    if !last[2].is_finite() {
        last[2] = poses
            .iter()
            .flatten()
            .map(|p| p[2])
            .find(|f| f.is_finite())
            .unwrap_or(DEFAULT_FOV);
    }
    (0..frame_count)
        .map(|i| {
            if let Some(Some(p)) = poses.get(i) {
                let fov = if p[2].is_finite() { p[2] } else { last[2] };
                if p[0].is_finite() && p[1].is_finite() {
                    last = [p[0], p[1], fov];
                }
            }
            last
        })
        .collect()
}

/// Float32 little-endian `[yaw, pitch, fov]` per frame (ai_path.bin and the
/// export request's `pathBase64`).
pub fn encode_path(path: &[[f32; 3]]) -> Vec<u8> {
    path.iter()
        .flat_map(|p| p.iter().flat_map(|v| v.to_le_bytes()))
        .collect()
}

pub fn decode_path(bytes: &[u8]) -> Option<Vec<[f32; 3]>> {
    if !bytes.len().is_multiple_of(12) {
        return None;
    }
    Some(
        bytes
            .chunks_exact(12)
            .map(|c| {
                let f = |i: usize| f32::from_le_bytes([c[i], c[i + 1], c[i + 2], c[i + 3]]);
                [f(0), f(4), f(8)]
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use reco_core::detect::director::ViewportPosition;

    #[test]
    fn sink_keeps_pan_decisions_only() {
        let poses = Arc::new(Mutex::new(Vec::new()));
        let mut sink = PoseSink {
            poses: poses.clone(),
            max_frames: 10,
        };
        let pose = |yaw| ViewportPosition {
            yaw,
            pitch: 0.1,
            fov_degrees: Some(30.0),
        };
        sink.emit(PipelineEvent::FrameStart {
            frame_index: 0,
            timestamp_ms: 0.0,
        });
        sink.emit(PipelineEvent::PanDecision {
            frame_index: 2,
            pose: pose(0.5),
        });
        sink.emit(PipelineEvent::PosePresented {
            frame_index: 3,
            pose: pose(9.0),
        });
        sink.emit(PipelineEvent::PanDecision {
            frame_index: 50,
            pose: pose(1.0),
        });
        let p = poses.lock().unwrap().clone();
        assert_eq!(p, vec![None, None, Some([0.5, 0.1, 30.0])]);
    }

    #[test]
    fn fill_holds_previous() {
        let p = vec![
            None,
            Some([0.1, 0.0, f32::NAN]),
            None,
            Some([0.2, 0.1, 35.0]),
            Some([0.3, 0.1, f32::NAN]),
        ];
        let f = fill_path(&p, 7);
        assert_eq!(f[0], [0.1, 0.0, 35.0]);
        assert_eq!(f[1], [0.1, 0.0, 35.0]);
        assert_eq!(f[2], [0.1, 0.0, 35.0]);
        assert_eq!(f[3], [0.2, 0.1, 35.0]);
        assert_eq!(f[4], [0.3, 0.1, 35.0]);
        assert_eq!(f[6], [0.3, 0.1, 35.0]);
        assert_eq!(fill_path(&[], 2), vec![[0.0, 0.0, 40.0]; 2]);
    }

    #[test]
    fn path_bytes_roundtrip() {
        let path = vec![[0.5, -0.25, 33.0], [1.0, 0.0, 20.0]];
        let b = encode_path(&path);
        assert_eq!(b.len(), 24);
        assert_eq!(&b[0..4], &0.5f32.to_le_bytes());
        assert_eq!(decode_path(&b).unwrap(), path);
        assert!(decode_path(&b[..5]).is_none());
    }
}
