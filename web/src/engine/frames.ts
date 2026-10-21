import type { Fps } from "./types";

const TODO = (): never => {
  throw new Error("not implemented");
};

/** Seconds at the start of a synced frame. */
export function frameToTime(frame: number, fps: Fps): number {
  void frame; void fps;
  return TODO();
}

/** Nearest synced frame for a media time, clamped to [0, frameCount - 1]. */
export function timeToFrame(t: number, fps: Fps, frameCount: number): number {
  void t; void fps; void frameCount;
  return TODO();
}

/** "1:23:45" / "12:05" style label for a frame. */
export function formatFrameTime(frame: number, fps: Fps): string {
  void frame; void fps;
  return TODO();
}
