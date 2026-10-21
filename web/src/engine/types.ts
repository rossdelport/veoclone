// Shared data types between the helper (see docs/veoclone/DESIGN.md) and the
// editor. Units: yaw/pitch in radians (positive yaw = pan LEFT, positive pitch
// = up), fov = vertical field of view in degrees.

export interface Fps {
  num: number;
  den: number;
}

export interface Pose {
  yaw: number;
  pitch: number;
  fov: number;
}

/** One camera's lens intrinsics, verbatim from Reco's match.json. */
export interface CameraUniforms {
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  /** KB4 fisheye coefficients k1..k4. */
  d: [number, number, number, number];
}

/** Reco's plane layout, verbatim from match.json `params`. */
export interface PlaneLayout {
  cameraAxisOffset: number;
  intersect: number;
  xTy: number;
  xRz: number;
  zRx: number;
  xRx: number;
  zRz: number;
}

/** Reco's MatchCalibration (match.json). */
export interface MatchCalibration {
  left_uniforms: CameraUniforms;
  right_uniforms: CameraUniforms;
  params: PlaneLayout;
  rig_tilt: number;
  rig_roll: number;
  sync_offset: number;
  field_roi: unknown;
  lens_correction_amount: number;
  blend_width: number;
}

export interface Coverage {
  pitchMin: number;
  pitchMax: number;
  maxFovDeg: number;
  /** 400 rows of [yawMin, yawMax], pitch from pitchMin to pitchMax inclusive. */
  slices: [number, number][];
}

export interface CalibInfo {
  fps: Fps;
  frameCount: number;
  proxy: { url: string; tileWidth: number; tileHeight: number; layout: "vstack" };
  match: MatchCalibration;
  coverage: Coverage;
  render: { blendWidth: number; lensCorrection: number; outputAspect: number };
}

export interface Keyframe {
  frame: number;
  yaw: number;
  pitch: number;
  /** Pre-zoom fov (the fov the user saw multiplied by the zoom at the time). */
  fov: number;
}

/** Keep-range in synced frames, end exclusive. */
export interface Segment {
  start: number;
  end: number;
}

export type ExportQuality = "fast" | "balanced" | "high";

export interface Edits {
  version: 1;
  segments: Segment[];
  keyframes: Keyframe[];
  /** 0.5..2, final fov = fov / zoom. */
  zoom: number;
  /** 0..5, extra smoothing of the AI path. */
  smoothSeconds: number;
  /** A fix holds fully this long before/after its keyframe(s). */
  holdSeconds: number;
  /** Then blends back to the AI over this long. */
  fadeSeconds: number;
  /** Keyframes closer than this are joined into one move. */
  joinSeconds: number;
  export: { width: number; height: number; quality: ExportQuality };
}

export type Vec3 = [number, number, number];
