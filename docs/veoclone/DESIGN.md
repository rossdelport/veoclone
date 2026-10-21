# VeoClone design

VeoClone turns two iPhone recordings of a football match into a Veo-style
"follow the ball" video, with a browser editor to fix the camera, zoom and
trim before exporting. It is built on top of the Reco Video Stitcher crates
in this repository (AGPL-3.0, see `README.reco.md`).

There are two pieces:

1. **Helper** (`crates/veoclone-helper`) — a small program that runs on the
   user's own Windows PC (AMD Radeon RX 6800, Ryzen 7 5700X, 32 GB RAM). It is
   a localhost HTTP server that stores projects on disk and runs the heavy
   work (calibrate, AI tracking, export) through the Reco libraries
   in-process, using the GPU (DX12 + D3D11VA decode + DirectML AI).
2. **Editor** (`web/`) — a static website (Vite + TypeScript, no framework).
   Hosted free on GitHub Pages at `https://rossdelport.github.io/veoclone/`
   and also served by the helper itself at `http://127.0.0.1:47863/`. It
   talks to the helper over HTTP.

Nothing is uploaded to the internet. Video files only travel from the
browser to the helper on the same PC.

---

## 1. User flow

1. Home: list of matches (projects) with status, size, delete. A banner shows
   whether the helper is running; if not, explain how to start/download it.
2. New match: name, "Which iPhone?" + "Which lens?" (4.6), camera style
   (Broadcast / Action / Wide), and two drop boxes: **Left phone** and
   **Right phone**. Filming tips shown alongside. "Start" uploads both files
   to the helper (progress bar per file) and then starts processing.
3. Processing: steps with progress bars and time remaining:
   check files → line up & calibrate → make preview → AI ball tracking.
   Cancel button. Warnings (HDR footage, generic lens, low calibration
   confidence) are shown in plain words. On failure: plain-language error +
   "Try again".
4. Editor (opens when processing is done):
   - Big **camera view**: what the final video will look like at the playhead.
   - **Whole-pitch overview** strip: the full stitched view with a rectangle
     showing where the camera is pointing. Click/drag on it to point the
     camera there (adds a fix/keyframe at the playhead).
   - Drag inside the camera view to pan, mouse wheel to zoom (adds a
     keyframe at the playhead).
   - **Timeline** for the whole match: playhead, keep-ranges (trim / cut out
     half-time), keyframe markers (click to jump, delete), zoom in/out on the
     timeline.
   - Controls: play/pause, ±1 frame, ±5 s, playback speed, "Set start here",
     "Set end here", "Cut out a section", overall **zoom** slider, **smoothness**
     slider, "Undo", fix-length ("how long a fix lasts") slider.
   - Keyboard: Space play/pause, ←/→ 1 frame (Shift = 5 s), K add keyframe
     at the current view, Delete remove selected keyframe, Ctrl+Z undo.
   - Edits autosave to the helper.
   - **Export**: resolution (1080p default, 1440p, 4K), quality
     (Good/Better/Best). Progress, then "Download" and "Show in folder".

## 2. Repository layout

```
crates/reco-*            Reco (upstream, unchanged unless noted)
crates/veoclone-helper   NEW helper crate (binary `veoclone-helper`)
web/                     NEW editor (Vite + TS)
docs/veoclone/           this design, user guide pieces
.github/workflows/veoclone-*.yml   NEW CI, Windows packaging, Pages deploy
README.md                VeoClone user guide (Reco's README moved to README.reco.md)
```

Reco's `cla.yml` workflow and Dependabot config are removed. Other upstream
workflows stay but only run on manual dispatch (section 6).

## 3. Core concepts and units (shared by helper and editor)

- **Synced frame index** `f`: frame 0 is the first frame where both cameras
  are paired after the audio sync skip. Reco pairs frames purely by count:
  `leftSkip = max(0, -sync_offset)`, `rightSkip = max(0, sync_offset)`
  (positive `sync_offset` = right camera started first). `frameCount =
  min(leftFrames - leftSkip, rightFrames - rightSkip)`.
- **fps**: the left stream's nominal frame rate as a rational `{num, den}`.
  `time = f * den / num`.
- **Pose**: `{ yaw, pitch, fov }` — yaw radians (**positive = pan LEFT**, 0 ≈
  the seam between the cameras), pitch radians (positive = up), fov =
  **vertical** field of view in **degrees**. World space. Rig tilt/roll are
  0 for iPhones (only set from IMU telemetry); the editor may assume 0 but
  must show a warning if `match.rig_tilt`/`rig_roll` are non-zero.
- **Output aspect**: always 16:9 (1920x1080, 2560x1440, 3840x2160). The
  editor's camera view canvas is also 16:9 so the coverage clamp matches.
- **Render constants** used by both export and preview: `blendWidth = 0.15`
  (Reco StitchJob default), `lensCorrection = 1.0`.

## 4. Helper

### 4.1 Process & storage

- Listens on `127.0.0.1:47863` only (`--port` to override). Refuses requests
  whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>`
  (DNS-rebinding protection).
- CORS: allow origins `https://rossdelport.github.io`,
  `http://localhost:5173`, `http://127.0.0.1:5173`, and its own origin
  (extra origins via `--allow-origin`). Answer preflights including
  `Access-Control-Request-Private-Network` with
  `Access-Control-Allow-Private-Network: true`. Expose headers
  `Content-Range, Content-Length, Accept-Ranges`.
- Serves the editor's static files from `web/` next to the executable (or
  `--web-dir`), so `http://127.0.0.1:47863/` opens the editor.
- On start: prints a friendly banner ("Keep this window open while you use
  VeoClone"), opens the browser at `http://127.0.0.1:47863/` (disable with
  `--no-open`).
- Only one copy runs: it takes the port, then locks `<data>/veoclone.lock`,
  before touching the data dir; a second copy only opens the browser and
  exits ("VeoClone is already running").
- Data dir: `--data-dir`, else env `VEOCLONE_HOME`, else
  `<Videos folder>/VeoClone` (`dirs::video_dir()`, falling back to home).
  When the Videos folder is synced by OneDrive (env `OneDrive*`) or cannot
  be created, `<home>/VeoClone` is used instead, unless `Videos/VeoClone`
  already exists. The banner prints the folder.
  Projects live in `<data>/projects/<id>/`:

```
project.json      ProjectMeta (below), written atomically (tmp + rename)
left.<ext>        uploaded original (extension kept)
right.<ext>
match.json        Reco MatchCalibration
calib.json        CalibInfo for the editor (section 4.4)
proxy.mp4         stacked preview video (section 4.3)
ai_path.bin       AI camera path (section 4.4)
edits.json        editor state, opaque to the helper
exports/<id>/     export parts + final .mp4
log.txt           human-readable log of jobs for this project
```

- Exactly one GPU job runs at a time (a queue). Jobs run on a worker thread
  inside the helper wrapped in `catch_unwind`; job state is persisted in
  `project.json` so that after a helper restart a project that was mid-job
  shows as failed with "VeoClone was closed, or the PC restarted, while
  this was running. Press Try again." (or goes back to `ready`, 4.7).
  While a job runs the worker thread keeps Windows awake
  (`SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`; the
  screen may still turn off). After two processing runs in a row were cut
  short (`ProjectMeta.interruptedRuns >= 2`), the AI pass uses safe mode
  (CPU video decoding) until a run succeeds.
- ffmpeg/ffprobe children die with the helper (Windows job object with
  kill-on-close; Linux parent-death signal), and each preview encode writes
  a uniquely named temp file.
- Bundled tools are found next to the executable first, then on PATH:
  `ffmpeg(.exe)`, `ffprobe(.exe)`; AI model `models/yolo26n.onnx`
  (fallback `models/yolo26n_640.onnx`, override `--model` / env
  `VEOCLONE_MODEL`). Reco's audio sync shells out to `ffmpeg`, so the
  helper prepends its own exe directory to `PATH` at startup.

### 4.2 Processing pipeline (`POST /api/projects/:id/process`)

1. **Probe** both files (ffprobe JSON): width, height, fps, frame count
   (`nb_frames`, else duration×fps), duration, codec, pixel format,
   `color_transfer`, rotation, audio presence. Fail with a clear message if:
   resolutions differ, fps differ by > 0.5, rotation is 90/270 (portrait),
   a file has no video. Warn if HDR (`color_transfer` = `arib-std-b67` or
   `smpte2084`): "Colours may look washed out — turn off HDR Video on the
   phones next time". Warn if fps > 31 ("60 fps works but 30 fps is
   recommended").
2. **Calibrate** with `reco_calibrate::video::calibrate_videos`, GUI-like
   config: 4 frames, AKAZE detect y 0.05–0.95, skip_start = min(10 s, 10%
   of duration). Lens: always the project's lens choice (4.6; `null` =
   `generic:ultra`), loaded from `LensDatabase::embedded()`, scaled to the
   file resolution the way reco-gui does (`fx *= w/p.width` …), and passed
   as `left_params`/`right_params` (never Reco's auto-detect; warn when the
   lens is a "Not sure" guess). Audio sync is automatic (needs ffmpeg). Save
   `match.json` and check it loads before the preview step. Warn if
   confidence < 0.5 (mention swapped videos), if a file has no sound, or if
   a file's frame count and duration × fps differ by more than
   max(15, 0.2 %) (dropped frames / Auto FPS). Record `syncOffsetFrames`.
   A failed line-up suggests the videos may be the wrong way round (4.5
   `swap`). If the AI pass (or an export) reads more than 2 s fewer frames
   than expected, the job fails ("one of the files may be damaged").
3. **Preview proxy** with bundled ffmpeg: a vertically stacked, synced,
   constant-frame-rate H.264 file, left camera on top:
   - each camera scaled to **1280x720** (keep 16:9; if the source aspect is
     not 16:9, scale to width 1280 and even height), stacked → 1280x1440;
   - frame pairing by count, exactly like Reco: per input
     `trim=start_frame=<skip>,setpts=N/(<fps>)/TB,setparams=<bt709 tags>`
     (so ffmpeg 7 does not re-matrix HDR colours that Reco keeps), then
     `vstack`, and
     `-frames:v <frameCount>`; output rate = fps; `-g` = round(fps) (one
     keyframe per second for snappy seeking); `-movflags +faststart`;
     `yuv420p`, BT.709 tags; audio = left audio from `leftSkip/fps` seconds,
     AAC 128k;
   - decode with `-hwaccel auto` when available; encoder `h264_amf` if
     available (`-quality speed -rc cqp -qp_i 26 -qp_p 28`), else
     `libx264 -preset veryfast -crf 26`;
   - progress from `-progress pipe:1` (`frame=` lines).
4. **AI tracking** with `reco_io::StitchJob` + `reco_autocam::setup_autocam`
   exactly like reco-gui's export (`crates/reco-gui/src/export.rs`): field
   mode, the project's style preset (`broadcast`/`action`/`frame_all`),
   detection interval 3, lookahead 1.5 s, output to a throwaway 640x360 MKV
   with audio disabled (deleted afterwards). Instead of `.events()`, install
   a custom `PipelineEventSink` that records only `PanDecision` poses
   (world space, smoothed) into memory → `ai_path.bin`. Missing frames hold
   the previous pose. Fail early (before the long run) if the ONNX runtime
   or model cannot load; detect whether DirectML really registered and
   report the AI provider in `/api/health` and the job log.
5. Write `calib.json`, status `ready`.

Progress: each step reports `progress` 0..1 and, where known,
`framesDone/framesTotal` and `etaSeconds`. Cancel sets the StitchJob
interrupt flag / kills ffmpeg; a cancelled StitchJob returns `Ok`, so check
the flag afterwards.

### 4.3 Export (`POST /api/projects/:id/exports`)

Body (JSON):

```json
{
  "segments": [{ "startFrame": 0, "endFrame": 81000 }],
  "width": 1920, "height": 1080,
  "quality": "balanced",
  "pathBase64": "<Float32 LE array, frameCount*3, [yaw,pitch,fov] per synced frame>"
}
```

- `segments`: keep-ranges, sorted, non-overlapping, `endFrame` exclusive.
- The path is the editor's **final** per-frame pose (already zoomed,
  smoothed, keyframed and clamped) for every synced frame. The helper never
  re-implements the editing algorithm — the editor is the single source of
  truth, so preview == export.
- For each segment: a `StitchJob::with_calibration` from the originals,
  `start_time(startFrame/fps)`, `end_time(endFrame/fps)`, `force_cpu_decode()`
  (exact frame accounting and fast seeking for trims; the D3D11 zero-copy
  immediate path drops the first frame), lookahead 0, no AI model,
  `blend_width(0.15)`, resolution, `Quality`, h264, `Format::Mkv`, audio from
  left. An `on_session` hook installs a `Panner` that returns
  `path[startFrame + ctx.frame_index]` (hold last pose beyond the end).
  The implementation must verify the frame alignment with a test (e.g. a
  path whose yaw encodes the frame index, checked via events or pixels).
  Reco's CPU source seeks trims over 10 s by time; it accepts a frame up to
  half a frame early (patched in `reco-io`, phone timestamps jitter by a
  1/600 s tick), so trims land on the counted frame. A dropped frame
  (timestamp gap) before a trim still shifts that camera by one frame.
- Then concat the parts with ffmpeg (`-f concat -c copy`) into
  `exports/<id>/<project name> <date>.mp4` with `-movflags +faststart`.
- Export status is tracked in `project.json` (`exports[]`).

### 4.4 Editor data

`GET /api/projects/:id/calibration` → `CalibInfo`:

```json
{
  "fps": { "num": 30, "den": 1 },
  "frameCount": 162000,
  "proxy": { "url": "/api/projects/ID/proxy.mp4", "tileWidth": 1280, "tileHeight": 720, "layout": "vstack" },
  "match": { "...": "match.json verbatim" },
  "coverage": {
    "pitchMin": -0.55, "pitchMax": 0.57, "maxFovDeg": 41.2,
    "slices": [[yawMin, yawMax], "... 400 rows, pitch from pitchMin to pitchMax inclusive"]
  },
  "render": { "blendWidth": 0.15, "lensCorrection": 1.0, "outputAspect": 1.7777778 }
}
```

`coverage` comes from `CoverageBoundary::from_calibration(&cal,
&SceneGeometry::from_layout_with_aspect(&cal.layout, w/h))` sampled with
`yaw_range_at(pitchMin + i/399·(pitchMax−pitchMin))` for i in 0..400, plus
`max_fov_degrees()`.

`GET /api/projects/:id/ai-path.bin` → `application/octet-stream`, Float32 LE,
`frameCount*3` values `[yaw, pitch, fovDeg]`, world space, before the FOV
cap/clamp (the editor applies them).

### 4.5 HTTP API (JSON unless noted; errors are `{ "error": "plain words", "detail": "technical" }` with 4xx/5xx)

| Method & path | Purpose |
|---|---|
| `GET /api/health` | `{ app:"veoclone-helper", version, gpu:{name,backend}, ai:{available, provider, model}, ffmpeg:bool, dataDir, freeDiskBytes }` |
| `GET /api/lenses` | Curated lens choices, see 4.6 |
| `GET /api/projects` | `ProjectMeta[]` newest first |
| `POST /api/projects` | body `{ name, lensId?, style }` → `ProjectMeta` |
| `GET /api/projects/:id` | `ProjectMeta` |
| `PATCH /api/projects/:id` | `{ name?, lensId?, style? }` |
| `DELETE /api/projects/:id` | deletes the folder (refuse while a job runs on it) |
| `PUT /api/projects/:id/files/:side` | side = `left`/`right`; raw body streamed to disk (write `*.part`, rename at end); header `X-Filename` (original name, for the extension); returns updated `ProjectMeta` |
| `POST /api/projects/:id/process` | start/queue the pipeline (also used for "Try again" and "Re-run AI with a different style") |
| `POST /api/projects/:id/cancel` | cancel the running/queued job of this project |
| `GET /api/projects/:id/calibration` | `CalibInfo` |
| `GET /api/projects/:id/proxy.mp4` | video with HTTP Range support |
| `GET /api/projects/:id/ai-path.bin` | binary path |
| `GET/PUT /api/projects/:id/edits` | editor state JSON (≤ 10 MB), `{}` if none |
| `POST /api/projects/:id/exports` | start export (section 4.3) → `ExportMeta` |
| `GET /api/projects/:id/exports/:eid/file` | download (`Content-Disposition: attachment`, Range) |
| `DELETE /api/projects/:id/exports/:eid` | delete an export |
| `POST /api/projects/:id/open-folder` | open the project (or `?export=eid`) folder in Explorer/Finder |
| `POST /api/projects/:id/swap` | swap the left and right videos (no re-upload); clears calibration, preview and AI path; status back to `uploaded` |

`ProjectMeta`:

```ts
{
  id: string; name: string; createdAt: string; updatedAt: string;
  lensId: string | null; style: "broadcast" | "action" | "frame_all";
  status: "new" | "uploaded" | "queued" | "processing" | "ready" | "failed" | "cancelled";
  files: { left?: FileInfo; right?: FileInfo };  // FileInfo = { name, sizeBytes, probe?: {...} }
  job: null | { kind: "process" | "export"; exportId?: string;
                step: "probe" | "calibrate" | "proxy" | "track" | "export" | "finalize";
                stepIndex: number; stepCount: number; progress: number;
                framesDone?: number; framesTotal?: number; etaSeconds?: number;
                message: string; startedAt: string };
  error: null | { message: string; detail?: string };
  warnings: string[];
  calibration?: { confidence: number; syncOffsetFrames: number; syncOffsetSeconds: number; lens: string };
  fps?: { num: number; den: number }; frameCount?: number;
  diskBytes: number;
  exports: ExportMeta[];  // { id, status: "queued"|"running"|"done"|"failed"|"cancelled", progress, createdAt, fileName?, sizeBytes?, width, height, quality, error? }
  interruptedRuns: number;  // processing runs cut short in a row (4.1 safe mode)
}
```

`ExportMeta.error` is the plain-words message, then (after a newline) the
technical detail. `lensId` is never null for new matches: `POST`/`PATCH`
with no or a `null` lensId store `"generic:ultra"`; only the ids from
`GET /api/lenses` are accepted. `swap` also works with only one video
uploaded (it moves sides; status `new`) and refuses while busy (409).

### 4.6 Lens choices

The raw lens database has ~160 crowd-sourced Apple entries with messy names.
The user picks two simple things instead: **which iPhone** and **which lens**.

`GET /api/lenses` → `LensOption[]`:

```ts
{ id: string;            // stable id stored as ProjectMeta.lensId, e.g. "iphone-15-pro:ultra", "generic:ultra"
  model: string;         // "iPhone 15 Pro", ... newest first; "Not sure" for the generic entries
  lens: "ultra" | "main";// ultra = 0.5× ultra wide, main = 1× normal
  label: string;         // "iPhone 15 Pro · Ultra wide (0.5×)"
  note?: string }        // e.g. "Uses the iPhone 15 Pro profile (closest match)"
```

- Exactly one option per (model, lens). Every listed model offers both
  lenses; when the database has no good profile for one, map it to the
  closest model that has one and say so in `note`. (The iPhone 16e and Air
  have no 0.5× lens; their `ultra` option's note says so.) Labels:
  "<model> · Ultra wide (0.5×)" and "<model> · Normal (1×)"; "Not sure"
  options come first. Include current models
  missing from the database (iPhone 16 / 16 Plus / 16 Pro / 16 Pro Max / 16e,
  iPhone 17 / Air / 17 Pro / 17 Pro Max) mapped to the closest profile.
- The helper picks the underlying database profile per option: prefer clean
  4K stock-Camera-app entries; skip Log/ProRes/third-party-app/cinematic/
  telephoto/front/vertical/odd-resolution entries; every chosen profile must
  load and scale to 3840x2160 and 1920x1080 (unit-tested).
- `generic:ultra` / `generic:main` ("Not sure") use a representative recent
  iPhone profile of that lens type — never Reco's resolution-only fallback
  (which is an action camera). Default for new matches: `generic:ultra`.
- Old free-form lens ids keep working if they still resolve; otherwise treat
  as `generic:ultra` with a warning.
- Changing the lens of a processed match (`PATCH lensId` then `process`)
  re-calibrates and rebuilds everything; the editor offers this when the
  picture looks bent or the halves don't join.

### 4.7 Re-runs never lock the user out

If a re-run of a match that was `ready` (new style, Try again) is cancelled
or fails, or the helper closes during it, and the previous calibration,
preview and AI path are still valid, the match goes back to `ready` (old
outputs kept) with the problem added to `warnings`. Warnings are shown in
the editor and on the home card, not only on the processing page.

## 5. Editor engine (`web/src/engine/`) — pure TS, unit tested

### 5.1 Projection (must match Reco's export exactly)

Ported from `crates/reco-core/src/render/{scene.rs,renderer.rs}`,
`shaders/fisheye.wgsl`, `projection/virtual_camera.rs`. Rendering samples
the stacked proxy (left tile on top) directly — there is no panorama image
anywhere in Reco.

- Layout from `match.params`: `h = 0.5*(1 − intersect)`; left plane at
  `(0,0,h)` with `M_L = T·Rx(zRx)·Rz(zRz)·Ry(π/2)`; right plane at
  `(h,xTy,0)` with `M_R = T·Rz(xRz)·Rx(xRx)`; eye `(c,0,c)` with
  `c = cameraAxisOffset`. Quad local x ∈ [−0.5,0.5], y ∈ [−0.5/a, 0.5/a],
  `a = left.width/left.height`; `u = x+0.5`, `v = 0.5 − y·a`.
- Basis: `bf = normalize(−eye)`, `br = normalize(bf × (0,1,0))`, up = +Y.
  `hz = cos(yaw)·bf − sin(yaw)·br`, `F = cos(p)·hz + sin(p)·Y`,
  `R = cos(yaw)·br + sin(yaw)·bf`, `U = cos(p)·Y − sin(p)·hz`.
  Ray for ndc ∈ [−1,1]² (ndc.y = +1 top): `F + ndc.x·tan(v/2)·aspect·R +
  ndc.y·tan(v/2)·U`.
- Per plane: intersect ray with the plane, local `(tu, tv)`, extended
  `uv = (tu,tv)·2 − 0.5`, KB4 fisheye distortion with normalised intrinsics
  (`fx/w, fy/h, cx/w, cy/h`, `d = [k1..k4]`, correction 1.0), reject outside
  [0,1]²; left alpha 1, right alpha `smoothstep(0, blend, uv.x)`; composite
  over black: left first, right on top.
- Sample the proxy: left tile = top half (v ∈ [0,0.5]), right = bottom half;
  clamp to half a texel inside each tile to avoid bleeding.
- Overview: an equirectangular map of the coverage (x → yaw from yawMax on
  the left to yawMin on the right; y → pitch from pitchMax at top to
  pitchMin at bottom), same per-ray sampling; plus helpers to convert
  canvas ↔ yaw/pitch and to draw the camera frustum outline (edge rays →
  yaw/pitch).

### 5.2 Clamp

Port `CoverageBoundary::safe_clamp` / `safe_clamp_world`
(`crates/reco-core/src/projection/coverage.rs`) and the FOV cap from
`session/frame_processing.rs::director_position`: cap fov to
`[1, maxFovDeg]` (min 8° in the editor UI), clamp pitch to
`[pitchMin + v/2, pitchMax − v/2]` (midpoint if empty), clamp yaw to the
yaw range at that pitch shrunk by `half_hfov = atan(aspect·tan(v/2))`, using
the 400-slice table with the same interpolation as `yaw_range_at`.

### 5.3 Final path algorithm (`computeFinalPath`)

Input: AI path (Float32Array, frameCount×3), fps, `Edits`, `CalibInfo`.
Output: Float32Array frameCount×3 of final clamped poses.

```ts
interface Edits {
  version: 1;
  segments: { start: number; end: number }[]; // keep-ranges, frames, end exclusive; default [{0, frameCount}]
  keyframes: { frame: number; yaw: number; pitch: number; fov: number }[]; // fov = pre-zoom (see below)
  zoom: number;          // 0.5..2, default 1; final fov = fov / zoom
  smoothSeconds: number; // 0..5, default 0; extra smoothing of the AI path
  holdSeconds: number;   // default 1.0: a fix holds fully this long before/after its keyframe(s)
  fadeSeconds: number;   // default 1.5: then blends back to the AI over this long
  joinSeconds: number;   // default 4.0: keyframes closer than this are joined into one move
  export: { width: number; height: number; quality: "fast" | "balanced" | "high" };
}
```

1. `base = AI`; if `smoothSeconds > 0`, centred moving average of yaw,
   pitch and fov with window `2·round(smoothSeconds·fps/2)+1` (shrinking
   at the ends).
2. Keyframes sorted by frame are grouped into chains (consecutive gap ≤
   `joinSeconds·fps`). Within a chain `M(f)` interpolates consecutive
   keyframes with smoothstep easing; before/after the chain it is the
   first/last keyframe.
3. Weight for chain `[a, b]`: 1 for `a − hold ≤ f ≤ b + hold`; beyond that
   `1 − smoothstep(0, fade, distance past the hold)`. Use the chain with the
   largest weight. `pose = lerp(base, M, w)`.
4. Zoom: `fov = fov / zoom`. Keyframes store the pre-zoom fov (the fov the
   user saw × zoom at the time), so the zoom slider affects everything.
5. Clamp (5.2) with aspect 16/9.

Frame ↔ time: `frame = round(t · num/den)` clamped to [0, frameCount−1];
the editor reads the exact presented frame via
`requestVideoFrameCallback` (`metadata.mediaTime`).

### 5.4 Text overlays

Text boxes the user types (team names, date, player name tags, anything),
shown in the editor preview and burned into the export. The browser draws
every overlay, for both preview and export, with one function, so the
export looks exactly like the preview (same font, wrapping, box).

```ts
interface Overlay {
  id: string;
  kind: "title" | "player" | "text";   // only affects the defaults when added
  text: string;                          // may contain line breaks, ≤ 200 chars
  position: "top-left" | "top-center" | "top-right" | "center"
          | "bottom-left" | "bottom-center" | "bottom-right";
  size: "small" | "medium" | "large";
  start: number; end: number;            // synced frames, end exclusive
}
// Edits.overlays: Overlay[] (default []), normalizeEdits keeps valid ones.
```

- `drawOverlay(ctx, overlay, width, height)` (`web/src/engine/overlay.ts`):
  white bold text (system UI font stack) on a rounded, semi-transparent dark
  box, sizes relative to the frame height (small/medium/large ≈ 3.5/5/7 % of
  height per line), margin ≈ 3 % of height from the edges. Same call for the
  preview (an overlay canvas over the camera view, scaled to its size) and
  the export (an offscreen canvas at the export size → PNG).
- Defaults when added at the playhead:
  - **Match title**: "Home team vs Away team" + new line + today's date
    (e.g. "Sat 25 Oct 2026"), top-center, medium, the whole video.
  - **Player name**: "#10 Player name", bottom-left, medium, 5 s from the
    playhead.
  - **Text**: "Your text", bottom-center, medium, 5 s from the playhead.
- Editor: a **Text** section in the side panel with the three "Add" buttons
  and a list of overlays. Selecting one lets the user edit the text (live
  preview), position (a 3×3-style picker or select), size, "Show from here" /
  "Hide from here" (set start/end to the playhead) and delete. Overlays
  appear as bars on the timeline; clicking a bar selects it and jumps there.
  Undo/redo and autosave cover overlays like other edits.
- Export: the editor maps each overlay's [start, end) through the kept
  segments to output-time ranges in seconds (an overlay crossing a cut
  becomes several ranges; one entirely inside a cut is dropped), renders
  each overlay once as a PNG at the export size, and adds to the export
  body: `overlays: [{ pngBase64, ranges: [[startSec, endSec], …] }]`
  (≤ 50 overlays, each PNG ≤ 4 MB, dimensions must equal the export size).
- Helper: if `overlays` is non-empty, after joining the parts it runs one
  more ffmpeg pass that overlays the PNGs with
  `overlay=0:0:enable='between(t,a,b)+between(t,c,d)'` chains, re-encodes
  video with the same encoder choice and quality as the export (h264_amf
  when available, else libx264), copies audio, `+faststart`. A new job step
  "Adding text" with progress. With no overlays nothing changes.

## 6. Hosting, packaging, CI

- `veoclone-ci.yml` (push/PR): web typecheck + unit tests + build; helper
  `cargo fmt --check`, `clippy -D warnings`, `cargo test -p veoclone-helper`
  on Ubuntu.
- `veoclone-windows.yml` (push to the default branch and `claude/**`
  branches, tags `veoclone-v*`, manual): builds `veoclone-helper.exe --features load-dynamic` on
  `windows-latest` the way Reco's `release.yml` does (BtbN FFmpeg n7.1
  win64-gpl-shared, LLVM, ONNX Runtime DirectML 1.24.4 + DirectML 1.15.4 from
  NuGet), builds the web app, downloads `yolo26n.onnx`/`yolo26n_640.onnx`
  from Reco's v0.5.2 release with SHA-256 check, and zips:

```
VeoClone/
  VeoClone.exe              (the helper, renamed)
  ffmpeg.exe ffprobe.exe *.dll   (FFmpeg shared build)
  onnxruntime.dll DirectML.dll
  models/yolo26n.onnx models/yolo26n_640.onnx
  web/…                     (built editor)
  LICENSE  README.txt
```

  Uploaded as a workflow artifact; builds of the repository's **default
  branch** (whatever it is called — today `claude/happy-einstein-iqtkqs`,
  later perhaps `main`) also update a rolling GitHub release
  `helper-latest`; `veoclone-v*` tags make a normal release.
- `veoclone-pages.yml` (push, manual): builds `web/` and deploys to GitHub
  Pages only from the default branch (one-time: Settings → Pages → Source:
  GitHub Actions).
- Upstream Reco workflows (`rust.yml`, `release.yml`, `build-test.yml`,
  `test-build-gui.yml`) only run on manual dispatch in this repository, and
  Reco's Dependabot config is removed, so the owner isn't flooded with
  irrelevant runs and pull requests.
- The web build uses `base: './'` and hash routing (`#/`, `#/new`,
  `#/project/:id`, `#/edit/:id`) so the same build works on Pages and from
  the helper.

## 7. Known limits (tell the user, don't hide)

- HDR iPhone footage: Reco has no HDR handling → washed-out colours. Record
  with HDR Video off.
- One file per phone per project. If the phones were stopped at half-time,
  make two projects.
- Audio sync needs the phones started within about 15 s of each other.
- 60 fps works but the AI camera tuning assumes 30 fps.
- No iPhone 16/17 lens profiles in Reco's database: those models use the
  closest older profile (4.6).
