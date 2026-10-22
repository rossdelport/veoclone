// Typed client for the VeoClone helper's HTTP API (docs/veoclone/DESIGN.md 4.5).
import type { CalibInfo, Edits, ExportQuality, Fps } from "./engine";

export type Style = "broadcast" | "action" | "frame_all";
export type ProjectStatus = "new" | "uploaded" | "queued" | "processing" | "ready" | "failed" | "cancelled";
export type Side = "left" | "right";
export type JobStep = "probe" | "calibrate" | "proxy" | "track" | "export" | "finalize" | "overlay";
export type ExportStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Health {
  app: string;
  version: string;
  gpu: { name: string; backend: string };
  ai: { available: boolean; provider: string; model: string | null };
  ffmpeg: boolean;
  dataDir: string;
  freeDiskBytes: number;
}

/** One "which iPhone, which lens" choice (DESIGN.md 4.6). */
export interface LensOption {
  /** Stored as ProjectMeta.lensId, e.g. "iphone-15-pro:ultra", "generic:ultra". */
  id: string;
  /** "iPhone 15 Pro", newest first; "Not sure" for the generic choices. */
  model: string;
  /** ultra = 0.5× ultra wide, main = 1× normal. */
  lens: "ultra" | "main";
  label: string;
  note?: string;
}

export interface ProbeInfo {
  width: number;
  height: number;
  fps: Fps;
  frameCount: number;
  duration: number;
  codec: string;
  pixelFormat: string;
  colorTransfer: string | null;
  rotation: number;
  hasAudio: boolean;
}

export interface FileInfo {
  name: string;
  sizeBytes: number;
  probe?: ProbeInfo;
}

export interface JobInfo {
  kind: "process" | "export";
  exportId?: string;
  step: JobStep;
  stepIndex: number;
  stepCount: number;
  progress: number;
  framesDone?: number;
  framesTotal?: number;
  etaSeconds?: number;
  message: string;
  startedAt: string;
}

export interface ExportMeta {
  id: string;
  status: ExportStatus;
  progress: number;
  createdAt: string;
  fileName?: string;
  sizeBytes?: number;
  width: number;
  height: number;
  quality: ExportQuality;
  error?: string;
}

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** The left phone's lens (and the right one's, unless rightLensId is set). */
  lensId: string | null;
  /** The right phone's lens when the two phones are different models; null (or missing, older VeoClone): the same as the left. */
  rightLensId?: string | null;
  style: Style;
  status: ProjectStatus;
  files: { left?: FileInfo; right?: FileInfo };
  job: JobInfo | null;
  error: { message: string; detail?: string } | null;
  warnings: string[];
  calibration?: { confidence: number; syncOffsetFrames: number; syncOffsetSeconds: number; lens: string };
  fps?: Fps;
  frameCount?: number;
  diskBytes: number;
  exports: ExportMeta[];
}

/** A text box burned into the export (DESIGN.md 5.4). */
export interface ExportOverlay {
  /** PNG the size of the video, mostly see-through. */
  pngBase64: string;
  /** When it shows, as [start, end) seconds of the finished video, sorted. */
  ranges: [number, number][];
}

export interface ExportRequest {
  segments: { startFrame: number; endFrame: number }[];
  width: number;
  height: number;
  quality: ExportQuality;
  pathBase64: string;
  /** At most 50; each PNG at most 4 MB. */
  overlays: ExportOverlay[];
}

/** An error with a plain-English message; `detail` holds the technical part. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly detail?: string,
  ) {
    super(message);
  }
  /** True when the helper could not be reached at all. */
  get offline(): boolean {
    return this.status === 0;
  }
}

export const NOT_RUNNING = "VeoClone isn't running on this PC. Open VeoClone.exe and try again.";

// ---------------------------------------------------------------------------
// Where the helper lives
// ---------------------------------------------------------------------------

export const DEFAULT_HELPER = "http://127.0.0.1:47863";
const STORAGE_KEY = "veoclone.helper";

function readStorage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStorage(value: string | null): void {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, value);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode: just don't remember it.
  }
}

/** Only a helper on this PC: the match videos must never go anywhere else. */
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;

/**
 * Same origin when the helper serves the page; otherwise ?helper=URL on this
 * PC (kept in localStorage, "?helper=" with no value forgets it), else the
 * default. Any other address is ignored.
 */
function resolveBase(): string {
  if (location.port === "47863" && /^(127\.0\.0\.1|localhost)$/.test(location.hostname)) return location.origin;
  const param = new URLSearchParams(location.search).get("helper");
  if (param !== null) {
    const clean = param.trim().replace(/\/+$/, "");
    const ok = LOOPBACK.test(clean);
    writeStorage(ok ? clean : null);
    if (ok) return clean;
  }
  const stored = readStorage();
  return stored && LOOPBACK.test(stored) ? stored : DEFAULT_HELPER;
}

export const helperBase = resolveBase();

/** Absolute URL for a helper path such as "/api/projects/x/proxy.mp4". */
export function helperUrl(path: string): string {
  return new URL(path, helperBase + "/").toString();
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const enc = encodeURIComponent;

async function errorFrom(res: Response): Promise<ApiError> {
  let message = `Something went wrong (error ${res.status}).`;
  let detail: string | undefined;
  try {
    const body = await res.json();
    if (typeof body?.error === "string") message = body.error;
    if (typeof body?.detail === "string") detail = body.detail;
  } catch {
    // Not JSON.
  }
  return new ApiError(message, res.status, detail);
}

async function request(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(helperUrl(path), {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (e) {
    throw new ApiError(NOT_RUNNING, 0, String(e));
  }
  if (!res.ok) throw await errorFrom(res);
  return res;
}

async function json<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const res = await request(method, path, body, timeoutMs);
  return (await res.json()) as T;
}

const project = (id: string) => `/api/projects/${enc(id)}`;

export const api = {
  health: () => json<Health>("GET", "/api/health", undefined, 4000),
  lenses: () => json<LensOption[]>("GET", "/api/lenses"),
  listProjects: () => json<ProjectMeta[]>("GET", "/api/projects"),
  createProject: (body: { name: string; lensId?: string | null; rightLensId?: string | null; style: Style }) =>
    json<ProjectMeta>("POST", "/api/projects", body),
  getProject: (id: string) => json<ProjectMeta>("GET", project(id)),
  updateProject: (id: string, body: { name?: string; lensId?: string | null; rightLensId?: string | null; style?: Style }) =>
    json<ProjectMeta>("PATCH", project(id), body),
  deleteProject: (id: string) => request("DELETE", project(id)).then(() => undefined),
  process: (id: string) => json<ProjectMeta>("POST", `${project(id)}/process`),
  cancel: (id: string) => json<ProjectMeta>("POST", `${project(id)}/cancel`),
  swap: (id: string) => json<ProjectMeta>("POST", `${project(id)}/swap`),
  calibration: (id: string) => json<CalibInfo>("GET", `${project(id)}/calibration`),
  aiPath: async (id: string): Promise<Float32Array> => {
    const res = await request("GET", `${project(id)}/ai-path.bin`, undefined, 120_000);
    return new Float32Array(await res.arrayBuffer());
  },
  getEdits: (id: string) => json<unknown>("GET", `${project(id)}/edits`),
  putEdits: (id: string, edits: Edits) => request("PUT", `${project(id)}/edits`, edits).then(() => undefined),
  startExport: (id: string, body: ExportRequest) =>
    json<ExportMeta>("POST", `${project(id)}/exports`, body, 120_000),
  deleteExport: (id: string, exportId: string) =>
    json<ProjectMeta>("DELETE", `${project(id)}/exports/${enc(exportId)}`),
  openFolder: (id: string, exportId?: string) =>
    request("POST", `${project(id)}/open-folder${exportId ? `?export=${enc(exportId)}` : ""}`).then(() => undefined),
  exportFileUrl: (id: string, exportId: string) => helperUrl(`${project(id)}/exports/${enc(exportId)}/file`),
};

// ---------------------------------------------------------------------------
// Uploads (XMLHttpRequest for upload progress; the File is streamed from disk)
// ---------------------------------------------------------------------------

export interface UploadProgress {
  loaded: number;
  total: number;
  /** Bytes per second, smoothed. */
  rate: number;
}

export interface Upload {
  promise: Promise<ProjectMeta>;
  abort: () => void;
}

export function uploadFile(id: string, side: Side, file: File, onProgress: (p: UploadProgress) => void): Upload {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<ProjectMeta>((resolve, reject) => {
    let lastTime = performance.now();
    let lastLoaded = 0;
    let rate = 0;
    xhr.open("PUT", helperUrl(`${project(id)}/files/${side}`));
    xhr.setRequestHeader("X-Filename", enc(file.name));
    xhr.upload.onprogress = (e) => {
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      if (dt > 0.25) {
        const instant = (e.loaded - lastLoaded) / dt;
        rate = rate ? rate * 0.7 + instant * 0.3 : instant;
        lastTime = now;
        lastLoaded = e.loaded;
      }
      onProgress({ loaded: e.loaded, total: e.lengthComputable ? e.total : file.size, rate });
    };
    xhr.onload = () => {
      let body: { error?: string; detail?: string } | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON.
      }
      if (xhr.status >= 200 && xhr.status < 300 && body) resolve(body as unknown as ProjectMeta);
      else
        reject(new ApiError(body?.error ?? `The upload failed (error ${xhr.status}).`, xhr.status || 500, body?.detail));
    };
    xhr.onerror = () => reject(new ApiError("The upload stopped because VeoClone could not be reached.", 0));
    xhr.onabort = () => reject(new ApiError("Upload cancelled.", 499));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/** True while the helper is (or will be) working on this project. */
export function isBusy(p: ProjectMeta): boolean {
  return (
    p.status === "queued" ||
    p.status === "processing" ||
    p.job !== null ||
    p.exports.some((e) => e.status === "queued" || e.status === "running")
  );
}

export interface Watch {
  stop(): void;
  /** Poll again right away (after starting a job). */
  refresh(): void;
}

/**
 * Fetch the project now and then every second while a job runs (every 5 s
 * otherwise, so changes made elsewhere still show).
 */
export function watchProject(id: string, onUpdate: (p: ProjectMeta) => void, onError: (e: ApiError) => void): Watch {
  let generation = 0;
  let timer = 0;
  const tick = async (gen: number) => {
    let delay = 5000;
    try {
      const p = await api.getProject(id);
      if (gen !== generation) return;
      onUpdate(p);
      if (isBusy(p)) delay = 1000;
    } catch (e) {
      if (gen !== generation) return;
      onError(e instanceof ApiError ? e : new ApiError(String(e)));
      delay = 3000;
    }
    if (gen === generation) timer = window.setTimeout(() => tick(gen), delay);
  };
  const refresh = () => {
    clearTimeout(timer);
    void tick(++generation);
  };
  refresh();
  return {
    stop: () => {
      generation = -1;
      clearTimeout(timer);
    },
    refresh: () => {
      if (generation >= 0) refresh();
    },
  };
}
