import { describe, expect, it } from "vitest";
import { buildRig, frustumOutline, overviewExtent, overviewRay, viewBasis, viewRay, withRigTilt, type Rig } from "../../src/engine/projection";
import {
  aimOfRender,
  aimOfWorld,
  aimsToRenderPoses,
  renderPosesToWorld,
  worldPosesToRender,
  directionToRenderPose,
  directionToYawPitch,
  recoHumanToWorldPitch,
  recoRenderPitch,
  recoWorldToHumanPitch,
  renderBasis,
  renderForward,
  renderOfAim,
  renderToWorldPose,
  tiltFrame,
  worldOfAim,
  worldToRenderPose,
  yawPitchToDirection,
} from "../../src/engine/rigtilt";
import type { MatchCalibration, Vec3 } from "../../src/engine/types";
import { clampPose } from "../../src/engine/clamp";
import recoRig from "./fixtures/reco-rig-synth.json";
import synthJson from "./fixtures/synth-match.json";
import { calibInfoOf, coverageFromMatch, RECO_TEST_MATCH, viewMatrix, worldToRenderPosePort, type V3 } from "./reco-port";

const synthMatch = synthJson as unknown as MatchCalibration;
const synthCov = coverageFromMatch(synthMatch);
const synthRig = buildRig(calibInfoOf(synthMatch, synthCov));
const recoTestRig = buildRig(calibInfoOf(RECO_TEST_MATCH, coverageFromMatch(RECO_TEST_MATCH)));
const DEG = Math.PI / 180;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const angle = (a: Vec3, b: Vec3) => {
  const c: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return Math.atan2(len(c), dot(a, b));
};

/** Rig tilt/roll pairs (radians) used across the tests. */
const RIGS: [number, number][] = [
  [-0.25, 0.05],
  [-0.25, 0],
  [0.3, -0.12],
  [0, 0.2],
  [0.6, 0.35],
  [0.15, 0],
];

const POSES: { yaw: number; pitch: number }[] = [];
for (const yaw of [-1.3, -0.7, -0.2, 0, 0.35, 0.9, 1.4]) for (const pitch of [-0.6, -0.15, 0, 0.2, 0.55]) POSES.push({ yaw, pitch });

const tilted = (rig: Rig, t: number, r: number) => withRigTilt(rig, t, r);

/**
 * With roll, view_matrix pitches about an axis that is not square to its yaw
 * axis, so directions within `roll` of straight up or down cannot be the
 * centre of the view (far outside any coverage). Skip those.
 */
function reachable(a: { yaw: number; pitch: number }, rig: Rig, f = rig.tilt): boolean {
  const d = yawPitchToDirection(a.yaw, a.pitch, rig);
  return Math.abs(Math.asin(dot(d, f.up))) < Math.PI / 2 - Math.abs(f.roll) - 0.01;
}

describe("Reco's rig_correction.rs tests", () => {
  it("render_pitch_identity_when_no_tilt", () => {
    for (let yi = -10; yi <= 10; yi++) {
      for (let pi = -5; pi <= 5; pi++) {
        expect(Math.abs(recoRenderPitch(yi * 0.1, pi * 0.05, 0) - pi * 0.05)).toBeLessThan(1e-6);
      }
    }
  });
  it("render_pitch_compensates_tilt_at_yaw_zero", () => {
    expect(Math.abs(recoRenderPitch(0, 0, 0.15) + 0.15)).toBeLessThan(1e-4);
  });
  it("render_pitch_no_compensation_at_yaw_90", () => {
    expect(Math.abs(recoRenderPitch(Math.PI / 2, 0, 0.15))).toBeLessThan(1e-4);
  });
  it("render_pitch_positive_at_yaw_pi", () => {
    expect(Math.abs(recoRenderPitch(Math.PI, 0, 0.15) - 0.15)).toBeLessThan(1e-4);
  });
  it("human_to_world_identity_when_no_tilt", () => {
    for (let yi = -10; yi <= 10; yi++) {
      for (let pi = -5; pi <= 5; pi++) {
        expect(Math.abs(recoHumanToWorldPitch(yi * 0.1, pi * 0.05, 0) - pi * 0.05)).toBeLessThan(1e-6);
      }
    }
  });
  it("human_zero_pitch_maps_to_world_zero", () => {
    for (let yi = -10; yi <= 10; yi++) expect(Math.abs(recoHumanToWorldPitch(yi * 0.3, 0, 0.2))).toBeLessThan(1e-6);
  });
  it("world_to_human_roundtrip", () => {
    for (let yi = -5; yi <= 5; yi++) {
      for (let pi = -3; pi <= 3; pi++) {
        const wp = recoHumanToWorldPitch(yi * 0.3, pi * 0.1, 0.15);
        expect(Math.abs(recoWorldToHumanPitch(yi * 0.3, wp, 0.15) - pi * 0.1)).toBeLessThan(1e-4);
      }
    }
  });
});

describe("tiltFrame", () => {
  it("applies nothing at 0/0 or below Reco's 1e-6 threshold", () => {
    for (const [t, r] of [[0, 0], [1e-6, -1e-6], [5e-7, 0]]) {
      const f = tiltFrame(synthRig, t, r);
      expect(f.identity).toBe(true);
      expect(f.forward).toEqual(synthRig.baseForward);
      expect(f.up).toEqual([0, 1, 0]);
    }
    expect(tiltFrame(synthRig, 2e-6, 0).identity).toBe(false);
    expect(tiltFrame(synthRig, 0, 2e-6).hasRoll).toBe(true);
  });
  it("buildRig takes match.json's rig tilt/roll unless told otherwise", () => {
    const m = { ...synthMatch, rig_tilt: 0.2, rig_roll: -0.1 };
    const calib = calibInfoOf(m, synthCov);
    expect(buildRig(calib).tilt.tilt).toBe(0.2);
    expect(buildRig(calib).tilt.roll).toBe(-0.1);
    expect(buildRig(calib, { tilt: 0, roll: 0 }).tilt.identity).toBe(true);
    expect(synthRig.tilt.identity).toBe(true);
  });
  it("tilts forward and up about base right; positive tilt = phones pointing down", () => {
    const f = tiltFrame(synthRig, 0.3, 0);
    // The level forward lies above the phones' own forward when they point down.
    expect(f.forward[1]).toBeCloseTo(Math.sin(0.3), 12);
    expect(dot(f.forward, f.up)).toBeCloseTo(0, 12);
    expect(dot(f.up, synthRig.baseRight)).toBeCloseTo(0, 12);
    expect(f.upDotTilted).toBeCloseTo(1, 12);
    const g = tiltFrame(synthRig, 0.3, 0.1);
    expect(g.upDotTilted).toBeCloseTo(Math.cos(0.1), 12);
    // positive roll leans the up axis toward -base right (the phones lean right)
    expect(dot(g.up, synthRig.baseRight)).toBeCloseTo(-Math.sin(0.1), 12);
  });
});

describe("rig tilt/roll vs Reco's own maths (test port of view_matrix + world_to_render_pose)", () => {
  it("worldToRenderPose = world_to_render_pose", () => {
    for (const rig of [synthRig, recoTestRig]) {
      for (const [t, r] of RIGS) {
        for (const w of POSES) {
          const got = worldToRenderPose(w, rig, tiltFrame(rig, t, r));
          const want = worldToRenderPosePort(rig.eye as V3, w.yaw, w.pitch, t, r);
          expect(got.yaw).toBeCloseTo(want.yaw, 10);
          expect(got.pitch).toBeCloseTo(want.pitch, 10);
        }
      }
    }
  });
  it("viewBasis(world pose) = the rows of view_matrix(world_to_render_pose(pose), rig_tilt, rig_roll)", () => {
    for (const rig of [synthRig, recoTestRig]) {
      for (const [t, r] of [...RIGS, [0, 0] as [number, number]]) {
        const tr = tilted(rig, t, r);
        for (const w of POSES) {
          const rp = worldToRenderPosePort(rig.eye as V3, w.yaw, w.pitch, t, r);
          const m = viewMatrix(rig.eye as V3, rp.yaw, rp.pitch, t, r);
          const row = (i: number): Vec3 => [m[i], m[4 + i], m[8 + i]];
          const { F, R, U } = viewBasis(w, tr);
          for (let k = 0; k < 3; k++) {
            expect(R[k]).toBeCloseTo(row(0)[k], 10);
            expect(U[k]).toBeCloseTo(row(1)[k], 10);
            expect(-F[k]).toBeCloseTo(row(2)[k], 10);
          }
        }
      }
    }
  });
  it("renderBasis / renderForward = view_matrix for render poses", () => {
    for (const [t, r] of RIGS) {
      const f = tiltFrame(synthRig, t, r);
      for (const p of POSES) {
        const m = viewMatrix(synthRig.eye as V3, p.yaw, p.pitch, t, r);
        const fwd = renderForward(p.yaw, p.pitch, synthRig, f);
        const b = renderBasis(p.yaw, p.pitch, synthRig, f);
        for (let k = 0; k < 3; k++) {
          expect(-fwd[k]).toBeCloseTo(m[k * 4 + 2], 10);
          expect(b.R[k]).toBeCloseTo(m[k * 4], 10);
          expect(b.U[k]).toBeCloseTo(m[k * 4 + 1], 10);
        }
      }
    }
  });
});

describe("round trips", () => {
  it("renderToWorldPose inverts worldToRenderPose", () => {
    for (const [t, r] of RIGS) {
      const f = tiltFrame(synthRig, t, r);
      for (const w of POSES) {
        const back = renderToWorldPose(worldToRenderPose(w, synthRig, f), synthRig, f);
        expect(back.yaw).toBeCloseTo(w.yaw, 12);
        expect(back.pitch).toBeCloseTo(w.pitch, 12);
      }
    }
  });
  it("directionToRenderPose inverts renderForward (closed form, also with roll)", () => {
    for (const [t, r] of RIGS) {
      const f = tiltFrame(synthRig, t, r);
      for (const p of POSES) {
        const back = directionToRenderPose(renderForward(p.yaw, p.pitch, synthRig, f), synthRig, f);
        expect(back.yaw).toBeCloseTo(p.yaw, 12);
        expect(back.pitch).toBeCloseTo(p.pitch, 12);
      }
    }
  });
  it("aims: worldOfAim / aimOfWorld and renderOfAim / aimOfRender invert each other", () => {
    let checked = 0;
    for (const [t, r] of RIGS) {
      const f = tiltFrame(synthRig, t, r);
      for (const a of POSES) {
        if (!reachable(a, synthRig, f)) continue;
        checked++;
        const w = worldOfAim(a, synthRig, f);
        const back = aimOfWorld(w, synthRig, f);
        expect(back.yaw).toBeCloseTo(a.yaw, 12);
        expect(back.pitch).toBeCloseTo(a.pitch, 12);
        const rr = aimOfRender(renderOfAim(a, synthRig, f), synthRig, f);
        expect(rr.yaw).toBeCloseTo(a.yaw, 12);
        expect(rr.pitch).toBeCloseTo(a.pitch, 12);
      }
    }
    expect(checked).toBeGreaterThan(RIGS.length * POSES.length * 0.95);
  });
  it("an unreachable aim still gives a finite pose (straight up or down)", () => {
    const f = tiltFrame(synthRig, 0.6, 0.35);
    const a = { yaw: -0.7, pitch: -0.6 };
    expect(reachable(a, synthRig, f)).toBe(false);
    const r = renderOfAim(a, synthRig, f);
    expect(r.pitch).toBeCloseTo(-Math.PI / 2, 12);
    const w = worldOfAim(a, synthRig, f);
    expect(Number.isFinite(w.yaw) && Number.isFinite(w.pitch)).toBe(true);
  });
  it("worldPosesToRender is worldToRenderPose on every element", () => {
    for (const [t, r] of RIGS) {
      const f = tiltFrame(synthRig, t, r);
      const yaw = Float64Array.from(POSES, (p) => p.yaw);
      const pitch = Float64Array.from(POSES, (p) => p.pitch);
      worldPosesToRender(yaw, pitch, synthRig, f);
      POSES.forEach((p, i) => {
        const want = worldToRenderPose(p, synthRig, f);
        expect(yaw[i]).toBeCloseTo(want.yaw, 12);
        expect(pitch[i]).toBeCloseTo(want.pitch, 12);
      });
    }
  });
  it("the bulk versions agree with renderOfAim / renderToWorldPose", () => {
    for (const [t, r] of RIGS) {
      const f = tiltFrame(synthRig, t, r);
      const yaw = Float64Array.from(POSES, (p) => p.yaw);
      const pitch = Float64Array.from(POSES, (p) => p.pitch);
      aimsToRenderPoses(yaw, pitch, synthRig, f);
      POSES.forEach((p, i) => {
        const want = renderOfAim(p, synthRig, f);
        expect(yaw[i]).toBeCloseTo(want.yaw, 12);
        expect(pitch[i]).toBeCloseTo(want.pitch, 12);
      });
      const wy = Float64Array.from(POSES, (p) => p.yaw);
      const wp = Float64Array.from(POSES, (p) => p.pitch);
      renderPosesToWorld(wy, wp, synthRig, f);
      POSES.forEach((p, i) => {
        const want = renderToWorldPose(p, synthRig, f);
        expect(wy[i]).toBeCloseTo(want.yaw, 12);
        expect(wp[i]).toBeCloseTo(want.pitch, 12);
      });
    }
  });
  it("are all the identity without rig tilt/roll (bit for bit)", () => {
    const f = tiltFrame(synthRig, 0, 0);
    for (const p of POSES) {
      expect(worldToRenderPose(p, synthRig, f)).toEqual(p);
      expect(renderToWorldPose(p, synthRig, f)).toEqual(p);
      expect(worldOfAim(p, synthRig, f)).toEqual(p);
      expect(aimOfWorld(p, synthRig, f)).toEqual(p);
      expect(renderOfAim(p, synthRig, f)).toEqual(p);
      expect(renderForward(p.yaw, p.pitch, synthRig, f)).toEqual(yawPitchToDirection(p.yaw, p.pitch, synthRig));
      const d = yawPitchToDirection(p.yaw, p.pitch, synthRig);
      expect(directionToRenderPose(d, synthRig, f)).toEqual(directionToYawPitch(d, synthRig));
    }
  });
});

describe("straightening keeps what the camera looks at", () => {
  it("an AI pose (rig 0) converted with worldOfAim has the same centre ray when Reco renders it", () => {
    for (const [t, r] of RIGS) {
      const rig = tilted(synthRig, t, r);
      for (const a of POSES) {
        if (!reachable(a, rig)) continue;
        const w = worldOfAim(a, rig, rig.tilt);
        const before = viewBasis(a, synthRig).F; // rig 0: what the AI pass looked at
        const after = viewBasis(w, rig).F; // Reco: world_to_render_pose + view_matrix with the rig
        expect(angle(before, after)).toBeLessThan(1e-9);
        expect(len(after)).toBeCloseTo(1, 12);
      }
    }
  });
  it("without roll the world pose is the aim itself (world_to_render_pose is exact)", () => {
    const rig = tilted(synthRig, 0.4, 0);
    for (const a of POSES) {
      const w = worldOfAim(a, rig, rig.tilt);
      expect(w.yaw).toBeCloseTo(a.yaw, 12);
      expect(w.pitch).toBeCloseTo(a.pitch, 12);
    }
  });
  it("straightening turns the picture about its centre", () => {
    const a = { yaw: 0.8, pitch: -0.1 };
    const rig = tilted(synthRig, 0.25, 0);
    const before = viewBasis(a, synthRig);
    const after = viewBasis(worldOfAim(a, rig, rig.tilt), rig);
    expect(angle(before.F, after.F)).toBeLessThan(1e-12);
    // the screen right turned about the forward axis
    const turn = Math.atan2(dot(after.R, before.U), dot(after.R, before.R));
    expect(Math.abs(turn)).toBeGreaterThan(5 * DEG);
  });
});

describe("the straightened picture is level", () => {
  // Phones pointed down by tilt: gravity's up, seen from the phones, is the rig's
  // up turned toward their forward. Reco's tilt turns world up exactly there.
  it("with tilt only, screen right stays horizontal at every pose (no lean when panning)", () => {
    for (const t of [-0.3, 0.1, 0.25, 0.5]) {
      const rig = tilted(synthRig, t, 0);
      const gravityUp = rig.tilt.up;
      for (const p of POSES) {
        const { R } = renderBasis(p.yaw, p.pitch, rig, rig.tilt);
        expect(dot(R, gravityUp)).toBeCloseTo(0, 12);
      }
    }
  });
  it("with roll too, it is level when the camera looks at the horizon", () => {
    const rig = tilted(synthRig, 0.2, 0.1);
    for (const yaw of [-1, -0.3, 0, 0.6, 1.2]) {
      const { R } = renderBasis(yaw, 0, rig, rig.tilt);
      expect(dot(R, rig.tilt.up)).toBeCloseTo(0, 12);
    }
  });
  it("without straightening a tilted rig leans more and more as the camera turns", () => {
    const gravityUp = tiltFrame(synthRig, 0.25, 0).up;
    const lean = (yaw: number) => Math.asin(dot(viewBasis({ yaw, pitch: 0 }, synthRig).R, gravityUp)) / DEG;
    expect(Math.abs(lean(0))).toBeLessThan(1e-9);
    expect(Math.abs(lean(0.5))).toBeGreaterThan(5);
    expect(Math.abs(lean(1.0))).toBeGreaterThan(Math.abs(lean(0.5)));
    expect(Math.sign(lean(1.0))).toBe(-Math.sign(lean(-1.0)));
  });
});

describe("overview in render yaw/pitch", () => {
  it("overviewRay at a render pose is the centre of the camera view for its world pose", () => {
    const rig = tilted(synthRig, 0.25, 0.08);
    for (const p of POSES) {
      const w = renderToWorldPose(p, rig, rig.tilt);
      expect(angle(overviewRay(p.yaw, p.pitch, rig), viewRay({ ...w, fov: 30 }, rig, 0, 0, 16 / 9))).toBeLessThan(1e-9);
    }
  });
  it("the frustum outline is an upright box around the render pose", () => {
    const rig = tilted(synthRig, 0.3, 0);
    const r = { yaw: 0.9, pitch: -0.05 };
    const w = renderToWorldPose(r, rig, rig.tilt);
    const pts = frustumOutline({ ...w, fov: 30 }, rig, 16 / 9, 4);
    // top-left and top-right corners at the same render pitch (level), left of / right of the centre
    const [tl, , , , tr] = pts;
    expect(tl.pitch).toBeCloseTo(tr.pitch, 9);
    expect(tl.yaw).toBeGreaterThan(r.yaw);
    expect(tr.yaw).toBeLessThan(r.yaw);
  });
  it("the overview still shows the whole picture when straightened", () => {
    for (const [t, r] of RIGS) {
      const rig = tilted(synthRig, t, r);
      const e = overviewExtent(rig, synthCov);
      expect(e.yawMax - e.yawMin).toBeGreaterThan(1.5);
      expect(e.pitchMax - e.pitchMin).toBeGreaterThan(0.8);
      // the centre of the straightened picture is inside
      const c = directionToRenderPose(yawPitchToDirection(0, 0, rig), rig, rig.tilt);
      expect(c.yaw).toBeGreaterThan(e.yawMin);
      expect(c.yaw).toBeLessThan(e.yawMax);
      expect(c.pitch).toBeGreaterThan(e.pitchMin);
      expect(c.pitch).toBeLessThan(e.pitchMax);
    }
  });
});

describe("vs Reco itself", () => {
  it("clamp + worldToRenderPose = the render poses Reco presented (reco stitch, 3 rigs x 150 poses)", () => {
    // fixtures/reco-rig-synth.json: `reco stitch --trajectory` on the synthetic
    // footage with rig_tilt/rig_roll set in match.json; inputs far outside the
    // coverage on purpose. pose_presented is director_position's output: the
    // world clamp, then world_to_render_pose.
    let worst = 0;
    let moved = 0;
    for (const { rig_tilt, rig_roll, cases } of recoRig.rigs) {
      const rig = tilted(synthRig, rig_tilt, rig_roll);
      expect(rig.tilt.identity).toBe(false);
      for (const { input, reco } of cases) {
        const clamped = clampPose(input, synthCov, recoRig.aspect);
        const r = worldToRenderPose(clamped, rig, rig.tilt);
        worst = Math.max(worst, Math.abs(r.yaw - reco.yaw), Math.abs(r.pitch - reco.pitch));
        expect(clamped.fov).toBeCloseTo(reco.fov, 3);
        if (Math.abs(r.pitch - clamped.pitch) > 0.01) moved++;
      }
    }
    expect(worst).toBeLessThan(1e-4);
    expect(moved).toBeGreaterThan(100); // the rig really changed the render poses
  });
});
