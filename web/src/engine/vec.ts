// Small 3D vector helpers shared by the projection and rig-correction code.
import type { Vec3 } from "./types";

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** a·s + b·t */
export const combine = (a: Vec3, s: number, b: Vec3, t: number): Vec3 => [
  a[0] * s + b[0] * t,
  a[1] * s + b[1] * t,
  a[2] * s + b[2] * t,
];

/** 3x3 matrix as rows. */
export type Mat3 = [Vec3, Vec3, Vec3];

export const IDENTITY3: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

export const mul3 = (a: Mat3, b: Mat3): Mat3 =>
  [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j])) as Mat3;

export const column = (m: Mat3, j: number): Vec3 => [m[0][j], m[1][j], m[2][j]];

/** m·v */
export const apply3 = (m: Mat3, v: Vec3): Vec3 => [dot(m[0], v), dot(m[1], v), dot(m[2], v)];

/** mᵀ·v (the inverse rotation for a rotation matrix). */
export const applyT3 = (m: Mat3, v: Vec3): Vec3 => [
  m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
  m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
  m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
];

/**
 * Rotation by `angle` (radians, right-hand rule) about a unit `axis`, as a
 * matrix: nalgebra's UnitQuaternion::from_axis_angle.
 */
export function axisAngle(axis: Vec3, angle: number): Mat3 {
  const [x, y, z] = axis;
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

/** Rotate `v` by `angle` about a unit `axis` (Rodrigues). */
export function rotate(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle), s = Math.sin(angle);
  const k = dot(axis, v) * (1 - c);
  const ax = cross(axis, v);
  return [v[0] * c + ax[0] * s + axis[0] * k, v[1] * c + ax[1] * s + axis[1] * k, v[2] * c + ax[2] * s + axis[2] * k];
}
