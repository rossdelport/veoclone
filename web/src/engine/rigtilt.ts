// Port of Reco's rig tilt / roll correction ("Straighten picture"):
// - the rig part of render/renderer.rs `view_matrix` (the base forward and
//   world up are turned about the base right axis by `rig_tilt`, then the up
//   axis about the tilted forward by `-rig_roll`; yaw turns about that up
//   axis and pitch about the yawed, un-rolled base right axis);
// - lens/rig_correction.rs: `world_to_render_pose` (what
//   session/frame_processing.rs `director_position` applies to every clamped
//   world pose a Panner returns), `render_pitch`, `human_to_world_pitch` and
//   `world_to_human_pitch`.
// Reco's thresholds are kept: a tilt or roll of at most 1e-6 radians is not
// applied, and with neither applied every function here is the identity, so
// footage without straightening gives exactly the old (rig 0) results.
//
// Three ways to describe where the virtual camera points:
// - world pose: what a Reco Panner returns and what the export path holds;
//   clamped against the coverage table (world space);
// - render pose: what view_matrix receives (world_to_render_pose of the
//   world pose); yaw turns about the straightened up axis, so the overview
//   drawn in render yaw/pitch is level;
// - aim: yaw/pitch (in Reco's un-tilted yaw_pitch_to_direction sense) of the
//   direction the centre of the picture looks at. Without rig tilt/roll all
//   three are the same. The AI path (made with match.json's rig, 0 for
//   iPhones) and the editor's keyframes are stored as aims, so changing the
//   straightening never moves what they look at.
import type { Vec3 } from "./types";
import { applyT3, apply3, axisAngle, combine, cross, dot, IDENTITY3, mul3, normalize, rotate, type Mat3 } from "./vec";

/** Reco's virtual camera basis (VirtualCamera::new): base forward and base right. */
export interface Basis {
  baseForward: Vec3;
  baseRight: Vec3;
}

export interface YawPitch {
  yaw: number;
  pitch: number;
}

const UP: Vec3 = [0, 1, 0];
/** Reco skips a rig tilt or roll whose size is not above this (radians). */
const RIG_EPS = 1e-6;

/** Direction for a yaw/pitch (Reco's yaw_pitch_to_direction). */
export function yawPitchToDirection(yaw: number, pitch: number, b: Basis): Vec3 {
  const cp = Math.cos(pitch);
  const a = cp * Math.cos(yaw);
  const s = cp * Math.sin(yaw);
  const bf = b.baseForward, br = b.baseRight;
  return [bf[0] * a - br[0] * s, Math.sin(pitch), bf[2] * a - br[2] * s];
}

/** Yaw/pitch of a direction (Reco's direction_to_yaw_pitch). */
export function directionToYawPitch(dir: Vec3, b: Basis): YawPitch {
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  const pitch = Math.asin(Math.min(Math.max(dir[1] / len, -1), 1));
  const hLen = Math.hypot(dir[0], dir[2]);
  if (!(hLen / len > 1e-6)) return { yaw: 0, pitch };
  const h: Vec3 = [dir[0] / hLen, 0, dir[2] / hLen];
  const cosYaw = Math.min(Math.max(dot(h, b.baseForward), -1), 1);
  const sinYaw = -dot(h, b.baseRight);
  return { yaw: Math.atan2(sinYaw, cosYaw), pitch };
}

/** Reco's rig tilt and roll and the turned basis view_matrix builds from them. */
export interface TiltFrame {
  /** Reco's `rig_tilt` in radians: positive = the phones point down. */
  tilt: number;
  /** Reco's `rig_roll` in radians: positive = the phones lean to the right (clockwise seen from behind). */
  roll: number;
  hasTilt: boolean;
  hasRoll: boolean;
  /** Neither is applied: every conversion is the identity. */
  identity: boolean;
  /** Base forward after the tilt. */
  forward: Vec3;
  /** World up after the tilt (before the roll). */
  tiltedUp: Vec3;
  /** The yaw axis: world up after the tilt and the roll. */
  up: Vec3;
  /** Base right (the tilt axis; view_matrix pitches about it, yawed but not rolled). */
  right: Vec3;
  /** up · tiltedUp (cos of the roll, 1 without roll). */
  upDotTilted: number;
  /** The roll-after-tilt rotation (rows): world direction = rot · render direction. */
  rot: Mat3;
}

/** The basis view_matrix uses for `rig_tilt` / `rig_roll` (radians). */
export function tiltFrame(b: Basis, tilt: number, roll: number): TiltFrame {
  const t = Number.isFinite(tilt) ? tilt : 0;
  const r = Number.isFinite(roll) ? roll : 0;
  const hasTilt = Math.abs(t) > RIG_EPS;
  const hasRoll = Math.abs(r) > RIG_EPS;
  const right = b.baseRight;
  let forward = b.baseForward;
  let up = UP;
  let rot = IDENTITY3;
  if (hasTilt) {
    forward = rotate(b.baseForward, right, t);
    up = rotate(UP, right, t);
    rot = axisAngle(right, t);
  }
  const tiltedUp = up;
  if (hasRoll) {
    up = rotate(tiltedUp, forward, -r);
    rot = mul3(axisAngle(forward, -r), rot);
  }
  return {
    tilt: t,
    roll: r,
    hasTilt,
    hasRoll,
    identity: !hasTilt && !hasRoll,
    forward,
    tiltedUp,
    up,
    right,
    upDotTilted: dot(up, tiltedUp),
    rot,
  };
}

/**
 * Reco's world_to_render_pose: the render yaw/pitch for a world pose (the
 * inverse of the tilt+roll rotation, decomposed with the un-tilted basis).
 */
export function worldToRenderPose(w: YawPitch, b: Basis, f: TiltFrame): YawPitch {
  if (f.identity) return { yaw: w.yaw, pitch: w.pitch };
  return directionToYawPitch(applyT3(f.rot, yawPitchToDirection(w.yaw, w.pitch, b)), b);
}

/** Exact inverse of worldToRenderPose (for |pitch| < 90°). */
export function renderToWorldPose(r: YawPitch, b: Basis, f: TiltFrame): YawPitch {
  if (f.identity) return { yaw: r.yaw, pitch: r.pitch };
  return directionToYawPitch(apply3(f.rot, yawPitchToDirection(r.yaw, r.pitch, b)), b);
}

/**
 * Where view_matrix looks for a render pose: forward = yaw about the
 * straightened up axis of (pitch about base right of the tilted forward).
 */
export function renderForward(yaw: number, pitch: number, b: Basis, f: TiltFrame): Vec3 {
  if (f.identity) return yawPitchToDirection(yaw, pitch, b);
  return rotate(combine(f.forward, Math.cos(pitch), f.tiltedUp, Math.sin(pitch)), f.up, yaw);
}

/** view_matrix's camera for a render pose: forward F, screen right R, screen up U (look_at_rh). */
export function renderBasis(yaw: number, pitch: number, b: Basis, f: TiltFrame): { F: Vec3; R: Vec3; U: Vec3 } {
  const F = renderForward(yaw, pitch, b, f);
  // up = yaw_q · pitch_q' · up, with pitch_q' about the un-yawed base right.
  const up = rotate(rotate(f.up, f.right, pitch), f.up, yaw);
  const R = normalize(cross(F, up));
  return { F, R, U: cross(R, F) };
}

/** Inverse of renderForward: the render pose whose centre looks along `dir`. */
export function directionToRenderPose(dir: Vec3, b: Basis, f: TiltFrame): YawPitch {
  if (f.identity) return directionToYawPitch(dir, b);
  const d = normalize(dir);
  const du = dot(d, f.up);
  // The up component is kept by the yaw: sin(pitch) · (tiltedUp · up) = d · up.
  const pitch = Math.asin(Math.min(Math.max(du / f.upDotTilted, -1), 1));
  const v = combine(f.forward, Math.cos(pitch), f.tiltedUp, Math.sin(pitch));
  const vu = dot(v, f.up);
  const vp = combine(v, 1, f.up, -vu);
  const dp = combine(d, 1, f.up, -du);
  const yaw = Math.atan2(dot(cross(vp, dp), f.up), dot(vp, dp));
  return { yaw, pitch };
}

/** The aim (centre direction as un-tilted yaw/pitch) of a world pose, as Reco renders it. */
export function aimOfWorld(w: YawPitch, b: Basis, f: TiltFrame): YawPitch {
  if (f.identity) return { yaw: w.yaw, pitch: w.pitch };
  const r = worldToRenderPose(w, b, f);
  return directionToYawPitch(renderForward(r.yaw, r.pitch, b, f), b);
}

/** The world pose Reco renders looking at an aim. */
export function worldOfAim(a: YawPitch, b: Basis, f: TiltFrame): YawPitch {
  if (f.identity) return { yaw: a.yaw, pitch: a.pitch };
  return renderToWorldPose(directionToRenderPose(yawPitchToDirection(a.yaw, a.pitch, b), b, f), b, f);
}

/** The render pose looking at an aim. */
export function renderOfAim(a: YawPitch, b: Basis, f: TiltFrame): YawPitch {
  if (f.identity) return { yaw: a.yaw, pitch: a.pitch };
  return directionToRenderPose(yawPitchToDirection(a.yaw, a.pitch, b), b, f);
}

/** The aim of a render pose. */
export function aimOfRender(r: YawPitch, b: Basis, f: TiltFrame): YawPitch {
  if (f.identity) return { yaw: r.yaw, pitch: r.pitch };
  return directionToYawPitch(renderForward(r.yaw, r.pitch, b, f), b);
}

// ---------------------------------------------------------------------------
// The closed forms of lens/rig_correction.rs (Reco uses them in its preview
// and in CoverageBoundary::safe_clamp; the export path does not).
// ---------------------------------------------------------------------------

/** Reco's render_pitch: pitch for view_matrix so the horizon stays level at (yaw, user pitch). */
export function recoRenderPitch(userYaw: number, userPitch: number, rigTilt: number): number {
  if (Math.abs(rigTilt) < RIG_EPS) return userPitch;
  return userPitch - Math.atan(Math.cos(userYaw) * Math.tan(rigTilt));
}

function couplingFactor(yaw: number, rigTilt: number): number {
  const c = Math.cos(yaw), s = Math.sin(rigTilt), ct = Math.cos(rigTilt);
  return Math.sqrt(c * c * s * s + ct * ct);
}

/** Reco's human_to_world_pitch. */
export function recoHumanToWorldPitch(yaw: number, humanPitch: number, rigTilt: number): number {
  if (Math.abs(rigTilt) < RIG_EPS) return humanPitch;
  return Math.asin(Math.sin(humanPitch) * couplingFactor(yaw, rigTilt));
}

/** Reco's world_to_human_pitch. */
export function recoWorldToHumanPitch(yaw: number, worldPitch: number, rigTilt: number): number {
  if (Math.abs(rigTilt) < RIG_EPS) return worldPitch;
  const d = couplingFactor(yaw, rigTilt);
  if (Math.abs(d) < 1e-6) return worldPitch;
  return Math.asin(Math.min(Math.max(Math.sin(worldPitch) / d, -1), 1));
}

// ---------------------------------------------------------------------------
// Allocation-free bulk versions for computeFinalPath (90 minutes = 162,000
// frames on every edit). Same maths as renderOfAim / renderToWorldPose.
// ---------------------------------------------------------------------------

/** In place: aims -> render poses (renderOfAim on every element). */
export function aimsToRenderPoses(yaw: Float64Array, pitch: Float64Array, b: Basis, f: TiltFrame): void {
  if (f.identity) return;
  const [bf0, , bf2] = b.baseForward;
  const [br0, , br2] = b.baseRight;
  const [F0, F1, F2] = f.forward;
  const [T0, T1, T2] = f.tiltedUp;
  const [U0, U1, U2] = f.up;
  const k = f.upDotTilted;
  for (let i = 0; i < yaw.length; i++) {
    // d = yaw_pitch_to_direction(aim)
    const cp = Math.cos(pitch[i]);
    const a = cp * Math.cos(yaw[i]);
    const s = cp * Math.sin(yaw[i]);
    const d0 = bf0 * a - br0 * s, d1 = Math.sin(pitch[i]), d2 = bf2 * a - br2 * s;
    // directionToRenderPose(d) (d is a unit vector)
    const du = d0 * U0 + d1 * U1 + d2 * U2;
    const q = du / k;
    const rp = Math.asin(q < -1 ? -1 : q > 1 ? 1 : q);
    const c = Math.cos(rp), sn = Math.sin(rp);
    const v0 = F0 * c + T0 * sn, v1 = F1 * c + T1 * sn, v2 = F2 * c + T2 * sn;
    const vu = v0 * U0 + v1 * U1 + v2 * U2;
    const p0 = v0 - U0 * vu, p1 = v1 - U1 * vu, p2 = v2 - U2 * vu;
    const e0 = d0 - U0 * du, e1 = d1 - U1 * du, e2 = d2 - U2 * du;
    const x0 = p1 * e2 - p2 * e1, x1 = p2 * e0 - p0 * e2, x2 = p0 * e1 - p1 * e0;
    yaw[i] = Math.atan2(x0 * U0 + x1 * U1 + x2 * U2, p0 * e0 + p1 * e1 + p2 * e2);
    pitch[i] = rp;
  }
}

/** In place: render poses -> world poses (renderToWorldPose on every element). */
export function renderPosesToWorld(yaw: Float64Array, pitch: Float64Array, b: Basis, f: TiltFrame): void {
  if (f.identity) return;
  turnPoses(yaw, pitch, b, f.rot);
}

/** In place: world poses -> render poses (worldToRenderPose on every element). */
export function worldPosesToRender(yaw: Float64Array, pitch: Float64Array, b: Basis, f: TiltFrame): void {
  if (f.identity) return;
  const r = f.rot;
  turnPoses(yaw, pitch, b, [
    [r[0][0], r[1][0], r[2][0]],
    [r[0][1], r[1][1], r[2][1]],
    [r[0][2], r[1][2], r[2][2]],
  ]);
}

/** In place: yaw/pitch of rot · yaw_pitch_to_direction(yaw, pitch). */
function turnPoses(yaw: Float64Array, pitch: Float64Array, b: Basis, rot: Mat3): void {
  const [bf0, , bf2] = b.baseForward;
  const [br0, , br2] = b.baseRight;
  const [m0, m1, m2] = rot;
  for (let i = 0; i < yaw.length; i++) {
    const cp = Math.cos(pitch[i]);
    const a = cp * Math.cos(yaw[i]);
    const s = cp * Math.sin(yaw[i]);
    const d0 = bf0 * a - br0 * s, d1 = Math.sin(pitch[i]), d2 = bf2 * a - br2 * s;
    // world direction = rot · d, then direction_to_yaw_pitch
    const w0 = m0[0] * d0 + m0[1] * d1 + m0[2] * d2;
    const w1 = m1[0] * d0 + m1[1] * d1 + m1[2] * d2;
    const w2 = m2[0] * d0 + m2[1] * d1 + m2[2] * d2;
    const len = Math.hypot(w0, w1, w2);
    const q = w1 / len;
    pitch[i] = Math.asin(q < -1 ? -1 : q > 1 ? 1 : q);
    const hLen = Math.hypot(w0, w2);
    if (!(hLen / len > 1e-6)) {
      yaw[i] = 0;
      continue;
    }
    const h0 = w0 / hLen, h2 = w2 / hLen;
    const cy = h0 * bf0 + h2 * bf2;
    yaw[i] = Math.atan2(-(h0 * br0 + h2 * br2), cy < -1 ? -1 : cy > 1 ? 1 : cy);
  }
}
