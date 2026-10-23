// "Look left / centre / right" for Straighten picture: a preview-only view of
// the left edge, the middle or the right edge of the pitch, to check that the
// far side looks level everywhere.
import { clampPose } from "./clamp";
import type { Rig } from "./projection";
import { renderToWorldPose, worldToRenderPose } from "./rigtilt";
import type { Coverage, Pose } from "./types";

export type LookSide = "left" | "centre" | "right";

/**
 * A clamped world pose looking at one side of the pitch from `pose` (the view
 * shown now): the same fov and the same render pitch (height above the
 * straightened horizon), turned about the straightened up axis as far as the
 * export's coverage clamp allows; "centre" is halfway between the two edges.
 */
export function lookAcross(side: LookSide, pose: Pose, rig: Rig, cov: Coverage, aspect: number): Pose {
  const start = clampPose(pose, cov, aspect);
  const fov = start.fov;
  const r0 = worldToRenderPose(start, rig, rig.tilt);
  const at = (yaw: number): Pose => ({ ...renderToWorldPose({ yaw, pitch: r0.pitch }, rig, rig.tilt), fov });
  const fits = (yaw: number): boolean => {
    const w = at(yaw);
    const c = clampPose(w, cov, aspect);
    return Math.abs(c.yaw - w.yaw) < 1e-7 && Math.abs(c.pitch - w.pitch) < 1e-7;
  };
  // Positive yaw pans left. Walk from the view shown now to where the clamp
  // starts to push back (the edge of what both cameras see).
  const edge = (dir: 1 | -1): number => {
    let ok = r0.yaw;
    let bad = r0.yaw + dir * Math.PI;
    if (!fits(ok)) return ok;
    if (fits(bad)) return bad;
    for (let i = 0; i < 40; i++) {
      const mid = (ok + bad) / 2;
      if (fits(mid)) ok = mid;
      else bad = mid;
    }
    return ok;
  };
  const yaw = side === "left" ? edge(1) : side === "right" ? edge(-1) : (edge(1) + edge(-1)) / 2;
  return clampPose(at(yaw), cov, aspect);
}
