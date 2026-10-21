// Test page for the Playwright engine tests: draws a synthetic stacked
// texture (or a real proxy video) through the WebGL renderers and compares
// the pixels with the CPU mirror in projection.ts.
import {
  buildRig,
  CameraViewRenderer,
  OverviewRenderer,
  sampleRay,
  viewRay,
  yawPitchToDirection,
  type CalibInfo,
  type MatchCalibration,
  type Pose,
  type Rig,
  type Vec3,
} from "../src/engine";
import synthMatch from "../tests/engine/fixtures/synth-match.json";
import { calibInfoOf, coverageFromMatch } from "../tests/engine/reco-port";

type RGB = [number, number, number];

function makeCanvas(cssW: number, cssH: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.style.width = `${cssW}px`;
  c.style.height = `${cssH}px`;
  document.body.appendChild(c);
  return c;
}

/** Stacked test texture: tile 0 (left camera) on top, tile 1 below. */
function stackedPattern(tileW: number, tileH: number): ImageData {
  const img = new ImageData(tileW, tileH * 2);
  for (let y = 0; y < tileH * 2; y++) {
    const tile = y < tileH ? 0 : 1;
    const ty = y - tile * tileH;
    for (let x = 0; x < tileW; x++) {
      const i = (y * tileW + x) * 4;
      img.data[i] = Math.round((x / (tileW - 1)) * 255);
      img.data[i + 1] = Math.round((ty / (tileH - 1)) * 255);
      img.data[i + 2] = Math.round(64 + 128 * tile + 60 * Math.sin(x / 7) * Math.sin(ty / 5));
      img.data[i + 3] = 255;
    }
  }
  return img;
}

/** GL_LINEAR + CLAMP_TO_EDGE sample of the stacked image at texture coords (s, t). */
function bilinear(img: ImageData, s: number, t: number): RGB {
  const x = s * img.width - 0.5;
  const y = t * img.height - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const px = (xx: number, yy: number, c: number) => {
    const cx = Math.min(Math.max(xx, 0), img.width - 1);
    const cy = Math.min(Math.max(yy, 0), img.height - 1);
    return img.data[(cy * img.width + cx) * 4 + c];
  };
  const out: RGB = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = px(x0, y0, c) * (1 - fx) + px(x0 + 1, y0, c) * fx;
    const b = px(x0, y0 + 1, c) * (1 - fx) + px(x0 + 1, y0 + 1, c) * fx;
    out[c] = a * (1 - fy) + b * fy;
  }
  return out;
}

/** CPU mirror of the fragment shader for one ray. */
function cpuColor(rig: Rig, img: ImageData, ray: Vec3): RGB {
  const hx = 0.5 / img.width, hy = 0.5 / img.height;
  const tile = (i: number, u: number, v: number) =>
    bilinear(img, Math.min(Math.max(u, hx), 1 - hx), Math.min(Math.max(v * 0.5, hy), 0.5 - hy) + 0.5 * i);
  let col: RGB = [0, 0, 0];
  const s = sampleRay(ray, rig);
  if (s.left) col = tile(0, s.left.u, s.left.v);
  if (s.right) {
    const c = tile(1, s.right.u, s.right.v);
    const a = s.right.alpha;
    col = [col[0] + (c[0] - col[0]) * a, col[1] + (c[1] - col[1]) * a, col[2] + (c[2] - col[2]) * a];
  }
  return col;
}

/** Drawing buffer pixels, top row first. */
function readCanvas(canvas: HTMLCanvasElement): Uint8Array<ArrayBuffer> {
  const gl = canvas.getContext("webgl2")!;
  const w = canvas.width, h = canvas.height;
  const raw = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  return out;
}

function compare(canvas: HTMLCanvasElement, img: ImageData, rayAt: (ndcX: number, ndcY: number) => Vec3) {
  const rig = state!.rig;
  const px = readCanvas(canvas);
  const w = canvas.width, h = canvas.height;
  let sum = 0, max = 0, over = 0, n = 0, lit = 0;
  const worst: { x: number; y: number; gpu: number[]; cpu: number[] }[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cpu = cpuColor(rig, img, rayAt(((x + 0.5) / w) * 2 - 1, 1 - ((y + 0.5) / h) * 2));
      const i = (y * w + x) * 4;
      const gpu = [px[i], px[i + 1], px[i + 2]];
      let d = 0;
      for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(gpu[c] - cpu[c]));
      sum += d;
      n++;
      if (cpu[0] + cpu[1] + cpu[2] > 0) lit++;
      if (d > 3) {
        over++;
        if (worst.length < 10) worst.push({ x, y, gpu, cpu: cpu.map((v) => Math.round(v)) });
      }
      max = Math.max(max, d);
    }
  }
  return { width: w, height: h, pixels: n, litPixels: lit, meanAbs: sum / n, maxAbs: max, over3: over, worst };
}

interface State {
  calib: CalibInfo;
  rig: Rig;
  img: ImageData;
  view: CameraViewRenderer;
  overview: OverviewRenderer;
  viewCanvas: HTMLCanvasElement;
  overviewCanvas: HTMLCanvasElement;
}
let state: State | null = null;

function synthCalib(): CalibInfo {
  const match = synthMatch as unknown as MatchCalibration;
  return calibInfoOf(match, coverageFromMatch(match));
}

const api = {
  /** Synthetic stacked texture through both renderers. */
  setup(viewCss: [number, number] = [320, 180], overviewCss: [number, number] = [400, 120], tile: [number, number] = [256, 144]) {
    document.body.innerHTML = "";
    state?.view.dispose();
    state?.overview.dispose();
    const calib = synthCalib();
    const viewCanvas = makeCanvas(...viewCss);
    const overviewCanvas = makeCanvas(...overviewCss);
    const view = new CameraViewRenderer(viewCanvas, calib);
    const overview = new OverviewRenderer(overviewCanvas, calib);
    const img = stackedPattern(...tile);
    view.updateVideoFrame(img);
    overview.updateVideoFrame(img);
    state = { calib, rig: buildRig(calib), img, view, overview, viewCanvas, overviewCanvas };
    return { dpr: window.devicePixelRatio };
  },

  compareView(pose: Pose) {
    const s = state!;
    s.view.render(pose);
    const aspect = s.viewCanvas.width / s.viewCanvas.height;
    return compare(s.viewCanvas, s.img, (x, y) => viewRay(pose, s.rig, x, y, aspect));
  },

  compareOverview() {
    const s = state!;
    s.overview.render();
    const e = s.overview.extent;
    return compare(s.overviewCanvas, s.img, (x, y) =>
      yawPitchToDirection(e.yawMax - (x * 0.5 + 0.5) * (e.yawMax - e.yawMin), e.pitchMax - (0.5 - y * 0.5) * (e.pitchMax - e.pitchMin), s.rig),
    );
  },

  overviewMapping() {
    const s = state!;
    const out = [];
    for (const [x, y] of [[0, 0], [123.4, 56.7], [400, 120], [200, 60]]) {
      const yp = s.overview.canvasToYawPitch(x, y);
      out.push({ x, y, yp, back: s.overview.yawPitchToCanvas(yp.yaw, yp.pitch) });
    }
    return { extent: s.overview.extent, cssWidth: s.overviewCanvas.clientWidth, points: out };
  },

  canvasSize() {
    const s = state!;
    return { view: [s.viewCanvas.width, s.viewCanvas.height], overview: [s.overviewCanvas.width, s.overviewCanvas.height] };
  },

  /** Lose the GPU context, render while lost, then restore it. */
  async loseAndRestore(pose: Pose) {
    const s = state!;
    const ext = s.viewCanvas.getContext("webgl2")!.getExtension("WEBGL_lose_context")!;
    const lost = new Promise((r) => s.viewCanvas.addEventListener("webglcontextlost", r, { once: true }));
    ext.loseContext();
    await lost;
    // restoreContext only works once the lost event has finished dispatching
    await new Promise((r) => setTimeout(r, 0));
    let threw = false;
    try {
      s.view.render(pose);
      s.view.updateVideoFrame(s.img);
    } catch {
      threw = true;
    }
    const restored = new Promise((r) => s.viewCanvas.addEventListener("webglcontextrestored", r, { once: true }));
    ext.restoreContext();
    await restored;
    return { threw, after: api.compareView(pose) };
  },

  // ---- Parity with Reco: render real proxy frames ----

  async loadVideo(url: string) {
    const blob = await (await fetch(url)).blob();
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.src = URL.createObjectURL(blob);
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error(`video error ${video.error?.code} ${video.error?.message}`));
    });
    (window as unknown as { parityVideo: HTMLVideoElement }).parityVideo = video;
    return { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
  },

  /** Render each pose at its synced frame; returns PNG data URLs. */
  async renderProxyFrames(calib: CalibInfo, items: { frame: number; pose: Pose }[], size: [number, number]) {
    document.body.innerHTML = "";
    const video = (window as unknown as { parityVideo: HTMLVideoElement }).parityVideo;
    const canvas = makeCanvas(...size);
    const view = new CameraViewRenderer(canvas, calib);
    const fps = calib.fps.num / calib.fps.den;
    const out: { frame: number; mediaTime: number; png: string }[] = [];
    for (const { frame, pose } of items) {
      const seeked = new Promise((r) => video.addEventListener("seeked", r, { once: true }));
      video.currentTime = (frame + 0.25) / fps;
      await seeked;
      const mediaTime = await new Promise<number>((resolve) => {
        const timer = setTimeout(() => resolve(-1), 1000);
        video.requestVideoFrameCallback((_, meta) => {
          clearTimeout(timer);
          resolve(meta.mediaTime);
        });
      });
      view.updateVideoFrame(video);
      view.render(pose);
      const px = readCanvas(canvas);
      const c2 = document.createElement("canvas");
      c2.width = canvas.width;
      c2.height = canvas.height;
      c2.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), canvas.width, canvas.height), 0, 0);
      out.push({ frame, mediaTime, png: c2.toDataURL("image/png") });
    }
    view.dispose();
    return out;
  },
};

(window as unknown as { engineTest: typeof api }).engineTest = api;
