import type { Fps } from "./types";

/** Seconds at the start of a synced frame. */
export function frameToTime(frame: number, fps: Fps): number {
  return (frame * fps.den) / fps.num;
}

/** Nearest synced frame for a media time, clamped to [0, frameCount - 1]. */
export function timeToFrame(t: number, fps: Fps, frameCount: number): number {
  const f = Math.round((t * fps.num) / fps.den);
  if (!Number.isFinite(f) || frameCount <= 0) return 0;
  return Math.min(Math.max(f, 0), Math.floor(frameCount) - 1);
}

/** "1:23:45" / "12:05" style label for a frame. */
export function formatFrameTime(frame: number, fps: Fps): string {
  const t = frameToTime(frame, fps);
  const total = Number.isFinite(t) && t > 0 ? Math.floor(t + 1e-9) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
