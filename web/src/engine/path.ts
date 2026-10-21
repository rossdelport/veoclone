// The final camera path (DESIGN.md section 5.3).
import { clampInto, maxFovOf } from "./clamp";
import type { CalibInfo, Edits, ExportQuality, Keyframe, Pose, Segment } from "./types";

const EXPORT_SIZES: [number, number][] = [
  [1920, 1080],
  [2560, 1440],
  [3840, 2160],
];
const QUALITIES: ExportQuality[] = ["fast", "balanced", "high"];

/** Edits for a fresh project: keep everything, no fixes, zoom 1. */
export function defaultEdits(frameCount: number): Edits {
  return {
    version: 1,
    segments: [{ start: 0, end: wholeFrames(frameCount) }],
    keyframes: [],
    zoom: 1,
    smoothSeconds: 0,
    holdSeconds: 1.0,
    fadeSeconds: 1.5,
    joinSeconds: 4.0,
    export: { width: 1920, height: 1080, quality: "balanced" },
  };
}

function wholeFrames(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** A finite number clamped to [min, max], or `fallback`. */
function num(v: unknown, fallback: number, min: number, max: number): number {
  return finite(v) ? Math.min(Math.max(v, min), max) : fallback;
}

/** Fill missing/invalid fields of loaded edits with defaults (forward compatible). */
export function normalizeEdits(raw: unknown, frameCount: number): Edits {
  const n = wholeFrames(frameCount);
  const out = defaultEdits(n);
  if (!isRecord(raw)) return out;

  // Keep-ranges: whole frames inside [0, n], sorted, overlaps merged.
  if (Array.isArray(raw.segments)) {
    const segs: Segment[] = [];
    for (const s of raw.segments) {
      if (!isRecord(s) || !finite(s.start) || !finite(s.end)) continue;
      const start = Math.min(Math.max(Math.round(s.start), 0), n);
      const end = Math.min(Math.max(Math.round(s.end), 0), n);
      if (end > start) segs.push({ start, end });
    }
    segs.sort((a, b) => a.start - b.start);
    const merged: Segment[] = [];
    for (const s of segs) {
      const last = merged[merged.length - 1];
      if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
      else merged.push(s);
    }
    if (merged.length > 0) out.segments = merged;
  }

  // Keyframes: valid numbers only, one per frame (the last one wins), sorted.
  if (Array.isArray(raw.keyframes) && n > 0) {
    const byFrame = new Map<number, Keyframe>();
    for (const k of raw.keyframes) {
      if (!isRecord(k) || !finite(k.frame) || !finite(k.yaw) || !finite(k.pitch)) continue;
      if (!finite(k.fov) || k.fov <= 0) continue;
      const frame = Math.min(Math.max(Math.round(k.frame), 0), n - 1);
      byFrame.set(frame, { frame, yaw: k.yaw, pitch: k.pitch, fov: Math.min(k.fov, 179) });
    }
    out.keyframes = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
  }

  out.zoom = num(raw.zoom, out.zoom, 0.5, 2);
  out.smoothSeconds = num(raw.smoothSeconds, out.smoothSeconds, 0, 5);
  out.holdSeconds = num(raw.holdSeconds, out.holdSeconds, 0, 60);
  out.fadeSeconds = num(raw.fadeSeconds, out.fadeSeconds, 0, 60);
  out.joinSeconds = num(raw.joinSeconds, out.joinSeconds, 0, 60);

  if (isRecord(raw.export)) {
    const { width, height, quality } = raw.export;
    if (EXPORT_SIZES.some(([w, h]) => w === width && h === height)) {
      out.export.width = width as number;
      out.export.height = height as number;
    }
    if (QUALITIES.includes(quality as ExportQuality)) out.export.quality = quality as ExportQuality;
  }
  return out;
}

const smoothstep01 = (x: number): number => {
  const t = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return t * t * (3 - 2 * t);
};

/**
 * The AI path as yaw/pitch/fov arrays of exactly `n` frames. Frames that are
 * missing or broken hold the previous good pose (leading ones the first).
 */
function readAiPath(ai: Float32Array, n: number, fallbackFov: number): [Float64Array, Float64Array, Float64Array] {
  const yaw = new Float64Array(n);
  const pitch = new Float64Array(n);
  const fov = new Float64Array(n).fill(fallbackFov);
  const available = Math.floor((ai?.length ?? 0) / 3);
  const good = (i: number) =>
    Number.isFinite(ai[i * 3]) && Number.isFinite(ai[i * 3 + 1]) && Number.isFinite(ai[i * 3 + 2]) && ai[i * 3 + 2] > 0;
  let last = -1;
  for (let i = 0; i < available && last < 0; i++) if (good(i)) last = i;
  if (last < 0) return [yaw, pitch, fov];
  for (let i = 0; i < n; i++) {
    if (i < available && good(i)) last = i;
    yaw[i] = ai[last * 3];
    pitch[i] = ai[last * 3 + 1];
    fov[i] = ai[last * 3 + 2];
  }
  return [yaw, pitch, fov];
}

/** Centred moving average with a window of 2*half+1 that shrinks at the ends. */
function movingAverage(values: Float64Array, half: number): Float64Array {
  const n = values.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + values[i];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n - 1, i + half);
    out[i] = (prefix[b + 1] - prefix[a]) / (b - a + 1);
  }
  return out;
}

/** Keyframes grouped into chains: neighbours closer than `join` frames move together. */
function chainKeyframes(keyframes: Keyframe[], join: number): Keyframe[][] {
  const valid = keyframes
    .filter(
      (k) =>
        Number.isFinite(k.frame) && Number.isFinite(k.yaw) && Number.isFinite(k.pitch) && Number.isFinite(k.fov) && k.fov > 0,
    )
    .sort((a, b) => a.frame - b.frame);
  const chains: Keyframe[][] = [];
  for (const k of valid) {
    const chain = chains[chains.length - 1];
    if (chain && k.frame - chain[chain.length - 1].frame <= join) chain.push(k);
    else chains.push([k]);
  }
  return chains;
}

/**
 * The final camera path (DESIGN.md section 5.3): AI path + smoothing +
 * keyframe fixes + zoom + clamp. Returns frameCount*3 floats [yaw,pitch,fov].
 */
export function computeFinalPath(ai: Float32Array, calib: CalibInfo, edits: Edits): Float32Array {
  const n = wholeFrames(calib.frameCount);
  const fpsValue = calib.fps.num / calib.fps.den;
  const fps = Number.isFinite(fpsValue) && fpsValue > 0 ? fpsValue : 30;
  const cov = calib.coverage;
  const aspect = calib.render?.outputAspect > 0 ? calib.render.outputAspect : 16 / 9;
  const zoom = finite(edits.zoom) && edits.zoom > 0 ? edits.zoom : 1;
  const hold = Math.max(0, finite(edits.holdSeconds) ? edits.holdSeconds : 1) * fps;
  const fade = Math.max(0, finite(edits.fadeSeconds) ? edits.fadeSeconds : 1.5) * fps;
  const join = Math.max(0, finite(edits.joinSeconds) ? edits.joinSeconds : 4) * fps;

  // 1. Base = AI path, optionally smoothed.
  let [yaw, pitch, fov] = readAiPath(ai, n, maxFovOf(cov));
  const half = Math.round(((finite(edits.smoothSeconds) ? edits.smoothSeconds : 0) * fps) / 2);
  if (half > 0) {
    yaw = movingAverage(yaw, half);
    pitch = movingAverage(pitch, half);
    fov = movingAverage(fov, half);
  }

  // 2-3. Keyframe fixes, blended over the base by the nearest chain's weight.
  const chains = chainKeyframes(edits.keyframes ?? [], join);
  let next = 0; // first chain that starts after frame f
  let seg = 0; // segment of the current chain that frame f falls in
  for (let f = 0; f < n; f++) {
    while (next < chains.length && chains[next][0].frame <= f) {
      next++;
      seg = 0;
    }
    const prev = next - 1;
    // Distance from f to each neighbouring chain's [first, last] keyframe span.
    const dPrev = prev >= 0 ? Math.max(0, f - chains[prev][chains[prev].length - 1].frame) : Infinity;
    const dNext = next < chains.length ? chains[next][0].frame - f : Infinity;
    if (dPrev === Infinity && dNext === Infinity) continue;
    const usePrev = dPrev <= dNext;
    const chain = usePrev ? chains[prev] : chains[next];
    const past = (usePrev ? dPrev : dNext) - hold;
    const w = past <= 0 ? 1 : fade > 0 ? 1 - smoothstep01(past / fade) : 0;
    if (w <= 0) continue;

    // M(f): smoothstep between consecutive keyframes, held outside the chain.
    let my: number, mp: number, mf: number;
    const first = chain[0];
    const last = chain[chain.length - 1];
    if (f <= first.frame) {
      my = first.yaw; mp = first.pitch; mf = first.fov;
    } else if (f >= last.frame) {
      my = last.yaw; mp = last.pitch; mf = last.fov;
    } else {
      while (chain[seg + 1].frame < f) seg++;
      const a = chain[seg];
      const b = chain[seg + 1];
      const s = smoothstep01((f - a.frame) / (b.frame - a.frame));
      my = a.yaw + (b.yaw - a.yaw) * s;
      mp = a.pitch + (b.pitch - a.pitch) * s;
      mf = a.fov + (b.fov - a.fov) * s;
    }
    yaw[f] += (my - yaw[f]) * w;
    pitch[f] += (mp - pitch[f]) * w;
    fov[f] += (mf - fov[f]) * w;
  }

  // 4-5. Zoom, then the export's FOV cap and coverage clamp.
  const out = new Float32Array(n * 3);
  for (let f = 0; f < n; f++) {
    clampInto(yaw[f], pitch[f], fov[f] / zoom, cov, aspect, out, f * 3);
  }
  return out;
}

/** Pose at a frame of a path (clamped to the valid frame range). */
export function poseAt(path: Float32Array, frame: number): Pose {
  const n = Math.floor(path.length / 3);
  if (n === 0) return { yaw: 0, pitch: 0, fov: 0 };
  const f = Number.isFinite(frame) ? Math.min(Math.max(Math.round(frame), 0), n - 1) : 0;
  return { yaw: path[f * 3], pitch: path[f * 3 + 1], fov: path[f * 3 + 2] };
}

/** A keyframe that reproduces `view` (what the user sees now) at `frame`. */
export function keyframeFromView(view: Pose, frame: number, zoom: number): Keyframe {
  const z = finite(zoom) && zoom > 0 ? zoom : 1;
  return { frame: Math.round(frame), yaw: view.yaw, pitch: view.pitch, fov: view.fov * z };
}

/** Float32 little-endian bytes of a path, base64 encoded (export request). */
export function encodePathBase64(path: Float32Array): string {
  const bytes = new Uint8Array(path.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < path.length; i++) view.setFloat32(i * 4, path[i], true);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Total kept frames of the segments (the export's length). */
export function keptFrameCount(edits: Edits): number {
  let total = 0;
  for (const s of edits.segments) total += Math.max(0, s.end - s.start);
  return total;
}
