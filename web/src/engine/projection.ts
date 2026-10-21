import type { CalibInfo, Pose, Vec3 } from "./types";

const TODO = (): never => {
  throw new Error("not implemented");
};

/** Precomputed geometry of a calibration (planes, eye, basis). */
export interface Rig {
  eye: Vec3;
  baseForward: Vec3;
  baseRight: Vec3;
  /** Per camera: plane origin, axes and normalised lens intrinsics. */
  cameras: {
    left: RigCamera;
    right: RigCamera;
  };
  planeAspect: number;
  blendWidth: number;
  lensCorrection: number;
}

export interface RigCamera {
  origin: Vec3;
  ex: Vec3;
  ey: Vec3;
  n: Vec3;
  /** fx/w, fy/h, cx/w, cy/h */
  intrinsics: [number, number, number, number];
  d: [number, number, number, number];
}

export function buildRig(calib: CalibInfo): Rig {
  void calib;
  return TODO();
}

/** Direction for a yaw/pitch (Reco's yaw_pitch_to_direction). */
export function yawPitchToDirection(yaw: number, pitch: number, rig: Rig): Vec3 {
  void yaw; void pitch; void rig;
  return TODO();
}

/** Yaw/pitch of a direction (Reco's direction_to_yaw_pitch). */
export function directionToYawPitch(dir: Vec3, rig: Rig): { yaw: number; pitch: number } {
  void dir; void rig;
  return TODO();
}

/** World ray through a point of the virtual camera; ndc in [-1,1], y = +1 at the top. */
export function viewRay(pose: Pose, rig: Rig, ndcX: number, ndcY: number, aspect: number): Vec3 {
  void pose; void rig; void ndcX; void ndcY; void aspect;
  return TODO();
}

/**
 * Where a ray lands in each source camera (CPU mirror of the shader, for tests
 * and picking): normalised source uv (0..1, v=0 top) and blend alpha.
 */
export function sampleRay(
  ray: Vec3,
  rig: Rig,
): { left: { u: number; v: number; alpha: number } | null; right: { u: number; v: number; alpha: number } | null } {
  void ray; void rig;
  return TODO();
}

/** Outline of the virtual camera's view as yaw/pitch points (for the overview rectangle). */
export function frustumOutline(pose: Pose, rig: Rig, aspect: number, stepsPerEdge?: number): { yaw: number; pitch: number }[] {
  void pose; void rig; void aspect; void stepsPerEdge;
  return TODO();
}
