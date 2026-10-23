import { describe, expect, it } from "vitest";
import { clampPose } from "../../src/engine/clamp";
import { lookAcross } from "../../src/engine/look";
import { buildRig, withRigTilt } from "../../src/engine/projection";
import { worldToRenderPose } from "../../src/engine/rigtilt";
import type { MatchCalibration } from "../../src/engine/types";
import synthJson from "./fixtures/synth-match.json";
import { calibInfoOf, coverageFromMatch } from "./reco-port";

const synth = synthJson as unknown as MatchCalibration;
const cov = coverageFromMatch(synth);
const base = buildRig(calibInfoOf(synth, cov));
const ASPECT = 16 / 9;

describe("lookAcross", () => {
  for (const [t, r] of [[0, 0], [0.25, 0], [-0.2, 0.08]]) {
    it(`looks at the left edge, the centre and the right edge (rig tilt ${t}, roll ${r})`, () => {
      const rig = withRigTilt(base, t, r);
      const now = clampPose({ yaw: 0.1, pitch: -0.05, fov: 24 }, cov, ASPECT);
      const left = lookAcross("left", now, rig, cov, ASPECT);
      const right = lookAcross("right", now, rig, cov, ASPECT);
      const centre = lookAcross("centre", now, rig, cov, ASPECT);
      for (const p of [left, right, centre]) {
        // what the export can show: the clamp leaves it alone
        const again = clampPose(p, cov, ASPECT);
        expect(p.yaw).toBeCloseTo(again.yaw, 6);
        expect(p.pitch).toBeCloseTo(again.pitch, 6);
        expect(p.fov).toBe(now.fov);
        // same height above the straightened horizon
        expect(worldToRenderPose(p, rig, rig.tilt).pitch).toBeCloseTo(worldToRenderPose(now, rig, rig.tilt).pitch, 6);
      }
      const ry = (p: typeof now) => worldToRenderPose(p, rig, rig.tilt).yaw;
      expect(ry(left)).toBeGreaterThan(ry(now) + 0.3); // positive yaw = left
      expect(ry(right)).toBeLessThan(ry(now) - 0.3);
      expect(ry(centre)).toBeCloseTo((ry(left) + ry(right)) / 2, 6);
      // at the edge: a little further is pushed back by the clamp
      const further = clampPose({ ...left, yaw: left.yaw + 0.02 }, cov, ASPECT);
      expect(further.yaw).toBeLessThan(left.yaw + 0.02 - 1e-6);
    });
  }
  it("gives the clamped view when the view shown cannot move", () => {
    const rig = withRigTilt(base, 0.25, 0);
    const wide = { yaw: 0, pitch: 0, fov: 170 };
    const p = lookAcross("left", wide, rig, cov, ASPECT);
    expect(Number.isFinite(p.yaw) && Number.isFinite(p.pitch)).toBe(true);
    expect(p.fov).toBeCloseTo(cov.maxFovDeg, 6);
  });
});
