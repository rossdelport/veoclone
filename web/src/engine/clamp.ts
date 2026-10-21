import type { Coverage, Pose } from "./types";

const TODO = (): never => {
  throw new Error("not implemented");
};

/** Yaw range [min, max] covered at a pitch (port of Reco's yaw_range_at). */
export function yawRangeAt(cov: Coverage, pitch: number): [number, number] {
  void cov; void pitch;
  return TODO();
}

/**
 * FOV cap + Reco's safe_clamp: keeps the whole view inside the area both
 * cameras can see. `aspect` = output width / height (16/9).
 */
export function clampPose(p: Pose, cov: Coverage, aspect: number): Pose {
  void p; void cov; void aspect;
  return TODO();
}
