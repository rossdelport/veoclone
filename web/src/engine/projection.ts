// Port of Reco's render geometry: render/scene.rs (planes),
// render/renderer.rs (view matrix, quads), shaders/fisheye.wgsl (lens and
// blending) and projection/virtual_camera.rs (yaw/pitch basis).
// Rig tilt/roll are assumed to be 0 (true for iPhone footage).
import type { CalibInfo, CameraUniforms, Pose, Vec3 } from "./types";

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

export type RaySample = { u: number; v: number; alpha: number };

const DEG = Math.PI / 180;
const UP: Vec3 = [0, 1, 0];

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

type Mat3 = [Vec3, Vec3, Vec3]; // rows

const mul = (a: Mat3, b: Mat3): Mat3 =>
  [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j])) as Mat3;
const column = (m: Mat3, j: number): Vec3 => [m[0][j], m[1][j], m[2][j]];

function rotX(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [[1, 0, 0], [0, c, -s], [0, s, c]];
}
function rotY(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
}
function rotZ(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}

function rigCamera(origin: Vec3, rot: Mat3, cam: CameraUniforms): RigCamera {
  return {
    origin,
    ex: column(rot, 0),
    ey: column(rot, 1),
    n: column(rot, 2),
    intrinsics: [cam.fx / cam.width, cam.fy / cam.height, cam.cx / cam.width, cam.cy / cam.height],
    d: [cam.d[0], cam.d[1], cam.d[2], cam.d[3]],
  };
}

export function buildRig(calib: CalibInfo): Rig {
  const { params, left_uniforms: left, right_uniforms: right } = calib.match;
  // SceneGeometry::from_layout_with_aspect: plane width 1, both planes use
  // the left camera's aspect.
  const h = 0.5 * (1 - params.intersect);
  const c = params.cameraAxisOffset;
  const eye: Vec3 = [c, 0, c];
  const baseForward = normalize([-c, 0, -c]);
  const baseRight = normalize(cross(baseForward, UP));
  // nalgebra from_euler_angles(r, p, y) = Rz(y)·Ry(p)·Rx(r).
  const rotLeft = mul(rotX(params.zRx ?? 0), mul(rotZ(params.zRz ?? 0), rotY(Math.PI / 2)));
  const rotRight = mul(rotZ(params.xRz ?? 0), rotX(params.xRx ?? 0));
  const blend = calib.render?.blendWidth;
  const correction = calib.render?.lensCorrection;
  return {
    eye,
    baseForward,
    baseRight,
    cameras: {
      left: rigCamera([0, 0, h], rotLeft, left),
      right: rigCamera([h, params.xTy ?? 0, 0], rotRight, right),
    },
    planeAspect: left.width / left.height,
    blendWidth: Number.isFinite(blend) ? blend : 0.15,
    lensCorrection: Number.isFinite(correction) ? correction : 1.0,
  };
}

/** Direction for a yaw/pitch (Reco's yaw_pitch_to_direction). */
export function yawPitchToDirection(yaw: number, pitch: number, rig: Rig): Vec3 {
  const cp = Math.cos(pitch);
  const a = cp * Math.cos(yaw);
  const b = cp * Math.sin(yaw);
  const bf = rig.baseForward, br = rig.baseRight;
  return [bf[0] * a - br[0] * b, Math.sin(pitch), bf[2] * a - br[2] * b];
}

/** Yaw/pitch of a direction (Reco's direction_to_yaw_pitch). */
export function directionToYawPitch(dir: Vec3, rig: Rig): { yaw: number; pitch: number } {
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  const pitch = Math.asin(Math.min(Math.max(dir[1] / len, -1), 1));
  const hLen = Math.hypot(dir[0], dir[2]);
  if (!(hLen / len > 1e-6)) return { yaw: 0, pitch };
  const h: Vec3 = [dir[0] / hLen, 0, dir[2] / hLen];
  const cosYaw = Math.min(Math.max(dot(h, rig.baseForward), -1), 1);
  const sinYaw = -dot(h, rig.baseRight);
  return { yaw: Math.atan2(sinYaw, cosYaw), pitch };
}

/**
 * Virtual camera basis for a pose: forward F, screen right R, screen up U
 * (the closed form of renderer.rs view_matrix with no rig tilt/roll).
 */
export function cameraBasis(yaw: number, pitch: number, rig: Rig): { F: Vec3; R: Vec3; U: Vec3 } {
  const bf = rig.baseForward, br = rig.baseRight;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const hz: Vec3 = [cy * bf[0] - sy * br[0], 0, cy * bf[2] - sy * br[2]];
  return {
    F: [cp * hz[0], sp, cp * hz[2]],
    R: [cy * br[0] + sy * bf[0], 0, cy * br[2] + sy * bf[2]],
    U: [-sp * hz[0], cp, -sp * hz[2]],
  };
}

/** World ray through a point of the virtual camera; ndc in [-1,1], y = +1 at the top. */
export function viewRay(pose: Pose, rig: Rig, ndcX: number, ndcY: number, aspect: number): Vec3 {
  const { F, R, U } = cameraBasis(pose.yaw, pose.pitch, rig);
  const t = Math.tan(pose.fov * 0.5 * DEG);
  const x = ndcX * t * aspect;
  const y = ndcY * t;
  return normalize([F[0] + x * R[0] + y * U[0], F[1] + x * R[1] + y * U[1], F[2] + x * R[2] + y * U[2]]);
}

function sampleCamera(ray: Vec3, rig: Rig, cam: RigCamera, isRight: boolean): RaySample | null {
  // Ray / plane intersection (the quad drawn by renderer.rs).
  const denom = dot(ray, cam.n);
  if (Math.abs(denom) < 1e-6) return null;
  const o = cam.origin, e = rig.eye;
  const toPlane: Vec3 = [o[0] - e[0], o[1] - e[1], o[2] - e[2]];
  const t = dot(toPlane, cam.n) / denom;
  if (!(t > 0)) return null;
  const rel: Vec3 = [t * ray[0] - toPlane[0], t * ray[1] - toPlane[1], t * ray[2] - toPlane[2]];
  const tu = dot(rel, cam.ex) + 0.5;
  const tv = 0.5 - dot(rel, cam.ey) * rig.planeAspect;
  if (tu < 0 || tu > 1 || tv < 0 || tv > 1) return null;

  // fisheye.wgsl fs_main: extended uv, KB4 distortion, bounds, blend alpha.
  const ux = tu * 2 - 0.5;
  const uy = tv * 2 - 0.5;
  const [fx, fy, cx, cy] = cam.intrinsics;
  const [k1, k2, k3, k4] = cam.d;
  const x = (ux - cx) / fx;
  const y = (uy - cy) / fy;
  const r = Math.sqrt(x * x + y * y);
  const theta = Math.atan(r);
  const t2 = theta * theta;
  const thetaFull = theta * (1 + k1 * t2 + k2 * t2 * t2 + k3 * t2 * t2 * t2 + k4 * t2 * t2 * t2 * t2);
  const thetaD = theta + (thetaFull - theta) * rig.lensCorrection;
  const scale = r > 0 ? thetaD / r : 1;
  const u = fx * x * scale + cx;
  const v = fy * y * scale + cy;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;

  let alpha = 1;
  if (isRight && rig.blendWidth > 0) {
    const s = Math.min(Math.max(ux / rig.blendWidth, 0), 1);
    alpha = s * s * (3 - 2 * s);
  }
  return { u, v, alpha };
}

/**
 * Where a ray lands in each source camera (CPU mirror of the shader, for tests
 * and picking): normalised source uv (0..1, v=0 top) and blend alpha.
 */
export function sampleRay(ray: Vec3, rig: Rig): { left: RaySample | null; right: RaySample | null } {
  return {
    left: sampleCamera(ray, rig, rig.cameras.left, false),
    right: sampleCamera(ray, rig, rig.cameras.right, true),
  };
}

/** Outline of the virtual camera's view as yaw/pitch points (for the overview rectangle). */
export function frustumOutline(pose: Pose, rig: Rig, aspect: number, stepsPerEdge = 16): { yaw: number; pitch: number }[] {
  const steps = Math.max(1, Math.round(stepsPerEdge));
  // Clockwise from the top-left corner: top, right, bottom, left edges.
  const corners: [number, number][] = [[-1, 1], [1, 1], [1, -1], [-1, -1]];
  const out: { yaw: number; pitch: number }[] = [];
  for (let e = 0; e < 4; e++) {
    const [x0, y0] = corners[e];
    const [x1, y1] = corners[(e + 1) % 4];
    for (let i = 0; i < steps; i++) {
      const s = i / steps;
      out.push(directionToYawPitch(viewRay(pose, rig, x0 + (x1 - x0) * s, y0 + (y1 - y0) * s, aspect), rig));
    }
  }
  return out;
}
