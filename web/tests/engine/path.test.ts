import { describe, expect, it } from "vitest";
import { clampPose } from "../../src/engine/clamp";
import {
  computeFinalPath,
  defaultEdits,
  encodePathBase64,
  keptFrameCount,
  keyframeFromView,
  normalizeEdits,
  poseAt,
} from "../../src/engine/path";
import type { CalibInfo, Coverage, Edits, Keyframe } from "../../src/engine/types";
import { calibInfoOf, coverageFromMatch, RECO_TEST_MATCH } from "./reco-port";

const ASPECT = 16 / 9;

/** Coverage so wide that the clamp never changes anything (algorithm tests). */
const huge: Coverage = { pitchMin: -1.5, pitchMax: 1.5, maxFovDeg: 170, slices: Array.from({ length: 400 }, () => [-100, 100]) };

function calibWith(frameCount: number, coverage: Coverage = huge, fps = { num: 30, den: 1 }): CalibInfo {
  return { ...calibInfoOf(RECO_TEST_MATCH, coverage, frameCount), fps };
}

function constantAi(n: number, yaw = 0.1, pitch = -0.05, fov = 30): Float32Array {
  const ai = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) ai.set([yaw, pitch, fov], i * 3);
  return ai;
}

function edits(n: number, patch: Partial<Edits> = {}): Edits {
  return { ...defaultEdits(n), ...patch };
}

const kf = (frame: number, yaw: number, pitch = 0, fov = 30): Keyframe => ({ frame, yaw, pitch, fov });
const f32 = Math.fround;
const smoothstep = (x: number) => {
  const t = Math.min(Math.max(x, 0), 1);
  return t * t * (3 - 2 * t);
};

describe("defaultEdits", () => {
  it("keeps everything with no fixes", () => {
    expect(defaultEdits(900)).toEqual({
      version: 1,
      segments: [{ start: 0, end: 900 }],
      keyframes: [],
      zoom: 1,
      smoothSeconds: 0,
      holdSeconds: 1,
      fadeSeconds: 1.5,
      joinSeconds: 4,
      export: { width: 1920, height: 1080, quality: "balanced" },
    });
  });
});

describe("normalizeEdits", () => {
  const n = 1000;
  it("returns defaults for junk", () => {
    for (const junk of [null, undefined, 42, "edits", [], [1, 2], true, () => 1, { version: 99 }, Symbol("x")]) {
      expect(normalizeEdits(junk, n)).toEqual(defaultEdits(n));
    }
  });
  it("is the identity on valid edits", () => {
    const good = edits(n, {
      segments: [{ start: 0, end: 300 }, { start: 600, end: 1000 }],
      keyframes: [kf(10, 0.1, 0.02, 25), kf(400, -0.2, 0, 35)],
      zoom: 1.5,
      smoothSeconds: 2,
      holdSeconds: 0.5,
      fadeSeconds: 3,
      joinSeconds: 2,
      export: { width: 3840, height: 2160, quality: "high" },
    });
    expect(normalizeEdits(JSON.parse(JSON.stringify(good)), n)).toEqual(good);
  });
  it("fills missing fields from defaults", () => {
    const out = normalizeEdits({ zoom: 1.2 }, n);
    expect(out).toEqual({ ...defaultEdits(n), zoom: 1.2 });
  });
  it("cleans segments: rounds, clamps, drops empty, sorts and merges overlaps", () => {
    const out = normalizeEdits(
      {
        segments: [
          { start: 700.4, end: 2000 },
          { start: -50, end: 100 },
          { start: 90, end: 200 },
          { start: 300, end: 300 },
          { start: 500, end: 400 },
          { start: "1", end: 5 },
          { start: Number.NaN, end: 5 },
          null,
          7,
          { start: 200, end: 250 },
        ],
      },
      n,
    );
    expect(out.segments).toEqual([
      { start: 0, end: 250 },
      { start: 700, end: 1000 },
    ]);
  });
  it("falls back to the whole match when no segment is usable", () => {
    expect(normalizeEdits({ segments: [] }, n).segments).toEqual([{ start: 0, end: n }]);
    expect(normalizeEdits({ segments: "all" }, n).segments).toEqual([{ start: 0, end: n }]);
    expect(normalizeEdits({ segments: [{ start: 5000, end: 6000 }] }, n).segments).toEqual([{ start: 0, end: n }]);
  });
  it("cleans keyframes: valid numbers only, inside the match, one per frame, sorted", () => {
    const out = normalizeEdits(
      {
        keyframes: [
          kf(500, 0.3),
          kf(100, 0.1),
          { frame: 200, yaw: "0.1", pitch: 0, fov: 30 },
          { frame: 210, yaw: 0, pitch: 0, fov: 0 },
          { frame: 220, yaw: 0, pitch: Number.POSITIVE_INFINITY, fov: 30 },
          { frame: 230, yaw: 0, pitch: 0 },
          kf(5000, 0.9),
          kf(-3, -0.9),
          kf(100.4, 0.2),
          "keyframe",
          null,
        ],
      },
      n,
    );
    expect(out.keyframes).toEqual([kf(0, -0.9), kf(100, 0.2), kf(500, 0.3), kf(999, 0.9)]);
  });
  it("clamps the sliders and checks the export settings", () => {
    const out = normalizeEdits(
      {
        zoom: 9,
        smoothSeconds: -1,
        holdSeconds: Number.NaN,
        fadeSeconds: "2",
        joinSeconds: 1e9,
        export: { width: 1000, height: 1080, quality: "ultra" },
      },
      n,
    );
    expect(out.zoom).toBe(2);
    expect(out.smoothSeconds).toBe(0);
    expect(out.holdSeconds).toBe(1);
    expect(out.fadeSeconds).toBe(1.5);
    expect(out.joinSeconds).toBe(60);
    expect(out.export).toEqual({ width: 1920, height: 1080, quality: "balanced" });
    expect(normalizeEdits({ zoom: 0.1 }, n).zoom).toBe(0.5);
    expect(normalizeEdits({ export: { width: 2560, height: 1440, quality: "fast" } }, n).export).toEqual({
      width: 2560,
      height: 1440,
      quality: "fast",
    });
  });
  it("copes with a broken frame count", () => {
    expect(normalizeEdits({ keyframes: [kf(5, 0)] }, Number.NaN)).toEqual(defaultEdits(0));
    expect(defaultEdits(-5).segments).toEqual([{ start: 0, end: 0 }]);
  });
  it("does not share objects between calls", () => {
    const a = defaultEdits(10);
    a.segments[0].end = 3;
    a.export.quality = "high";
    expect(defaultEdits(10).segments[0].end).toBe(10);
    expect(defaultEdits(10).export.quality).toBe("balanced");
  });
});

describe("computeFinalPath", () => {
  it("is the AI path when nothing is edited", () => {
    const n = 300;
    const ai = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) ai.set([Math.sin(i / 20), Math.cos(i / 30) * 0.2, 20 + (i % 17)], i * 3);
    const out = computeFinalPath(ai, calibWith(n), defaultEdits(n));
    expect(out).toHaveLength(n * 3);
    expect(Array.from(out)).toEqual(Array.from(ai));
  });

  it("smooths with a centred window of 2*round(s*fps/2)+1 that shrinks at the ends", () => {
    const n = 200;
    const ai = constantAi(n, 0, 0, 30);
    ai[100 * 3] = 1.1; // one spike in yaw
    // smoothSeconds 0.5 at 30 fps: half = round(7.5) = 8, window 17
    const out = computeFinalPath(ai, calibWith(n), edits(n, { smoothSeconds: 0.5 }));
    for (let f = 0; f < n; f++) {
      const expected = Math.abs(f - 100) <= 8 ? 1.1 / 17 : 0;
      expect(out[f * 3]).toBeCloseTo(expected, 6);
    }
    // ends: window is cut at the first/last frame
    const ramp = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) ramp.set([i / 100, 0, 30], i * 3);
    const r = computeFinalPath(ramp, calibWith(n), edits(n, { smoothSeconds: 0.5 }));
    expect(r[0]).toBeCloseTo(f32(((0 + 8) / 2) / 100), 6); // mean of frames 0..8
    expect(r[(n - 1) * 3]).toBeCloseTo(((n - 1 + n - 9) / 2) / 100, 5); // mean of frames 191..199
    expect(r[100 * 3]).toBeCloseTo(1, 5); // a straight line is unchanged in the middle
  });

  it("smooths fov and pitch too", () => {
    const n = 100;
    const ai = constantAi(n, 0, 0, 30);
    ai.set([0, 0.3, 50], 50 * 3);
    const out = computeFinalPath(ai, calibWith(n), edits(n, { smoothSeconds: 0.2 })); // half 3, window 7
    expect(out[50 * 3 + 1]).toBeCloseTo(0.3 / 7, 6);
    expect(out[50 * 3 + 2]).toBeCloseTo(30 + 20 / 7, 4);
  });

  it("holds a single fix fully, then fades back to the AI", () => {
    const n = 600;
    const ai = constantAi(n, 0, 0, 30);
    const k = kf(300, 0.5, 0.1, 20);
    const out = computeFinalPath(ai, calibWith(n), edits(n, { keyframes: [k] }));
    // hold 1 s = 30 frames, fade 1.5 s = 45 frames
    for (const f of [270, 285, 300, 315, 330]) {
      expect(out[f * 3]).toBeCloseTo(0.5, 6);
      expect(out[f * 3 + 1]).toBeCloseTo(0.1, 6);
      expect(out[f * 3 + 2]).toBeCloseTo(20, 4);
    }
    for (const d of [1, 10, 22, 30, 44]) {
      const w = 1 - smoothstep(d / 45);
      expect(out[(330 + d) * 3]).toBeCloseTo(f32(0.5 * w), 5);
      expect(out[(270 - d) * 3]).toBeCloseTo(f32(0.5 * w), 5);
      expect(out[(330 + d) * 3 + 2]).toBeCloseTo(30 - 10 * w, 4);
    }
    for (const f of [0, 225, 375, 599]) expect(out[f * 3]).toBe(0);
  });

  it("joins close keyframes into one smooth move", () => {
    const n = 900;
    const ai = constantAi(n, 0, 0, 30);
    // 60 frames (2 s) apart -> one chain with the default 4 s join
    const a = kf(300, 0.2, 0, 30);
    const b = kf(360, -0.4, 0.1, 20);
    const out = computeFinalPath(ai, calibWith(n), edits(n, { keyframes: [b, a] })); // unsorted on purpose
    for (let f = 300; f <= 360; f++) {
      const s = smoothstep((f - 300) / 60);
      expect(out[f * 3]).toBeCloseTo(0.2 + (-0.4 - 0.2) * s, 5);
      expect(out[f * 3 + 1]).toBeCloseTo(0.1 * s, 5);
      expect(out[f * 3 + 2]).toBeCloseTo(30 - 10 * s, 4);
    }
    // holds the first/last keyframe outside the chain
    expect(out[280 * 3]).toBeCloseTo(0.2, 6);
    expect(out[385 * 3]).toBeCloseTo(-0.4, 6);
    // the move eases in and out
    expect(out[301 * 3]).toBeCloseTo(0.2, 2);
  });

  it("treats a gap of exactly the join time as joined, and longer gaps as separate fixes", () => {
    const n = 900;
    const ai = constantAi(n, 0, 0, 30);
    const joined = computeFinalPath(ai, calibWith(n), edits(n, { keyframes: [kf(300, 0.2), kf(420, -0.2)] }));
    expect(joined[360 * 3]).toBeCloseTo(0, 6); // halfway through the smoothstep move
    const apart = computeFinalPath(ai, calibWith(n), edits(n, { keyframes: [kf(300, 0.2), kf(421, -0.2)] }));
    // separate fixes: each holds 30 frames, then fades back toward the AI (0)
    expect(apart[330 * 3]).toBeCloseTo(0.2, 6);
    expect(apart[391 * 3]).toBeCloseTo(-0.2, 6);
    // midway (frame 360/361) both are 30 frames into their fade
    const w = 1 - smoothstep(30 / 45);
    expect(apart[360 * 3]).toBeCloseTo(f32(0.2 * w), 5);
    expect(apart[361 * 3]).toBeCloseTo(f32(-0.2 * w), 5);
  });

  it("uses the nearest fix when fades of separate fixes overlap", () => {
    const n = 900;
    const ai = constantAi(n, 0, 0, 30);
    const e = edits(n, { keyframes: [kf(300, 0.3), kf(450, -0.3)], joinSeconds: 1, holdSeconds: 2, fadeSeconds: 0 });
    const out = computeFinalPath(ai, calibWith(n), e);
    // hold 60 frames: [240, 360] and [390, 510]; between them nothing (fade 0)
    expect(out[360 * 3]).toBeCloseTo(0.3, 6);
    expect(out[361 * 3]).toBe(0);
    expect(out[389 * 3]).toBe(0);
    expect(out[390 * 3]).toBeCloseTo(-0.3, 6);
    // with long holds they meet in the middle
    const e2 = { ...e, holdSeconds: 5 };
    const out2 = computeFinalPath(ai, calibWith(n), e2);
    expect(out2[374 * 3]).toBeCloseTo(0.3, 6);
    expect(out2[376 * 3]).toBeCloseTo(-0.3, 6);
  });

  it("follows the AI between fixes that are far apart", () => {
    const n = 2000;
    const ai = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) ai.set([Math.sin(i / 50) * 0.5, 0, 30], i * 3);
    const out = computeFinalPath(ai, calibWith(n), edits(n, { keyframes: [kf(200, 1), kf(1500, -1)] }));
    for (let f = 400; f < 1300; f++) expect(out[f * 3]).toBe(ai[f * 3]);
    expect(out[200 * 3]).toBeCloseTo(1, 6);
    expect(out[1500 * 3]).toBeCloseTo(-1, 6);
  });

  it("applies the zoom to the AI and to keyframes", () => {
    const n = 600;
    const ai = constantAi(n, 0, 0, 30);
    const k = kf(300, 0.1, 0, 40);
    const out = computeFinalPath(ai, calibWith(n), edits(n, { keyframes: [k], zoom: 2 }));
    expect(out[0 * 3 + 2]).toBeCloseTo(15, 5);
    expect(out[300 * 3 + 2]).toBeCloseTo(20, 5);
    const wide = computeFinalPath(ai, calibWith(n), edits(n, { zoom: 0.5 }));
    expect(wide[2]).toBeCloseTo(60, 5);
  });

  it("keyframeFromView reproduces the view the user saw at any zoom", () => {
    const n = 600;
    const ai = constantAi(n, 0, 0, 30);
    for (const zoom of [0.5, 1, 1.37, 2]) {
      const view = { yaw: -0.3, pitch: 0.05, fov: 18 };
      const k = keyframeFromView(view, 250.2, zoom);
      expect(k.frame).toBe(250);
      expect(k.fov).toBeCloseTo(18 * zoom, 12);
      const out = computeFinalPath(ai, calibWith(n), edits(n, { keyframes: [k], zoom }));
      expect(poseAt(out, 250).yaw).toBeCloseTo(view.yaw, 6);
      expect(poseAt(out, 250).pitch).toBeCloseTo(view.pitch, 6);
      expect(poseAt(out, 250).fov).toBeCloseTo(view.fov, 4);
    }
  });

  it("clamps every frame to what the export can show", () => {
    const cov = coverageFromMatch(RECO_TEST_MATCH);
    const n = 400;
    const ai = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) ai.set([Math.sin(i / 10) * 3, Math.cos(i / 7), 10 + (i % 90)], i * 3);
    const calib = calibWith(n, cov);
    const e = edits(n, { keyframes: [kf(100, 5, -2, 120)], zoom: 0.7 });
    const out = computeFinalPath(ai, calib, e);
    for (let f = 0; f < n; f++) {
      const p = poseAt(out, f);
      const again = clampPose(p, cov, ASPECT);
      expect(p.fov).toBeLessThanOrEqual(f32(cov.maxFovDeg));
      expect(p.yaw).toBeCloseTo(again.yaw, 5);
      expect(p.pitch).toBeCloseTo(again.pitch, 5);
    }
    // frame 0: the AI pose divided by the zoom, then clamped
    const want = clampPose({ yaw: ai[0], pitch: ai[1], fov: ai[2] / 0.7 }, cov, ASPECT);
    expect(out[0]).toBeCloseTo(want.yaw, 6);
    expect(out[1]).toBeCloseTo(want.pitch, 6);
    expect(out[2]).toBeCloseTo(want.fov, 4);
  });

  it("survives a short, empty or broken AI path", () => {
    const n = 50;
    const cov = coverageFromMatch(RECO_TEST_MATCH);
    const ai = constantAi(10, 0.2, 0, 30);
    ai[5 * 3] = Number.NaN;
    const out = computeFinalPath(ai, calibWith(n, cov), defaultEdits(n));
    expect(out).toHaveLength(n * 3);
    expect(out.every(Number.isFinite)).toBe(true);
    expect(out[5 * 3]).toBeCloseTo(0.2, 6); // NaN frame holds the previous pose
    expect(out[49 * 3]).toBeCloseTo(0.2, 6); // past the end holds the last pose
    const empty = computeFinalPath(new Float32Array(0), calibWith(n, cov), defaultEdits(n));
    expect(empty.every(Number.isFinite)).toBe(true);
    expect(computeFinalPath(ai, calibWith(0, cov), defaultEdits(0))).toHaveLength(0);
  });

  it("handles 162,000 frames (90 minutes) well under 100 ms", () => {
    const n = 162_000;
    const cov = coverageFromMatch(RECO_TEST_MATCH);
    const ai = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) ai.set([Math.sin(i / 300) * 0.8, Math.sin(i / 700) * 0.1 - 0.1, 25 + 10 * Math.sin(i / 500)], i * 3);
    const keyframes: Keyframe[] = [];
    for (let f = 100; f < n; f += 97 + (f % 400)) keyframes.push(kf(f, Math.sin(f) * 0.5, 0, 25));
    const e = edits(n, { keyframes, smoothSeconds: 3, zoom: 1.2 });
    const calib = calibWith(n, cov);
    computeFinalPath(ai, calib, e); // warm up
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const out = computeFinalPath(ai, calib, e);
      times.push(performance.now() - t0);
      expect(out).toHaveLength(n * 3);
    }
    times.sort((a, b) => a - b);
    console.log(`computeFinalPath 162k frames, ${keyframes.length} keyframes: median ${times[2].toFixed(1)} ms`);
    expect(times[2]).toBeLessThan(100);
  });
});

describe("poseAt / encodePathBase64 / keptFrameCount", () => {
  it("poseAt rounds and clamps the frame", () => {
    const path = new Float32Array([1, 2, 3, 4, 5, 6]);
    expect(poseAt(path, 0)).toEqual({ yaw: 1, pitch: 2, fov: 3 });
    expect(poseAt(path, 0.6)).toEqual({ yaw: 4, pitch: 5, fov: 6 });
    expect(poseAt(path, 99)).toEqual({ yaw: 4, pitch: 5, fov: 6 });
    expect(poseAt(path, -1)).toEqual({ yaw: 1, pitch: 2, fov: 3 });
    expect(poseAt(path, Number.NaN)).toEqual({ yaw: 1, pitch: 2, fov: 3 });
  });
  it("encodes little-endian float32 as base64", () => {
    const path = new Float32Array([0.5, -1.25, 40, Math.PI, 1e-7, -0]);
    const b64 = encodePathBase64(path);
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    expect(bytes.length).toBe(24);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < path.length; i++) expect(view.getFloat32(i * 4, true)).toBe(path[i]);
    expect(encodePathBase64(new Float32Array([1]))).toBe("AACAPw==");
    expect(encodePathBase64(new Float32Array(0))).toBe("");
  });
  it("encodes a full match quickly", () => {
    const path = new Float32Array(162_000 * 3).map((_, i) => i * 0.001);
    const t0 = performance.now();
    const b64 = encodePathBase64(path);
    const ms = performance.now() - t0;
    expect(b64.length).toBe(Math.ceil((path.length * 4) / 3) * 4);
    const tail = atob(b64.slice(-8));
    expect(tail.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(1000);
  });
  it("keptFrameCount sums the keep-ranges", () => {
    expect(keptFrameCount(defaultEdits(1234))).toBe(1234);
    expect(keptFrameCount(edits(1000, { segments: [{ start: 0, end: 100 }, { start: 400, end: 1000 }] }))).toBe(700);
  });
});
