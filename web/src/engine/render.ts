import type { CalibInfo, Pose } from "./types";

const TODO = (): never => {
  throw new Error("not implemented");
};

/**
 * WebGL2 virtual camera: renders what the export will look like for a pose,
 * sampling the stacked proxy video (left tile on top).
 */
export class CameraViewRenderer {
  constructor(canvas: HTMLCanvasElement, calib: CalibInfo) {
    void canvas; void calib;
    TODO();
  }
  /** Upload the video's current frame (call from requestVideoFrameCallback). */
  updateVideoFrame(video: HTMLVideoElement): void {
    void video;
    TODO();
  }
  render(pose: Pose): void {
    void pose;
    TODO();
  }
  dispose(): void {
    TODO();
  }
}

/** WebGL2 whole-pitch overview (equirectangular map of the coverage). */
export class OverviewRenderer {
  constructor(canvas: HTMLCanvasElement, calib: CalibInfo) {
    void canvas; void calib;
    TODO();
  }
  updateVideoFrame(video: HTMLVideoElement): void {
    void video;
    TODO();
  }
  render(): void {
    TODO();
  }
  /** Canvas pixel (CSS px relative to the canvas) for a yaw/pitch. */
  yawPitchToCanvas(yaw: number, pitch: number): { x: number; y: number } {
    void yaw; void pitch;
    return TODO();
  }
  canvasToYawPitch(x: number, y: number): { yaw: number; pitch: number } {
    void x; void y;
    return TODO();
  }
  dispose(): void {
    TODO();
  }
}
