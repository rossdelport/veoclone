// Test-only ports of Reco code that the editor does not need at runtime but
// that give independent answers to check the engine against:
// - CoverageBoundary::from_calibration (projection/coverage.rs) with
//   camera_to_panorama / inverse_fisheye / plane_uv_to_world
//   (projection/mod.rs), so clamp tests can use real coverage tables;
// - the raster path of renderer.rs: model matrices, view_matrix (quaternion
//   form, with look_at_rh) and Perspective3, so sampleRay can be checked
//   against "project the plane quads through an MVP".
import type { CalibInfo, CameraUniforms, Coverage, MatchCalibration } from "../../src/engine/types";

export type V3 = [number, number, number];

// Reco does the coverage maths in f32; with unusual lenses the 10th-percentile
// max fov is sensitive to that, so the coverage port rounds like Rust does.
const F = Math.fround;
export type M4 = number[]; // column-major 4x4

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function m4mul(a: M4, b: M4): M4 {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
export function m4apply(m: M4, v: [number, number, number, number]): [number, number, number, number] {
  const o: [number, number, number, number] = [0, 0, 0, 0];
  for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[r] += m[k * 4 + r] * v[k];
  return o;
}
function m4translate(t: V3): M4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
}
/** Rotation by angle around a unit axis (Rodrigues), as a 4x4. */
function m4axisAngle(axis: V3, a: number): M4 {
  const [x, y, z] = norm(axis);
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  // rows
  const r = [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
  return [r[0][0], r[1][0], r[2][0], 0, r[0][1], r[1][1], r[2][1], 0, r[0][2], r[1][2], r[2][2], 0, 0, 0, 0, 1];
}
const applyRot = (m: M4, v: V3): V3 => m4apply(m, [v[0], v[1], v[2], 0]).slice(0, 3) as V3;

/** nalgebra UnitQuaternion::from_euler_angles(roll, pitch, yaw) = Rz(yaw)·Ry(pitch)·Rx(roll). */
function euler(roll: number, pitch: number, yaw: number): M4 {
  return m4mul(m4axisAngle([0, 0, 1], yaw), m4mul(m4axisAngle([0, 1, 0], pitch), m4axisAngle([1, 0, 0], roll)));
}

export interface Scene {
  modelLeft: M4;
  modelRight: M4;
  eye: V3;
  planeAspect: number;
}

/** SceneGeometry::from_layout_with_aspect + model_matrix_left/right. */
export function sceneOf(match: MatchCalibration): Scene {
  const p = match.params;
  const h = 0.5 * (1 - p.intersect);
  const base = euler(0, Math.PI / 2, p.zRz);
  const roll = euler(p.zRx, 0, 0);
  return {
    modelLeft: m4mul(m4translate([0, 0, h]), m4mul(roll, base)),
    modelRight: m4mul(m4translate([h, p.xTy, 0]), euler(p.xRx, 0, p.xRz)),
    eye: [p.cameraAxisOffset, 0, p.cameraAxisOffset],
    planeAspect: match.left_uniforms.width / match.left_uniforms.height,
  };
}

function basis(eye: V3) {
  const bf = norm([-eye[0], -eye[1], -eye[2]]);
  const br = norm(cross(bf, [0, 1, 0]));
  return { bf, br };
}

/** VirtualCamera::direction_to_yaw_pitch. */
export function dirToYawPitch(dir: V3, eye: V3): { yaw: number; pitch: number } {
  const { bf, br } = basis(eye);
  const pitch = Math.asin(Math.max(-1, Math.min(1, dir[1])));
  const hl = Math.hypot(dir[0], dir[2]);
  if (hl <= 1e-6) return { yaw: 0, pitch };
  const hz: V3 = [dir[0] / hl, 0, dir[2] / hl];
  return { yaw: Math.atan2(-dot(hz, br), Math.max(-1, Math.min(1, dot(hz, bf)))), pitch };
}

const kb4ThetaD = (t: number, d: number[]) => {
  const t2 = t * t, t4 = t2 * t2, t6 = t4 * t2, t8 = t4 * t4;
  return t * (1 + d[0] * t2 + d[1] * t4 + d[2] * t6 + d[3] * t8);
};
const kb4ThetaDPrime = (t: number, d: number[]) => {
  const t2 = t * t, t4 = t2 * t2, t6 = t4 * t2, t8 = t4 * t4;
  return 1 + 3 * d[0] * t2 + 5 * d[1] * t4 + 7 * d[2] * t6 + 9 * d[3] * t8;
};

/** forward_fisheye: extended plane uv -> normalised distorted pixel. */
export function forwardFisheye(ux: number, uy: number, c: CameraUniforms): [number, number] {
  const fx = c.fx / c.width, fy = c.fy / c.height, cx = c.cx / c.width, cy = c.cy / c.height;
  const x = (ux - cx) / fx, y = (uy - cy) / fy;
  const r = Math.hypot(x, y);
  if (r < 1e-12) return [cx, cy];
  const scale = r < 1e-10 ? 1 : kb4ThetaD(Math.atan(r), c.d) / r;
  return [fx * x * scale + cx, fy * y * scale + cy];
}

/** inverse_fisheye: normalised distorted pixel -> extended plane uv (Newton-Raphson). */
export function inverseFisheye(nx: number, ny: number, c: CameraUniforms): [number, number] | null {
  const fx = c.fx / c.width, fy = c.fy / c.height, cx = c.cx / c.width, cy = c.cy / c.height;
  const dx = (nx - cx) / fx, dy = (ny - cy) / fy;
  const thetaD = Math.hypot(dx, dy);
  if (thetaD < 1e-12) return [cx, cy];
  let theta = thetaD;
  for (let i = 0; i < 20; i++) {
    const f = kb4ThetaD(theta, c.d) - thetaD;
    const fp = kb4ThetaDPrime(theta, c.d);
    if (Math.abs(fp) < 1e-15) return null;
    const delta = f / fp;
    theta -= delta;
    if (Math.abs(delta) < 1e-10) break;
  }
  const r = Math.tan(theta);
  const scale = Math.abs(theta) < 1e-12 ? 1 : thetaD / r;
  if (!Number.isFinite(scale)) return null;
  return [fx * (dx / scale) + cx, fy * (dy / scale) + cy];
}

/** camera_to_panorama: source pixel (0..1) -> yaw/pitch. */
export function cameraToPanorama(
  side: "left" | "right",
  nx: number,
  ny: number,
  match: MatchCalibration,
  scene: Scene,
): { yaw: number; pitch: number } | null {
  const cam = side === "left" ? match.left_uniforms : match.right_uniforms;
  const uv = inverseFisheye(nx, ny, cam);
  if (!uv) return null;
  // plane_uv_to_world and the direction are f32 in Rust.
  const tu = F((uv[0] + 0.5) / 2), tv = F((uv[1] + 0.5) / 2);
  const local: [number, number, number, number] = [F(tu - 0.5), F(F(0.5 - tv) / F(scene.planeAspect)), 0, 1];
  const model = (side === "left" ? scene.modelLeft : scene.modelRight).map(F);
  const w = m4apply(model, local).map(F);
  const dir = norm(sub([w[0], w[1], w[2]], scene.eye.map(F) as V3).map(F) as V3).map(F) as V3;
  const yp = dirToYawPitch(dir, scene.eye);
  return { yaw: F(yp.yaw), pitch: F(yp.pitch) };
}

/** Full port of CoverageBoundary::from_calibration, returned as the helper's CalibInfo.coverage. */
export function coverageFromMatch(match: MatchCalibration): Coverage & { leftSlices: [number, number][]; rightSlices: [number, number][] } {
  const scene = sceneOf(match);
  const nSlices = 400;
  const margin = F(0.02);
  const pts: Record<"left" | "right", [number, number][]> = { left: [], right: [] };
  for (const side of ["left", "right"] as const) {
    const add = (nx: number, ny: number) => {
      const p = cameraToPanorama(side, nx, ny, match, scene);
      if (p) pts[side].push([p.yaw, p.pitch]);
    };
    const at = (i: number, steps: number) => F(margin + F(F(1 - 2 * margin) * F(i / steps)));
    for (let i = 0; i <= 400; i++) {
      const t = at(i, 400);
      add(t, margin);
      add(t, F(1 - margin));
      add(margin, t);
      add(F(1 - margin), t);
    }
    for (let ix = 0; ix <= 20; ix++) {
      for (let iy = 0; iy <= 20; iy++) add(at(ix, 20), at(iy, 20));
    }
  }
  let pmin = Infinity, pmax = -Infinity;
  for (const [, p] of [...pts.left, ...pts.right]) {
    pmin = Math.min(pmin, p);
    pmax = Math.max(pmax, p);
  }
  const range = F(pmax - pmin);
  const sliceSize = F(range / nSlices);
  const empty = (): [number, number][] => Array.from({ length: nSlices }, () => [Infinity, -Infinity]);
  const slices = empty(), left = empty(), right = empty();
  const idx = (p: number) => Math.min(Math.floor(F(F(p - pmin) / sliceSize)), nSlices - 1);
  for (const [side, table] of [["left", left], ["right", right]] as const) {
    for (const [y, p] of pts[side]) {
      const s = idx(p);
      table[s][0] = Math.min(table[s][0], y);
      table[s][1] = Math.max(table[s][1], y);
      slices[s][0] = Math.min(slices[s][0], y);
      slices[s][1] = Math.max(slices[s][1], y);
    }
  }
  // min pitch range: 10th percentile pitch span over 51 yaw samples.
  let yawLo = Infinity, yawHi = -Infinity;
  for (const s of slices.slice(nSlices / 4, (3 * nSlices) / 4)) {
    if (s[0] <= s[1]) {
      yawLo = Math.min(yawLo, s[0]);
      yawHi = Math.max(yawHi, s[1]);
    }
  }
  let minPitchRange = range;
  if (yawLo < yawHi) {
    const ranges: number[] = [];
    for (let j = 0; j <= 50; j++) {
      const ty = F(yawLo + F(F(j / 50) * F(yawHi - yawLo)));
      let lo = Infinity, hi = -Infinity;
      for (let s = 0; s < nSlices; s++) {
        const inL = left[s][0] <= left[s][1] && ty >= left[s][0] && ty <= left[s][1];
        const inR = right[s][0] <= right[s][1] && ty >= right[s][0] && ty <= right[s][1];
        if (inL || inR) {
          const p = F(pmin + F(F(s + 0.5) * sliceSize));
          lo = Math.min(lo, p);
          hi = Math.max(hi, p);
        }
      }
      if (hi > lo) ranges.push(F(hi - lo));
    }
    if (ranges.length) {
      ranges.sort((a, b) => a - b);
      minPitchRange = ranges[Math.min(Math.floor(ranges.length / 10), ranges.length - 1)];
    }
  }
  for (let i = 1; i < nSlices; i++) {
    if (slices[i][0] > slices[i][1]) {
      slices[i] = [...slices[i - 1]];
      left[i] = [...left[i - 1]];
      right[i] = [...right[i - 1]];
    }
  }
  for (let i = nSlices - 2; i >= 0; i--) {
    if (slices[i][0] > slices[i][1]) {
      slices[i] = [...slices[i + 1]];
      left[i] = [...left[i + 1]];
      right[i] = [...right[i + 1]];
    }
  }
  return {
    pitchMin: pmin,
    pitchMax: pmax,
    maxFovDeg: minPitchRange <= 0 ? 20 : F(minPitchRange * F(180 / Math.PI)),
    slices,
    leftSlices: left,
    rightSlices: right,
  };
}

/** renderer.rs view_matrix (quaternion form, no rig tilt/roll) + look_at_rh. */
export function viewMatrix(eye: V3, yaw: number, pitch: number): M4 {
  const { bf, br } = basis(eye);
  const up: V3 = [0, 1, 0];
  const yawQ = m4axisAngle(up, yaw);
  const right = applyRot(yawQ, br);
  const pitchQ = m4axisAngle(right, pitch);
  const rot = m4mul(pitchQ, yawQ);
  const f = norm(applyRot(rot, bf));
  const u = applyRot(rot, up);
  // look_at_rh: camera looks down -Z.
  const z = [-f[0], -f[1], -f[2]] as V3;
  const x = norm(cross(u, z));
  const y = cross(z, x);
  return [
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ];
}

/** nalgebra Perspective3::new(aspect, fovy, near, far) (OpenGL convention). */
export function perspective(aspect: number, fovy: number, near = 0.01, far = 5): M4 {
  const f = 1 / Math.tan(fovy / 2);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];
}

/** A minimal CalibInfo around a match calibration. */
export function calibInfoOf(match: MatchCalibration, coverage: Coverage, frameCount = 300): CalibInfo {
  return {
    fps: { num: 30, den: 1 },
    frameCount,
    proxy: { url: "", tileWidth: 1280, tileHeight: 720, layout: "vstack" },
    match,
    coverage: { pitchMin: coverage.pitchMin, pitchMax: coverage.pitchMax, maxFovDeg: coverage.maxFovDeg, slices: coverage.slices },
    render: { blendWidth: 0.15, lensCorrection: 1.0, outputAspect: 16 / 9 },
  };
}

/** Reco's own test calibration (projection/mod.rs tests: GoPro HERO10 4K). */
export const RECO_TEST_MATCH: MatchCalibration = {
  left_uniforms: { width: 3840, height: 2160, fx: 1796.32, fy: 1797.22, cx: 1919.37, cy: 1063.17, d: [0.0342, 0.0677, -0.0741, 0.0299] },
  right_uniforms: { width: 3840, height: 2160, fx: 1796.32, fy: 1797.22, cx: 1919.37, cy: 1063.17, d: [0.0342, 0.0677, -0.0741, 0.0299] },
  params: { cameraAxisOffset: 0.2398, intersect: 0.5446, xTy: 0.00476, xRz: 0.00753, zRx: -0.00431, xRx: 0, zRz: 0 },
  rig_tilt: 0,
  rig_roll: 0,
  sync_offset: 0,
  field_roi: null,
  lens_correction_amount: 1,
  blend_width: 0.05,
};
