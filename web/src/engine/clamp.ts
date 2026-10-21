// Port of Reco's CoverageBoundary::yaw_range_at / safe_clamp_world
// (crates/reco-core/src/projection/coverage.rs) and the FOV cap in
// StitchSession::director_position (session/frame_processing.rs).
import type { Coverage, Pose } from "./types";

const DEG = Math.PI / 180;

/** Yaw range [min, max] covered at a pitch (port of Reco's yaw_range_at). */
export function yawRangeAt(cov: Coverage, pitch: number): [number, number] {
  const table = cov.slices;
  const n = table?.length ?? 0;
  if (n === 0 || !(cov.pitchMax > cov.pitchMin)) return [0, 0];
  const t = (pitch - cov.pitchMin) / (cov.pitchMax - cov.pitchMin);
  const idxF = t * (n - 1);
  // Rust's `f32 as usize` saturates: negative and NaN become 0.
  const idxLo = Math.min(idxF > 0 ? Math.floor(idxF) : 0, n - 1);
  const idxHi = Math.min(idxLo + 1, n - 1);
  const frac = idxF - idxLo;
  const lo = table[idxLo];
  const hi = table[idxHi];
  if (lo[0] > lo[1]) return [hi[0], hi[1]];
  if (hi[0] > hi[1]) return [lo[0], lo[1]];
  return [lo[0] + frac * (hi[0] - lo[0]), lo[1] + frac * (hi[1] - lo[1])];
}

/** Widest yaw range over all pitches (Reco's yaw_range). */
export function globalYawRange(cov: Coverage): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [a, b] of cov.slices ?? []) {
    if (a <= b) {
      lo = Math.min(lo, a);
      hi = Math.max(hi, b);
    }
  }
  return lo > hi ? [0, 0] : [lo, hi];
}

/** Largest vertical fov (degrees) the export allows, as Reco caps it. */
export function maxFovOf(cov: Coverage): number {
  return Number.isFinite(cov.maxFovDeg) && cov.maxFovDeg > 0 ? cov.maxFovDeg : 20;
}

/**
 * Clamp one pose and write [yaw, pitch, fov] into `out` at `offset`.
 * Allocation free so computeFinalPath can run it on every frame.
 */
export function clampInto(
  yaw: number,
  pitch: number,
  fov: number,
  cov: Coverage,
  aspect: number,
  out: Float32Array | number[],
  offset: number,
): void {
  // FOV cap: `fov.min(max_fov)` (NaN gives max_fov in Rust), then
  // set_fov's lower bound of 1 degree.
  const maxFov = maxFovOf(cov);
  fov = Math.max(1, Number.isNaN(fov) ? maxFov : Math.min(fov, maxFov));

  const { pitchMin, pitchMax } = cov;
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch) || !Number.isFinite(aspect)) {
    // Fall back to the coverage centre (Reco's B-30 guard).
    const safePitch = (pitchMin + pitchMax) * 0.5;
    const [lo, hi] = yawRangeAt(cov, safePitch);
    out[offset] = (lo + hi) * 0.5;
    out[offset + 1] = safePitch;
    out[offset + 2] = fov;
    return;
  }

  const halfV = fov * 0.5 * DEG;
  const halfH = Math.atan(aspect * Math.tan(halfV));

  let p: number;
  if (pitchMin + halfV <= pitchMax - halfV) {
    p = Math.min(Math.max(pitch, pitchMin + halfV), pitchMax - halfV);
  } else {
    p = (pitchMin + pitchMax) * 0.5;
  }

  const [lo, hi] = yawRangeAt(cov, p);
  let y: number;
  if (lo + halfH <= hi - halfH) {
    y = Math.min(Math.max(yaw, lo + halfH), hi - halfH);
  } else {
    y = (lo + hi) * 0.5;
  }

  out[offset] = y;
  out[offset + 1] = p;
  out[offset + 2] = fov;
}

/**
 * FOV cap + Reco's safe_clamp: keeps the whole view inside the area both
 * cameras can see. `aspect` = output width / height (16/9).
 */
export function clampPose(p: Pose, cov: Coverage, aspect: number): Pose {
  const out = [0, 0, 0];
  clampInto(p.yaw, p.pitch, p.fov, cov, aspect, out, 0);
  return { yaw: out[0], pitch: out[1], fov: out[2] };
}
