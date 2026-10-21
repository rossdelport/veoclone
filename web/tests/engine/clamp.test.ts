import { describe, expect, it } from "vitest";
import { clampPose, globalYawRange, yawRangeAt } from "../../src/engine/clamp";
import type { Coverage, MatchCalibration } from "../../src/engine/types";
import recoClamp from "./fixtures/reco-clamp-synth.json";
import synthMatch from "./fixtures/synth-match.json";
import { coverageFromMatch, RECO_TEST_MATCH } from "./reco-port";

const ASPECT = 16 / 9;
const DEG = Math.PI / 180;
const recoCov = coverageFromMatch(RECO_TEST_MATCH);
const synthCov = coverageFromMatch(synthMatch as unknown as MatchCalibration);

/** A simple hand-made coverage: 5 slices from pitch -0.4 to 0.4. */
const simple: Coverage = {
  pitchMin: -0.4,
  pitchMax: 0.4,
  maxFovDeg: 40,
  slices: [
    [-1.0, 1.0],
    [-1.2, 1.1],
    [-1.4, 1.2],
    [-1.2, 1.1],
    [-1.0, 1.0],
  ],
};

const halfH = (fovDeg: number) => Math.atan(ASPECT * Math.tan((fovDeg / 2) * DEG));

describe("yawRangeAt (Reco interpolate_slice)", () => {
  it("returns the table rows at the slice pitches", () => {
    for (let i = 0; i < 5; i++) {
      const [lo, hi] = yawRangeAt(simple, -0.4 + i * 0.2);
      expect(lo).toBeCloseTo(simple.slices[i][0], 12);
      expect(hi).toBeCloseTo(simple.slices[i][1], 12);
    }
  });
  it("interpolates linearly between rows", () => {
    const [lo, hi] = yawRangeAt(simple, -0.15); // a quarter of the way from row 1 to 2
    expect(lo).toBeCloseTo(-1.25, 12);
    expect(hi).toBeCloseTo(1.125, 12);
  });
  it("holds the last row above the range and extrapolates below it, like Rust", () => {
    expect(yawRangeAt(simple, 5)).toEqual([-1.0, 1.0]);
    // below pitchMin: idx_lo saturates to 0 and frac goes negative
    const [lo, hi] = yawRangeAt(simple, -0.5); // idx_f = -0.5
    expect(lo).toBeCloseTo(-1.0 + -0.5 * (-1.2 - -1.0), 12);
    expect(hi).toBeCloseTo(1.0 + -0.5 * (1.1 - 1.0), 12);
  });
  it("skips invalid rows", () => {
    const cov: Coverage = { ...simple, slices: [[-1, 1], [1, -1], [-2, 2]] };
    expect(yawRangeAt(cov, -0.2)).toEqual([-1, 1]); // hi row invalid -> lo row
    expect(yawRangeAt(cov, 0.0)).toEqual([-2, 2]); // lo row invalid -> hi row
  });
  it("gives (0, 0) for an empty coverage", () => {
    expect(yawRangeAt({ ...simple, slices: [] }, 0)).toEqual([0, 0]);
    expect(yawRangeAt({ ...simple, pitchMax: -0.4 }, 0)).toEqual([0, 0]);
  });
  it("reproduces the 400-slice table exactly when sampled like the helper does", () => {
    const n = recoCov.slices.length;
    expect(n).toBe(400);
    for (const i of [0, 1, 57, 199, 200, 398, 399]) {
      const p = recoCov.pitchMin + (i / (n - 1)) * (recoCov.pitchMax - recoCov.pitchMin);
      const [lo, hi] = yawRangeAt(recoCov, p);
      expect(lo).toBeCloseTo(recoCov.slices[i][0], 9);
      expect(hi).toBeCloseTo(recoCov.slices[i][1], 9);
    }
  });
});

describe("Reco coverage tests (projection/mod.rs)", () => {
  it("coverage_yaw_and_pitch_ranges_match_internal_state", () => {
    const [yMin, yMax] = globalYawRange(recoCov);
    expect(yMin).toBeLessThan(yMax);
    expect(Number.isFinite(yMin) && Number.isFinite(yMax)).toBe(true);
    // ~ +-103 degrees of yaw and -32..+33 degrees of pitch for this rig
    expect(yMin / DEG).toBeCloseTo(-103, -1);
    expect(yMax / DEG).toBeCloseTo(103, -1);
  });
  it("coverage_yaw_range_is_widest_slice_envelope", () => {
    const [gLo, gHi] = globalYawRange(recoCov);
    for (let i = 0; i <= 10; i++) {
      const p = recoCov.pitchMin + (i / 10) * (recoCov.pitchMax - recoCov.pitchMin);
      const [lo, hi] = yawRangeAt(recoCov, p);
      if (lo > hi) continue;
      expect(lo).toBeGreaterThanOrEqual(gLo - 1e-4);
      expect(hi).toBeLessThanOrEqual(gHi + 1e-4);
    }
  });
  it("safe_clamp_rejects_nan_yaw / nan_pitch / nan_fov / infinite inputs", () => {
    const cases: [number, number, number][] = [
      [Number.NaN, 0, 75],
      [0, Number.NaN, 75],
      [0, 0, Number.NaN],
      [Number.POSITIVE_INFINITY, 0, 75],
      [0, Number.NEGATIVE_INFINITY, 75],
    ];
    for (const [yaw, pitch, fov] of cases) {
      const out = clampPose({ yaw, pitch, fov }, recoCov, ASPECT);
      expect(Number.isFinite(out.yaw)).toBe(true);
      expect(Number.isFinite(out.pitch)).toBe(true);
      expect(Number.isFinite(out.fov)).toBe(true);
    }
  });
});

describe("clampPose vs Reco itself", () => {
  it("matches the poses Reco rendered (pose_presented events) for 150 random trajectory poses", () => {
    // fixtures/reco-clamp-synth.json: `reco stitch --trajectory` on the synthetic
    // footage; inputs far outside the coverage on purpose. The coverage here is
    // the test port of from_calibration (the helper sends Reco's own table).
    expect(synthCov.maxFovDeg).toBeCloseTo(53.247746, 4); // Reco's max_fov_degrees() for this calibration
    let worst = 0;
    for (const { input, reco } of recoClamp.cases) {
      const out = clampPose(input, synthCov, recoClamp.aspect);
      worst = Math.max(worst, Math.abs(out.yaw - reco.yaw), Math.abs(out.pitch - reco.pitch));
      expect(out.fov).toBeCloseTo(reco.fov, 3);
    }
    expect(worst).toBeLessThan(1e-4);
  });
});

describe("clampPose", () => {
  it("leaves a pose that fits untouched", () => {
    const p = { yaw: 0.1, pitch: 0.05, fov: 20 };
    expect(clampPose(p, simple, ASPECT)).toEqual(p);
  });
  it("caps the fov to [1, maxFovDeg]", () => {
    expect(clampPose({ yaw: 0, pitch: 0, fov: 75 }, simple, ASPECT).fov).toBe(40);
    expect(clampPose({ yaw: 0, pitch: 0, fov: 0.2 }, simple, ASPECT).fov).toBe(1);
    expect(clampPose({ yaw: 0, pitch: 0, fov: Number.NaN }, simple, ASPECT).fov).toBe(40);
  });
  it("keeps the top and bottom of the view inside the pitch range", () => {
    const up = clampPose({ yaw: 0, pitch: 1, fov: 30 }, simple, ASPECT);
    expect(up.pitch).toBeCloseTo(0.4 - 15 * DEG, 12);
    const down = clampPose({ yaw: 0, pitch: -1, fov: 30 }, simple, ASPECT);
    expect(down.pitch).toBeCloseTo(-0.4 + 15 * DEG, 12);
  });
  it("centres the pitch when the view is taller than the coverage", () => {
    const cov = { ...simple, maxFovDeg: 60 };
    expect(clampPose({ yaw: 0, pitch: 0.3, fov: 50 }, cov, ASPECT).pitch).toBeCloseTo(0, 12);
  });
  it("keeps the sides of the view inside the yaw range at the clamped pitch", () => {
    const fov = 30;
    const left = clampPose({ yaw: 3, pitch: 0, fov }, simple, ASPECT);
    expect(left.pitch).toBe(0);
    expect(left.yaw).toBeCloseTo(1.2 - halfH(fov), 12);
    const right = clampPose({ yaw: -3, pitch: 0, fov }, simple, ASPECT);
    expect(right.yaw).toBeCloseTo(-1.4 + halfH(fov), 12);
    // at a clamped pitch the yaw range of that pitch is used
    const corner = clampPose({ yaw: 3, pitch: 1, fov }, simple, ASPECT);
    expect(corner.yaw).toBeCloseTo(yawRangeAt(simple, corner.pitch)[1] - halfH(fov), 12);
  });
  it("centres the yaw when the view is wider than the coverage", () => {
    const narrow: Coverage = { ...simple, slices: simple.slices.map(() => [-0.2, 0.4]) };
    expect(clampPose({ yaw: 1, pitch: 0, fov: 30 }, narrow, ASPECT).yaw).toBeCloseTo(0.1, 12);
  });
  it("uses the output aspect for the horizontal margin", () => {
    const wide = clampPose({ yaw: 3, pitch: 0, fov: 30 }, simple, 2.5);
    const square = clampPose({ yaw: 3, pitch: 0, fov: 30 }, simple, 1);
    expect(wide.yaw).toBeLessThan(square.yaw);
  });
  it("is idempotent (the export re-clamps the editor's path)", () => {
    for (const cov of [recoCov, synthCov]) {
      for (let i = 0; i < 200; i++) {
        const p = { yaw: Math.sin(i) * 3, pitch: Math.cos(i * 1.7) * 1.2, fov: 5 + (i % 50) };
        const once = clampPose(p, cov, ASPECT);
        const twice = clampPose(once, cov, ASPECT);
        expect(twice.yaw).toBeCloseTo(once.yaw, 12);
        expect(twice.pitch).toBeCloseTo(once.pitch, 12);
        expect(twice.fov).toBe(once.fov);
      }
    }
  });
});
