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
  /**
   * Where the centre of the picture looks (an "aim", rigtilt.ts): the world
   * pose without rig tilt/roll. Kept when the straightening changes.
   */
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

export type OverlayKind = "title" | "player" | "text";
export type OverlayPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "center"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";
export type OverlaySize = "small" | "medium" | "large";

/** A text box shown on the video (DESIGN.md 5.4). */
export interface Overlay {
  id: string;
  /** Only affects the defaults when it is added. */
  kind: OverlayKind;
  /** May contain line breaks, at most 200 characters. */
  text: string;
  position: OverlayPosition;
  size: OverlaySize;
  /** Synced frames, end exclusive. */
  start: number;
  end: number;
}

/**
 * "Straighten picture" (DESIGN.md 5.5): Reco's rig tilt and roll in degrees,
 * used instead of match.json's for the preview and the export. The default is
 * match.json's: 0/0 for iPhones (no level sensor in the video), a GoPro's or
 * DJI's own level from its accelerometer.
 */
export interface Straighten {
  /** Rig tilt: how far the phones pointed down (positive) or up (negative). -35..35. */
  tiltDeg: number;
  /** Rig roll: how far the phones lean to the right (positive) or left (negative). -25..25. */
  rollDeg: number;
}

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
  /** Text boxes, drawn in this order (later ones on top). */
  overlays: Overlay[];
  /** Rig tilt/roll for the preview and the export. */
  straighten: Straighten;
  export: { width: number; height: number; quality: ExportQuality };
}

export type Vec3 = [number, number, number];
