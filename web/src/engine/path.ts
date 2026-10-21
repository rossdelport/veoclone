import type { CalibInfo, Edits, Keyframe, Pose } from "./types";

const TODO = (): never => {
  throw new Error("not implemented");
};

/** Edits for a fresh project: keep everything, no fixes, zoom 1. */
export function defaultEdits(frameCount: number): Edits {
  void frameCount;
  return TODO();
}

/** Fill missing/invalid fields of loaded edits with defaults (forward compatible). */
export function normalizeEdits(raw: unknown, frameCount: number): Edits {
  void raw; void frameCount;
  return TODO();
}

/**
 * The final camera path (DESIGN.md section 5.3): AI path + smoothing +
 * keyframe fixes + zoom + clamp. Returns frameCount*3 floats [yaw,pitch,fov].
 */
export function computeFinalPath(ai: Float32Array, calib: CalibInfo, edits: Edits): Float32Array {
  void ai; void calib; void edits;
  return TODO();
}

/** Pose at a frame of a path (clamped to the valid frame range). */
export function poseAt(path: Float32Array, frame: number): Pose {
  void path; void frame;
  return TODO();
}

/** A keyframe that reproduces `view` (what the user sees now) at `frame`. */
export function keyframeFromView(view: Pose, frame: number, zoom: number): Keyframe {
  void view; void frame; void zoom;
  return TODO();
}

/** Float32 little-endian bytes of a path, base64 encoded (export request). */
export function encodePathBase64(path: Float32Array): string {
  void path;
  return TODO();
}

/** Total kept frames of the segments (the export's length). */
export function keptFrameCount(edits: Edits): number {
  void edits;
  return TODO();
}
