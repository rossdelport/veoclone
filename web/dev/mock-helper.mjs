#!/usr/bin/env node
// A pretend VeoClone helper for working on the editor without the real one
// (no GPU, no Rust build). Zero dependencies. Projects live in memory;
// processing and exports are faked with timers; the editor data (preview
// video, calibration, AI path, lens list) are real files made by the helper
// from the synthetic test footage (see dev/README.md).
//
//   npm run mock                        # http://127.0.0.1:47863 (the default the editor looks for)
//   node dev/mock-helper.mjs --port 47990 --empty --speed 4
//
// Options:
//   --port N     port (default 47863, or env MOCK_PORT)
//   --empty      start with no matches (default: one ready "Example match")
//   --speed X    make fake jobs X times faster (default 1: processing ~8 s)
//   --web DIR    also serve the built editor from DIR (like the real helper)
//
// Test hooks: a match whose name contains "fail" fails once while lining up
// the videos (press Try again to succeed; a re-run of a ready match then goes
// back to ready with a warning, DESIGN.md 4.7); "slow" makes its jobs 10x
// slower. GET /__mock/state shows what the editor sent; POST /__mock/reset
// forgets everything.
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, "fixtures");

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const PORT = Number(arg("--port") ?? process.env.MOCK_PORT ?? 47863);
const SPEED = Math.max(0.05, Number(arg("--speed") ?? 1));
const WEB = arg("--web") ? resolve(arg("--web")) : null;

const calibTemplate = JSON.parse(readFileSync(join(FIX, "calib.json"), "utf8"));
const lenses = JSON.parse(readFileSync(join(FIX, "lenses.json"), "utf8"));
const FRAME_COUNT = calibTemplate.frameCount;
const FPS = calibTemplate.fps;
const PROXY = join(FIX, "proxy.mp4");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {Map<string, any>} */
let projects = new Map();
/** @type {Map<string, any>} */
let edits = new Map();
let mock = { lastExport: null, editsPuts: 0, openFolder: [], failedOnce: new Set(), swaps: 0 };
const timers = new Map(); // project id -> interval
const uploads = new Map(); // project id -> uploads in progress
const previous = new Map(); // project id -> the ready result a re-run started from
const madeWith = new Map(); // project id -> camera style of the AI result on "disk"

const BUSY = "VeoClone is still working on this match. Press Stop first, or wait until it has finished.";
const GENERIC_LENS =
  "We didn't know which iPhone filmed this, so a typical iPhone lens was used. If the picture looks bent or the two halves don't join, use “Change phone or lens”.";

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const newId = () => Math.random().toString(16).slice(2, 14).padEnd(12, "0");

function probe(name) {
  return {
    width: 1280, height: 720, fps: FPS, frameCount: FRAME_COUNT + 12, duration: (FRAME_COUNT + 12) / 30,
    codec: name.toLowerCase().endsWith(".mov") ? "hevc" : "h264", pixelFormat: "yuv420p",
    colorTransfer: "bt709", rotation: 0, hasAudio: true,
  };
}

function newProject({ name, lensId = null, style = "broadcast" }) {
  const t = now();
  return {
    id: newId(), name, createdAt: t, updatedAt: t, lensId, style, status: "new",
    files: {}, job: null, error: null, warnings: [], diskBytes: 0, exports: [],
  };
}

function seed() {
  const p = newProject({ name: "Example match", style: "broadcast" });
  const yesterday = new Date(Date.now() - 86400e3).toISOString().replace(/\.\d+Z$/, "Z");
  Object.assign(p, {
    createdAt: yesterday, updatedAt: yesterday, status: "ready",
    files: {
      left: { name: "IMG_4012.MOV", sizeBytes: 742163, probe: probe("IMG_4012.MOV") },
      right: { name: "IMG_0877.MOV", sizeBytes: 769186, probe: probe("IMG_0877.MOV") },
    },
    lensId: "generic:ultra",
    warnings: [GENERIC_LENS],
    calibration: { confidence: 1, syncOffsetFrames: 12, syncOffsetSeconds: 0.4, lens: "Not sure · Ultra wide (0.5×)" },
    fps: FPS, frameCount: FRAME_COUNT, diskBytes: 4_538_000,
  });
  projects.set(p.id, p);
  madeWith.set(p.id, p.style);
}

// ---------------------------------------------------------------------------
// Fake jobs
// ---------------------------------------------------------------------------

const PROCESS_STEPS = [
  { step: "probe", seconds: 1, message: "Checking the video files" },
  { step: "calibrate", seconds: 2, message: "Lining up and calibrating the cameras" },
  { step: "proxy", seconds: 2, message: "Making the preview video", frames: true },
  { step: "track", seconds: 3, message: "AI ball tracking", frames: true },
];
const EXPORT_STEPS = [
  { step: "export", seconds: 3, message: "Making your video", frames: true },
  { step: "finalize", seconds: 0.5, message: "Putting the parts together" },
];
const TEXT_STEP = { step: "overlay", seconds: 1, message: "Adding text", frames: true };

function runJob(p, kind, steps, { exportId, onDone, onFail }) {
  const speed = /slow/i.test(p.name) ? SPEED / 10 : SPEED;
  let index = 0;
  let stepStart = Date.now();
  const startedAt = now();
  const total = FRAME_COUNT;
  const tick = () => {
    const s = steps[index];
    const progress = Math.min(1, (((Date.now() - stepStart) / 1000) * speed) / s.seconds);
    const remaining = steps.slice(index).reduce((a, x) => a + x.seconds, 0) - progress * s.seconds;
    p.job = {
      kind, ...(exportId ? { exportId } : {}), step: s.step, stepIndex: index, stepCount: steps.length,
      progress, message: s.message, startedAt,
      ...(s.frames ? { framesDone: Math.round(progress * total), framesTotal: total } : {}),
      ...(progress > 0.05 ? { etaSeconds: Math.round(remaining / speed) } : {}),
    };
    if (exportId) {
      const e = p.exports.find((x) => x.id === exportId);
      if (e) Object.assign(e, { status: "running", progress: (index + progress) / steps.length });
    }
    if (onFail && onFail(s.step, progress)) return stop();
    if (progress >= 1) {
      index++;
      stepStart = Date.now();
      if (index >= steps.length) {
        stop();
        p.job = null;
        onDone();
      }
    }
  };
  const stop = () => {
    clearInterval(timers.get(p.id));
    timers.delete(p.id);
  };
  timers.set(p.id, setInterval(tick, 100));
  tick();
}

/** A re-run of a ready match that fails or is stopped keeps the earlier result (DESIGN.md 4.7). */
function backToReady(p, problem) {
  const prev = previous.get(p.id);
  previous.delete(p.id);
  if (!prev) return false;
  Object.assign(p, prev, { status: "ready", job: null, error: null, warnings: [...prev.warnings, problem] });
  return true;
}

function startProcess(p) {
  p.status = "processing";
  p.error = null;
  p.warnings = [];
  const failThisTime = /fail/i.test(p.name) && !mock.failedOnce.has(p.id);
  runJob(p, "process", PROCESS_STEPS, {
    onFail: (step, progress) => {
      if (!failThisTime || step !== "calibrate" || progress < 0.5) return false;
      mock.failedOnce.add(p.id);
      const message = "We couldn't line up the two videos. Make sure both phones filmed the same match from about the same spot. Were the left and right videos the wrong way round? Then press Swap left and right.";
      if (backToReady(p, `Processing it again did not work, so the earlier result is kept. ${message}`)) return true;
      p.job = null;
      p.status = "failed";
      p.error = {
        message,
        detail: "calibrate_videos: not enough feature matches between the cameras (12 < 50)\n  at reco_calibrate::video::calibrate_videos",
      };
      return true;
    },
    onDone: () => {
      previous.delete(p.id);
      madeWith.set(p.id, p.style);
      p.status = "ready";
      p.fps = FPS;
      p.frameCount = FRAME_COUNT;
      p.calibration = {
        confidence: 0.92, syncOffsetFrames: 12, syncOffsetSeconds: 0.4,
        lens: lenses.find((l) => l.id === (p.lensId ?? "generic:ultra"))?.label ?? p.lensId,
      };
      if (!p.lensId || p.lensId.startsWith("generic:")) p.warnings.push(GENERIC_LENS);
      p.diskBytes += 4_000_000;
      p.updatedAt = now();
    },
  });
}

function startExport(p, e, withText) {
  runJob(p, "export", withText ? [...EXPORT_STEPS, TEXT_STEP] : EXPORT_STEPS, {
    exportId: e.id,
    onDone: () => {
      const date = new Date().toISOString().slice(0, 10);
      Object.assign(e, { status: "done", progress: 1, fileName: `${p.name} ${date}.mp4`, sizeBytes: statSync(PROXY).size });
      p.diskBytes += e.sizeBytes;
    },
  });
}

function cancelJobs(p) {
  const t = timers.get(p.id);
  if (t) clearInterval(t), timers.delete(p.id);
  if (p.job?.kind === "process" || p.status === "queued" || p.status === "processing") {
    if (!backToReady(p, "Processing it again was stopped, so the earlier result is kept.")) p.status = "cancelled";
  }
  for (const e of p.exports) if (e.status === "queued" || e.status === "running") e.status = "cancelled";
  p.job = null;
}

const busy = (p) => timers.has(p.id);

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
}

function send(res, status, body, headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-cache", ...headers });
  res.end(data);
}

const fail = (res, status, error, detail) => send(res, status, detail ? { error, detail } : { error });

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("too big"), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, limit = 1 << 20) {
  try {
    return JSON.parse((await readBody(req, limit)).toString("utf8") || "null");
  } catch (e) {
    throw Object.assign(new Error("bad json"), { status: e.status ?? 400 });
  }
}

/** Serve a file with Range support. */
function sendFile(req, res, path, type, extra = {}) {
  const size = statSync(path).size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  const headers = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-cache", ...extra };
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    start = Math.max(0, start);
    if (start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    if (req.method === "HEAD") return res.end();
    return createReadStream(path, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "Content-Length": size });
  if (req.method === "HEAD") return res.end();
  createReadStream(path).pipe(res);
}

function validateExport(body) {
  if (!body || !Array.isArray(body.segments) || body.segments.length === 0) return "Choose which part of the match to keep.";
  let last = 0;
  for (const s of body.segments) {
    if (!Number.isInteger(s.startFrame) || !Number.isInteger(s.endFrame) || s.startFrame < last || s.endFrame <= s.startFrame || s.endFrame > FRAME_COUNT) {
      return `Bad segment ${JSON.stringify(s)}`;
    }
    last = s.endFrame;
  }
  if (![[1920, 1080], [2560, 1440], [3840, 2160]].some(([w, h]) => w === body.width && h === body.height)) return "Bad size";
  if (!["fast", "balanced", "high"].includes(body.quality)) return "Bad quality";
  const bytes = Buffer.from(String(body.pathBase64 ?? ""), "base64");
  if (bytes.length !== FRAME_COUNT * 12) return `Path has ${bytes.length} bytes, expected ${FRAME_COUNT * 12}`;
  return validateOverlays(body);
}

/** Text boxes (DESIGN.md 5.4): PNGs the size of the video, shown during sorted ranges in seconds. */
function validateOverlays(body) {
  const overlays = body.overlays ?? [];
  if (!Array.isArray(overlays) || overlays.length > 50) return "Bad overlays (at most 50)";
  for (const [i, o] of overlays.entries()) {
    const png = Buffer.from(String(o?.pngBase64 ?? ""), "base64");
    if (png.length > 4 << 20) return `Overlay ${i}: PNG over 4 MB`;
    if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || png.toString("latin1", 12, 16) !== "IHDR") {
      return `Overlay ${i}: not a PNG`;
    }
    const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    if (w !== body.width || h !== body.height) return `Overlay ${i}: PNG is ${w}x${h}, the video ${body.width}x${body.height}`;
    if (!Array.isArray(o.ranges)) return `Overlay ${i}: no ranges`;
    let last = 0;
    for (const r of o.ranges) {
      if (!Array.isArray(r) || r.length !== 2 || !r.every(Number.isFinite) || r[0] < last || r[1] <= r[0]) return `Overlay ${i}: bad range ${JSON.stringify(r)}`;
      last = r[1];
    }
  }
  return null;
}

/** What the editor sent for each text box (for the UI tests). */
function overlaySummary(overlays = []) {
  return overlays.map((o) => {
    const png = Buffer.from(o.pngBase64, "base64");
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), bytes: png.length, ranges: o.ranges };
  });
}

function pathSummary(b64) {
  const bytes = Buffer.from(b64, "base64");
  const f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  const pose = (i) => ({ yaw: f[i * 3], pitch: f[i * 3 + 1], fov: f[i * 3 + 2] });
  const frames = f.length / 3;
  return { frames, first: pose(0), middle: pose(Math.floor(frames / 2)), last: pose(frames - 1), finite: f.every(Number.isFinite) };
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".mp4": "video/mp4" };

async function handle(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Range, X-Filename",
      "Access-Control-Allow-Private-Network": "true",
      "Access-Control-Max-Age": "600",
    });
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const M = req.method;

  if (parts[0] === "__mock") {
    if (parts[1] === "state") {
      return send(res, 200, { projects: [...projects.values()], edits: Object.fromEntries(edits), ...mock, failedOnce: [...mock.failedOnce] });
    }
    if (parts[1] === "reset" && M === "POST") {
      for (const t of timers.values()) clearInterval(t);
      timers.clear();
      projects = new Map();
      edits = new Map();
      mock = { lastExport: null, editsPuts: 0, openFolder: [], failedOnce: new Set(), swaps: 0 };
      uploads.clear();
      previous.clear();
      if (url.searchParams.has("seed")) seed();
      return send(res, 200, { ok: true });
    }
  }

  if (parts[0] !== "api") {
    if (!WEB) return send(res, 404, "Mock helper: start with --web dist to serve the editor here.", { "Content-Type": "text/plain" });
    const file = normalize(join(WEB, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(WEB)) return fail(res, 403, "No");
    try {
      if (statSync(file).isFile()) return sendFile(req, res, file, MIME[extname(file)] ?? "application/octet-stream");
    } catch {
      // fall through
    }
    return fail(res, 404, "Not found");
  }

  if (parts[1] === "health" && M === "GET") {
    return send(res, 200, {
      app: "veoclone-helper", version: "0.0.0-mock",
      gpu: { name: "AMD Radeon RX 6800 (pretend)", backend: "Dx12" },
      ai: { available: true, provider: "DirectML", model: "yolo26n.onnx" },
      ffmpeg: true, dataDir: "C:\\Users\\You\\Videos\\VeoClone", freeDiskBytes: 412_000_000_000,
    });
  }
  if (parts[1] === "lenses" && M === "GET") return send(res, 200, lenses);

  if (parts[1] !== "projects") return fail(res, 404, "Unknown address.");
  if (parts.length === 2) {
    if (M === "GET") return send(res, 200, [...projects.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    if (M === "POST") {
      const body = await readJson(req);
      if (!body?.name?.trim()) return fail(res, 400, "Please give the match a name.");
      if (body.lensId && !lenses.some((l) => l.id === body.lensId)) return fail(res, 400, "That iPhone model is not in the list.");
      if (body.lensId === undefined) body.lensId = null;
      const p = newProject({ name: body.name.trim(), lensId: body.lensId ?? null, style: body.style ?? "broadcast" });
      projects.set(p.id, p);
      return send(res, 201, p);
    }
  }

  const p = projects.get(parts[2]);
  if (!p) return fail(res, 404, "This match no longer exists. It may have been deleted.");
  const rest = parts.slice(3);
  const route = `${M} ${rest[0] ?? ""}`;

  switch (route) {
    case "GET ":
      return send(res, 200, p);
    case "PATCH ": {
      const body = await readJson(req);
      if (body && "lensId" in body && body.lensId !== null && !lenses.some((l) => l.id === body.lensId)) return fail(res, 400, "That iPhone model is not in the list.");
      if ((body?.lensId !== undefined || body?.style) && busy(p)) return fail(res, 409, BUSY);
      if (typeof body?.name === "string") p.name = body.name.trim() || p.name;
      if (body && "lensId" in body && body.lensId !== p.lensId) {
        p.lensId = body.lensId;
        delete p.calibration; // the next "process" lines the videos up again
      }
      if (body?.style) p.style = body.style;
      p.updatedAt = now();
      return send(res, 200, p);
    }
    case "DELETE ":
      // Like the real helper: not while it works on the match or still receives a video.
      if (busy(p) || uploads.get(p.id)) return fail(res, 409, BUSY);
      projects.delete(p.id);
      previous.delete(p.id);
      return send(res, 200, { ok: true });
    case "PUT files": {
      const side = rest[1];
      if (side !== "left" && side !== "right") return fail(res, 404, "Unknown camera side.");
      if (busy(p)) return fail(res, 409, BUSY);
      let size = 0;
      uploads.set(p.id, (uploads.get(p.id) ?? 0) + 1);
      try {
        for await (const c of req) size += c.length;
      } finally {
        // Like the real helper, notice a dropped upload only a moment later.
        const done = () => uploads.set(p.id, uploads.get(p.id) - 1);
        if (req.complete) done();
        else setTimeout(done, 200);
      }
      if (!req.complete) return res.destroy();
      if (size === 0) return fail(res, 400, "That file is empty.");
      const name = decodeURIComponent(req.headers["x-filename"] ?? `${side}.mp4`);
      p.files[side] = { name, sizeBytes: size };
      p.status = p.files.left && p.files.right ? "uploaded" : "new";
      delete p.calibration;
      previous.delete(p.id);
      p.error = null;
      p.warnings = [];
      p.diskBytes = (p.files.left?.sizeBytes ?? 0) + (p.files.right?.sizeBytes ?? 0);
      return send(res, 200, p);
    }
    case "POST process":
      if (busy(p) || uploads.get(p.id)) return fail(res, 409, BUSY);
      if (!p.files.left || !p.files.right) return fail(res, 400, "Both videos are needed. Add the left and the right phone's video first.");
      if (p.status === "ready" && p.calibration) {
        previous.set(p.id, { style: madeWith.get(p.id) ?? p.style, warnings: p.warnings, calibration: p.calibration, fps: p.fps, frameCount: p.frameCount });
      }
      p.status = "queued";
      setTimeout(() => p.status === "queued" && startProcess(p), 300 / SPEED);
      return send(res, 200, p);
    case "POST cancel":
      cancelJobs(p);
      return send(res, 200, p);
    case "POST swap":
      if (busy(p) || uploads.get(p.id)) return fail(res, 409, BUSY);
      if (!p.files.left || !p.files.right) return fail(res, 400, "Both videos are needed. Add the left and the right phone's video first.");
      [p.files.left, p.files.right] = [p.files.right, p.files.left];
      delete p.calibration;
      previous.delete(p.id);
      Object.assign(p, { status: "uploaded", error: null, warnings: [], updatedAt: now() });
      mock.swaps++;
      return send(res, 200, p);
    case "GET calibration":
      if (p.status !== "ready") return fail(res, 404, "This match has not been processed yet.");
      return send(res, 200, { ...calibTemplate, proxy: { ...calibTemplate.proxy, url: `/api/projects/${p.id}/proxy.mp4` } });
    case "GET proxy.mp4":
    case "HEAD proxy.mp4":
      if (p.status !== "ready") return fail(res, 404, "This match has not been processed yet.");
      return sendFile(req, res, PROXY, "video/mp4");
    case "GET ai-path.bin":
      if (p.status !== "ready") return fail(res, 404, "This match has not been processed yet.");
      return sendFile(req, res, join(FIX, "ai_path.bin"), "application/octet-stream");
    case "GET edits":
      return send(res, 200, edits.get(p.id) ?? {});
    case "PUT edits": {
      const body = await readJson(req, 10 << 20);
      if (!body || typeof body !== "object" || Array.isArray(body)) return fail(res, 400, "The edits must be a JSON object.");
      edits.set(p.id, body);
      mock.editsPuts++;
      return send(res, 200, { ok: true });
    }
    case "POST exports": {
      if (p.status !== "ready") return fail(res, 409, "This match is not ready to export yet. Wait until processing has finished.");
      if (busy(p)) return fail(res, 409, BUSY);
      const body = await readJson(req, 400 << 20);
      const problem = validateExport(body);
      if (problem) return fail(res, 400, "The video settings were not accepted.", problem);
      const e = { id: newId(), status: "queued", progress: 0, createdAt: now(), width: body.width, height: body.height, quality: body.quality };
      p.exports.push(e);
      const overlays = overlaySummary(body.overlays);
      mock.lastExport = { segments: body.segments, width: body.width, height: body.height, quality: body.quality, path: pathSummary(body.pathBase64), overlays };
      setTimeout(() => e.status === "queued" && startExport(p, e, overlays.length > 0), 300 / SPEED);
      return send(res, 201, e);
    }
    case "GET exports":
    case "DELETE exports": {
      const e = p.exports.find((x) => x.id === rest[1]);
      if (!e) return fail(res, 404, "This video no longer exists.");
      if (M === "GET") {
        if (e.status !== "done") return fail(res, 404, "This video is not finished yet.");
        return sendFile(req, res, PROXY, "video/mp4", { "Content-Disposition": `attachment; filename="${e.fileName.replace(/[^\x20-\x7e]|"/g, "_")}"` });
      }
      if (e.status === "running") return fail(res, 409, "This video is still being made. Press Stop first.");
      p.exports = p.exports.filter((x) => x !== e);
      return send(res, 200, p);
    }
    case "POST open-folder":
      mock.openFolder.push({ project: p.id, export: url.searchParams.get("export") });
      return send(res, 200, { ok: true });
  }
  return fail(res, 404, "Unknown address.");
}

if (!args.includes("--empty")) seed();

createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!res.headersSent) fail(res, e.status ?? 500, e.status === 413 ? "That is too big." : "The mock helper hit a problem.", String(e?.stack ?? e));
    else res.destroy();
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Mock VeoClone helper on http://127.0.0.1:${PORT}  (speed x${SPEED}${WEB ? `, editor from ${WEB}` : ""})`);
});
