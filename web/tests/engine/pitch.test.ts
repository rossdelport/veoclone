import { describe, expect, it } from "vitest";
import {
  aimOfOverviewPoint,
  convexHull,
  overviewPointOfAim,
  pitchPolygons,
  pointInPolygon,
  type Point2,
} from "../../src/engine/pitch";
import { buildRig, overviewRay, sampleRay, yawPitchToDirection, type Rig } from "../../src/engine/projection";
import { directionToYawPitch } from "../../src/engine/rigtilt";
import type { MatchCalibration, Vec3 } from "../../src/engine/types";
import synthJson from "./fixtures/synth-match.json";
import { calibInfoOf, cameraToPanorama, coverageFromMatch, sceneOf } from "./reco-port";

const synthMatch = synthJson as unknown as MatchCalibration;
const rigOf = (m: MatchCalibration, tilt?: { tilt: number; roll: number }): Rig => buildRig(calibInfoOf(m, coverageFromMatch(m)), tilt);
const rig = rigOf(synthMatch);

/** A pitch-like outline on the synthetic overview: both cameras see part of it. */
const OUTLINE = [
  { yaw: 0.9, pitch: -0.05 },
  { yaw: -0.9, pitch: -0.05 },
  { yaw: -0.8, pitch: -0.35 },
  { yaw: 0.8, pitch: -0.35 },
];

describe("polygon helpers", () => {
  it("point in polygon uses the even-odd rule", () => {
    const square: Point2[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    expect(pointInPolygon([0.5, 0.5], square)).toBe(true);
    expect(pointInPolygon([1.5, 0.5], square)).toBe(false);
    expect(pointInPolygon([0.5, 0.5], [[0, 0], [1, 1]])).toBe(false);
    // A concave "U": the notch is outside.
    const u: Point2[] = [[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3]];
    expect(pointInPolygon([1.5, 2], u)).toBe(false);
    expect(pointInPolygon([0.5, 2], u)).toBe(true);
  });

  it("convex hull drops inside and collinear points", () => {
    const h = convexHull([[0, 0], [2, 0], [1, 0], [2, 2], [0, 2], [1, 1], [0.5, 0.5]]);
    expect(h).toEqual([[0, 0], [2, 0], [2, 2], [0, 2]]);
    expect(convexHull([[0, 0], [1, 1]])).toEqual([[0, 0], [1, 1]]);
  });
});

/**
 * Check a camera grid against Reco's own mapping (camera_to_panorama, what
 * the AI uses for every detection): points that land inside the outline must
 * be inside their camera's polygon (`missed` counts those that are not);
 * `extra` counts polygon points that land outside the outline. Points near
 * the outline's edge are not counted.
 */
function compare(outline: { yaw: number; pitch: number }[], res: { left: Point2[]; right: Point2[] }) {
  const scene = sceneOf(synthMatch);
  const poly: Point2[] = outline.map((p) => [p.yaw, p.pitch]);
  const edgeDistance = (q: Point2) =>
    Math.min(
      ...poly.map((p, k) => {
        const n = poly[(k + 1) % poly.length];
        const [dx, dy] = [n[0] - p[0], n[1] - p[1]];
        const t = Math.max(0, Math.min(1, ((q[0] - p[0]) * dx + (q[1] - p[1]) * dy) / (dx * dx + dy * dy)));
        return Math.hypot(q[0] - p[0] - t * dx, q[1] - p[1] - t * dy);
      }),
    );
  const out = { inside: 0, missed: 0, extra: 0 };
  for (const side of ["left", "right"] as const) {
    for (let j = 1; j < 60; j++) {
      for (let i = 1; i < 60; i++) {
        const [x, y] = [i / 60, j / 60];
        const pano = cameraToPanorama(side, x, y, synthMatch, scene);
        if (!pano) continue;
        // Only where the lens model is one-to-one: near the corners of a
        // strong fisheye the inverse can land far from where the
        // renderer's forward model draws that pixel.
        const back = sampleRay(yawPitchToDirection(pano.yaw, pano.pitch, rig), rig)[side];
        if (!back || Math.hypot(back.u - x, back.v - y) > 1e-3) continue;
        const q: Point2 = [pano.yaw, pano.pitch];
        if (edgeDistance(q) < 0.01) continue;
        const inPoly = pointInPolygon([x, y], res[side]);
        const inOutline = pointInPolygon(q, poly);
        if (inOutline) out.inside++;
        if (inOutline && !inPoly) out.missed++;
        if (inPoly && !inOutline) out.extra++;
      }
    }
  }
  return out;
}

describe("pitch polygons", () => {
  it("map the outline into each camera, consistent with Reco's camera_to_panorama", () => {
    const res = pitchPolygons(OUTLINE, rig);
    expect(res.points).toHaveLength(4);
    for (const side of ["left", "right"] as const) {
      const poly = res[side];
      expect(poly.length).toBeGreaterThanOrEqual(3);
      for (const [x, y] of poly) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(1);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(1);
      }
    }
    // Edges straight in yaw/pitch are curved on the ground, so a camera's
    // part of this outline is not convex: the hull holds all of it, plus a bit.
    const c = compare(OUTLINE, res);
    expect(c.missed).toBe(0);
    expect(c.inside).toBeGreaterThan(300);
  });

  it("a real pitch (a rectangle on the ground, clicked along its edges) maps to tight polygons", () => {
    // The synthetic rig's eye looks along -x-z; the ground is 0.4 below it.
    // The pitch: 0.5 to 2.5 in front, 3 to either side.
    const { eye, baseForward: f, baseRight: r } = rig;
    const ground = (along: number, side: number): Vec3 => [eye[0] + f[0] * along + r[0] * side, -0.4, eye[2] + f[2] * along + r[2] * side];
    const corners: [number, number][] = [[2.5, -3], [2.5, 3], [0.5, 3], [0.5, -3]];
    const clicks = [];
    for (let k = 0; k < 4; k++) {
      const [a, b] = [corners[k], corners[(k + 1) % 4]];
      for (let t = 0; t < 1; t += 0.1) {
        const g = ground(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
        const d: Vec3 = [g[0] - eye[0], g[1] - eye[1], g[2] - eye[2]];
        clicks.push(directionToYawPitch(d, rig));
      }
    }
    const res = pitchPolygons(clicks, rig);
    const c = compare(clicks, res);
    expect(c.missed).toBe(0);
    expect(c.inside).toBeGreaterThan(300);
    // Barrel distortion bends the lines outwards, so the hull adds little.
    expect(c.extra / c.inside).toBeLessThan(0.05);
  });

  it("a camera that sees none of the outline gets no polygon", () => {
    // Far to the left: only the left camera sees it.
    const leftOnly = [
      { yaw: 1.0, pitch: -0.1 },
      { yaw: 0.6, pitch: -0.1 },
      { yaw: 0.6, pitch: -0.3 },
      { yaw: 1.0, pitch: -0.3 },
    ];
    for (const p of leftOnly) expect(sampleRay(overviewRay(p.yaw, p.pitch, rig), rig).right).toBeNull();
    const res = pitchPolygons(leftOnly, rig);
    expect(res.left.length).toBeGreaterThanOrEqual(3);
    expect(res.right).toEqual([]);
    expect(pitchPolygons(leftOnly.slice(0, 2), rig)).toMatchObject({ left: [], right: [] });
  });

  it("stores aims, so the outline stays put when the picture is straightened", () => {
    const tilted = rigOf(synthMatch, { tilt: 0.2, roll: -0.05 });
    // Clicked on the straightened overview…
    const clicked = OUTLINE.map((p) => ({ yaw: p.yaw * 0.9, pitch: p.pitch + 0.1 }));
    const res = pitchPolygons(clicked, tilted);
    // …the aims are the directions clicked…
    res.points.forEach(([yaw, pitch], i) => {
      const a = aimOfOverviewPoint(clicked[i], tilted);
      expect(yaw).toBeCloseTo(a.yaw, 4);
      expect(pitch).toBeCloseTo(a.pitch, 4);
      // …and come back to the same overview points.
      const back = overviewPointOfAim({ yaw, pitch }, tilted);
      expect(back.yaw).toBeCloseTo(clicked[i].yaw, 4);
      expect(back.pitch).toBeCloseTo(clicked[i].pitch, 4);
    });
    // Without straightening an overview point is its own aim.
    expect(aimOfOverviewPoint({ yaw: 0.3, pitch: -0.2 }, rig)).toEqual({ yaw: 0.3, pitch: -0.2 });
    // The camera polygons depend only on what was clicked, not on the
    // straightening it was clicked with.
    const level = pitchPolygons(res.points.map(([yaw, pitch]) => overviewPointOfAim({ yaw, pitch }, rig)), rig);
    expect(level.left.length).toBeGreaterThanOrEqual(3);
    const area = (p: Point2[]) => Math.abs(p.reduce((s, [x, y], i) => s + x * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * y, 0)) / 2;
    // Edges are straight in a different overview, so only close, not equal.
    expect(Math.abs(area(level.left) - area(res.left)) / area(res.left)).toBeLessThan(0.1);
  });
});
