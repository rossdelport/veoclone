import { describe, expect, it } from "vitest";
import {
  buildRig,
  cameraBasis,
  directionToYawPitch,
  frustumOutline,
  sampleRay,
  viewRay,
  yawPitchToDirection,
  type Rig,
} from "../../src/engine/projection";
import type { MatchCalibration, Vec3 } from "../../src/engine/types";
import synthJson from "./fixtures/synth-match.json";
import {
  calibInfoOf,
  cameraToPanorama,
  coverageFromMatch,
  forwardFisheye,
  m4apply,
  m4mul,
  perspective,
  RECO_TEST_MATCH,
  sceneOf,
  viewMatrix,
  type V3,
} from "./reco-port";

const synthMatch = synthJson as unknown as MatchCalibration;
const ASPECT = 16 / 9;
const DEG = Math.PI / 180;

const rigOf = (m: MatchCalibration): Rig => buildRig(calibInfoOf(m, coverageFromMatch(m)));
const recoRig = rigOf(RECO_TEST_MATCH);
const synthRig = rigOf(synthMatch);
const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe("buildRig", () => {
  it("places the planes and eye like SceneGeometry::from_layout_with_aspect", () => {
    const r = recoRig;
    const h = 0.5 * (1 - 0.5446);
    expect(r.eye).toEqual([0.2398, 0, 0.2398]);
    expect(r.cameras.left.origin).toEqual([0, 0, h]);
    expect(r.cameras.right.origin).toEqual([h, 0.00476, 0]);
    expect(r.planeAspect).toBeCloseTo(16 / 9, 12);
    expect(r.cameras.left.intrinsics[0]).toBeCloseTo(1796.32 / 3840, 12);
    expect(r.cameras.left.intrinsics[3]).toBeCloseTo(1063.17 / 2160, 12);
    expect(r.blendWidth).toBe(0.15);
    expect(r.lensCorrection).toBe(1);
  });
  it("matches the model matrices: left plane faces +X, right plane faces +Z", () => {
    const flat = rigOf({ ...RECO_TEST_MATCH, params: { ...RECO_TEST_MATCH.params, xRz: 0, zRx: 0 } });
    flat.cameras.left.n.forEach((v, i) => expect(v).toBeCloseTo([1, 0, 0][i], 12));
    flat.cameras.left.ex.forEach((v, i) => expect(v).toBeCloseTo([0, 0, -1][i], 12)); // texture u runs toward -Z
    flat.cameras.right.n.forEach((v, i) => expect(v).toBeCloseTo([0, 0, 1][i], 12));
    flat.cameras.right.ex.forEach((v, i) => expect(v).toBeCloseTo([1, 0, 0][i], 12));
    // and with corrections, the axes equal the columns of Reco's model matrices
    for (const m of [RECO_TEST_MATCH, synthMatch]) {
      const scene = sceneOf(m);
      const rig = rigOf(m);
      for (const [model, cam] of [[scene.modelLeft, rig.cameras.left], [scene.modelRight, rig.cameras.right]] as const) {
        const col = (j: number) => [model[j * 4], model[j * 4 + 1], model[j * 4 + 2]];
        col(0).forEach((v, i) => expect(cam.ex[i]).toBeCloseTo(v, 12));
        col(1).forEach((v, i) => expect(cam.ey[i]).toBeCloseTo(v, 12));
        col(2).forEach((v, i) => expect(cam.n[i]).toBeCloseTo(v, 12));
        col(3).forEach((v, i) => expect(cam.origin[i]).toBeCloseTo(v, 12));
      }
    }
  });
});

describe("camera basis", () => {
  it("is orthonormal and right-handed (F x U = R) for many poses", () => {
    for (const yaw of [-1.5, -0.6, 0, 0.3, 1.2]) {
      for (const pitch of [-0.8, -0.1, 0, 0.4, 1.0]) {
        const { F, R, U } = cameraBasis(yaw, pitch, synthRig);
        for (const v of [F, R, U]) expect(len(v)).toBeCloseTo(1, 12);
        expect(dot(F, R)).toBeCloseTo(0, 12);
        expect(dot(F, U)).toBeCloseTo(0, 12);
        expect(dot(R, U)).toBeCloseTo(0, 12);
        const FxU = [F[1] * U[2] - F[2] * U[1], F[2] * U[0] - F[0] * U[2], F[0] * U[1] - F[1] * U[0]];
        FxU.forEach((v, i) => expect(v).toBeCloseTo(R[i], 12));
        expect(R[1]).toBeCloseTo(0, 12); // no roll
      }
    }
  });
  it("matches renderer.rs view_matrix (quaternion yaw then pitch + look_at_rh)", () => {
    for (const [yaw, pitch] of [[0, 0], [0.4, -0.2], [-1.1, 0.5], [2.5, 0.9]]) {
      const v = viewMatrix(synthRig.eye as V3, yaw, pitch);
      const { F, R, U } = cameraBasis(yaw, pitch, synthRig);
      // rows of the view rotation are right, up, -forward
      [v[0], v[4], v[8]].forEach((x, i) => expect(x).toBeCloseTo(R[i], 12));
      [v[1], v[5], v[9]].forEach((x, i) => expect(x).toBeCloseTo(U[i], 12));
      [v[2], v[6], v[10]].forEach((x, i) => expect(x).toBeCloseTo(-F[i], 12));
    }
  });
});

describe("yaw / pitch", () => {
  it("round-trips like Reco's yaw_pitch_to_direction_roundtrips_with_direction_to_yaw_pitch", () => {
    const eyes: Vec3[] = [[0.24, 0, 0.24], [0.3, 0, 0.2], [0.1, 0, 0.5]];
    for (const eye of eyes) {
      const rig = { ...recoRig, eye, baseForward: norm3([-eye[0], 0, -eye[2]]) };
      rig.baseRight = norm3([-rig.baseForward[2], 0, rig.baseForward[0]]); // bf x up
      for (const yaw of [-1.2, -0.6, -0.2, 0, 0.2, 0.6, 1.2]) {
        for (const pitch of [-0.9, -0.4, -0.1, 0, 0.1, 0.4, 0.9]) {
          const d = yawPitchToDirection(yaw, pitch, rig);
          expect(len(d)).toBeCloseTo(1, 12);
          const back = directionToYawPitch(d, rig);
          expect(back.yaw).toBeCloseTo(yaw, 10);
          expect(back.pitch).toBeCloseTo(pitch, 10);
          // scaling the direction changes nothing
          const back2 = directionToYawPitch([d[0] * 3, d[1] * 3, d[2] * 3], rig);
          expect(back2.yaw).toBeCloseTo(yaw, 10);
          expect(back2.pitch).toBeCloseTo(pitch, 10);
        }
      }
    }
  });
  it("yaw 0 looks at the corner where the planes meet; positive pitch looks up", () => {
    const d = yawPitchToDirection(0, 0, recoRig);
    d.forEach((v, i) => expect(v).toBeCloseTo([-Math.SQRT1_2, 0, -Math.SQRT1_2][i], 12));
    expect(yawPitchToDirection(0, 0.3, recoRig)[1]).toBeGreaterThan(0);
  });
  it("positive yaw looks toward the LEFT camera (pan left)", () => {
    for (const rig of [recoRig, synthRig]) {
      const toCentre = (o: Vec3): Vec3 => [o[0] - rig.eye[0], o[1] - rig.eye[1], o[2] - rig.eye[2]];
      expect(directionToYawPitch(toCentre(rig.cameras.left.origin), rig).yaw).toBeGreaterThan(0.3);
      expect(directionToYawPitch(toCentre(rig.cameras.right.origin), rig).yaw).toBeLessThan(-0.3);
      // the left edge of the screen has a larger yaw than the centre
      const pose = { yaw: 0.1, pitch: 0, fov: 30 };
      const leftEdge = directionToYawPitch(viewRay(pose, rig, -1, 0, ASPECT), rig);
      const rightEdge = directionToYawPitch(viewRay(pose, rig, 1, 0, ASPECT), rig);
      expect(leftEdge.yaw).toBeGreaterThan(pose.yaw);
      expect(rightEdge.yaw).toBeLessThan(pose.yaw);
      // a ray at positive yaw lands in the left camera only, negative yaw in the right camera only
      const l = sampleRay(yawPitchToDirection(0.7, 0, rig), rig);
      const r = sampleRay(yawPitchToDirection(-0.7, 0, rig), rig);
      expect(l.left).not.toBeNull();
      expect(l.right).toBeNull();
      expect(r.right).not.toBeNull();
      expect(r.left).toBeNull();
    }
  });
  it("Reco's test rig has the left camera centre near +42 degrees and the right near -42", () => {
    const scene = sceneOf(RECO_TEST_MATCH);
    const l = cameraToPanorama("left", 0.5, 0.5, RECO_TEST_MATCH, scene)!;
    const r = cameraToPanorama("right", 0.5, 0.5, RECO_TEST_MATCH, scene)!;
    expect(l.yaw / DEG).toBeCloseTo(42, -1);
    expect(r.yaw / DEG).toBeCloseTo(-42, -1);
  });
});

describe("viewRay", () => {
  it("goes through the pose direction at the centre of the screen", () => {
    for (const [yaw, pitch, fov] of [[0, 0, 40], [0.5, -0.2, 25], [-1, 0.3, 60]]) {
      const c = viewRay({ yaw, pitch, fov }, synthRig, 0, 0, ASPECT);
      const d = yawPitchToDirection(yaw, pitch, synthRig);
      c.forEach((v, i) => expect(v).toBeCloseTo(d[i], 12));
    }
  });
  it("spans the vertical fov top to bottom and fov*aspect sideways", () => {
    const pose = { yaw: 0.2, pitch: 0.1, fov: 40 };
    const top = viewRay(pose, synthRig, 0, 1, ASPECT);
    const bottom = viewRay(pose, synthRig, 0, -1, ASPECT);
    expect(Math.acos(dot(top, bottom)) / DEG).toBeCloseTo(40, 9);
    expect(directionToYawPitch(top, synthRig).pitch).toBeCloseTo(0.1 + 20 * DEG, 9);
    const left = viewRay(pose, synthRig, -1, 0, ASPECT);
    const right = viewRay(pose, synthRig, 1, 0, ASPECT);
    const hfov = 2 * Math.atan(ASPECT * Math.tan(20 * DEG));
    expect(Math.acos(dot(left, right))).toBeCloseTo(hfov, 9);
  });
});

/**
 * Independent check of sampleRay against Reco's raster path: put a point on a
 * plane quad, project it through Perspective3 * view_matrix * model, then cast
 * the ray for that screen point and compare the source pixel it samples with
 * forward_fisheye of the quad point.
 */
describe("sampleRay vs Reco's raster path", () => {
  for (const [name, match] of [["Reco test rig", RECO_TEST_MATCH], ["synthetic footage", synthMatch]] as const) {
    it(`agrees for ${name}`, () => {
      const rig = rigOf(match);
      const scene = sceneOf(match);
      let checked = 0;
      for (const [yaw, pitch, fov] of [[0, 0, 40], [0.6, -0.15, 30], [-0.6, 0.1, 25], [0.05, -0.05, 50], [1.0, 0, 20]]) {
        const pv = m4mul(perspective(ASPECT, fov * DEG), viewMatrix(scene.eye, yaw, pitch));
        for (const side of ["left", "right"] as const) {
          const model = side === "left" ? scene.modelLeft : scene.modelRight;
          const cam = side === "left" ? match.left_uniforms : match.right_uniforms;
          for (let i = 0; i <= 40; i++) {
            for (let j = 0; j <= 40; j++) {
              const tu = 0.01 + 0.98 * (i / 40), tv = 0.01 + 0.98 * (j / 40);
              const clip = m4apply(m4mul(pv, model), [tu - 0.5, (0.5 - tv) / scene.planeAspect, 0, 1]);
              if (clip[3] <= 0) continue;
              const nx = clip[0] / clip[3], ny = clip[1] / clip[3];
              if (Math.abs(nx) > 1 || Math.abs(ny) > 1) continue;
              const [u, v] = forwardFisheye(tu * 2 - 0.5, tv * 2 - 0.5, cam);
              const s = sampleRay(viewRay({ yaw, pitch, fov }, rig, nx, ny, ASPECT), rig)[side];
              if (u < 0 || u > 1 || v < 0 || v > 1) {
                expect(s).toBeNull(); // outside the source frame: transparent
                continue;
              }
              expect(s).not.toBeNull();
              expect(s!.u).toBeCloseTo(u, 9);
              expect(s!.v).toBeCloseTo(v, 9);
              const ux = tu * 2 - 0.5;
              const t = Math.min(Math.max(ux / 0.15, 0), 1);
              expect(s!.alpha).toBeCloseTo(side === "left" ? 1 : t * t * (3 - 2 * t), 9);
              checked++;
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(1000);
    });
  }

  it("round-trips camera_to_panorama: a source pixel's yaw/pitch samples that same pixel", () => {
    for (const match of [RECO_TEST_MATCH, synthMatch]) {
      const rig = rigOf(match);
      const scene = sceneOf(match);
      for (const side of ["left", "right"] as const) {
        for (let i = 0; i <= 5; i++) {
          for (let j = 0; j <= 5; j++) {
            const nx = 0.3 + 0.08 * i, ny = 0.3 + 0.08 * j;
            const p = cameraToPanorama(side, nx, ny, match, scene)!;
            const s = sampleRay(yawPitchToDirection(p.yaw, p.pitch, rig), rig)[side];
            expect(s).not.toBeNull();
            expect(s!.u).toBeCloseTo(nx, 5); // camera_to_panorama runs in f32
            expect(s!.v).toBeCloseTo(ny, 5);
          }
        }
      }
    }
  });

  it("misses rays that point away from the planes", () => {
    const away = sampleRay(yawPitchToDirection(Math.PI, 0, synthRig), synthRig);
    expect(away.left).toBeNull();
    expect(away.right).toBeNull();
    const up = sampleRay([0, 1, 0], synthRig);
    expect(up.left).toBeNull();
    expect(up.right).toBeNull();
  });

  it("blends the right camera in over blendWidth of its left edge", () => {
    const rig = { ...synthRig, blendWidth: 0 };
    const p = yawPitchToDirection(-0.7, 0, rig);
    expect(sampleRay(p, rig).right!.alpha).toBe(1);
  });
});

describe("frustumOutline", () => {
  it("walks the four edges with the corners at the view corners", () => {
    const pose = { yaw: 0.3, pitch: -0.1, fov: 30 };
    const pts = frustumOutline(pose, synthRig, ASPECT, 8);
    expect(pts).toHaveLength(32);
    const corner = (x: number, y: number) => directionToYawPitch(viewRay(pose, synthRig, x, y, ASPECT), synthRig);
    expect(pts[0]).toEqual(corner(-1, 1));
    expect(pts[8]).toEqual(corner(1, 1));
    expect(pts[16]).toEqual(corner(1, -1));
    expect(pts[24]).toEqual(corner(-1, -1));
    // top-left corner is left of (larger yaw) and above the centre
    expect(pts[0].yaw).toBeGreaterThan(pose.yaw);
    expect(pts[0].pitch).toBeGreaterThan(pose.pitch);
    expect(frustumOutline(pose, synthRig, ASPECT)).toHaveLength(64);
  });
});

function norm3(v: Vec3): Vec3 {
  const l = len(v);
  return [v[0] / l, v[1] / l, v[2] / l];
}
