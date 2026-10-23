# VeoClone design

VeoClone turns two iPhone (or GoPro) recordings of a football match into a Veo-style
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
2. New match: name, "Which iPhone?" + "Which lens?" (4.6; once for both
   phones, or once per phone with "The two phones are different models"
   ticked; GoPros and "detect automatically" in the same list), camera style
   (Broadcast / Action / Wide / Follow the ball), AI accuracy (Best: every
   frame, default / Faster: every 3rd frame), and two drop boxes: **Left phone** and
   **Right phone**, each taking one file or all the files of a recording the
   camera split into parts (GoPro chapters, 4.10). Filming tips shown
   alongside. "Start" uploads both videos to the helper (progress bar per
   file) and then starts processing.
3. Processing: steps with progress bars and time remaining:
   check files (and make matching copies, 4.2) → line up & calibrate →
   make preview → AI ball tracking.
   Cancel button. Warnings (HDR footage, videos in different formats,
   generic lens, low calibration confidence) are shown in plain words. On failure: plain-language error +
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
   - **Straighten picture** (5.5): Tilt and Level sliders with "Look left /
     centre / right", for phones that pointed down.
   - **Mark the pitch** (4.8): click round the pitch on a big overview so the
     AI ignores people outside it; offered the first time a match opens.
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
  **vertical** field of view in **degrees**. World space: what a Reco
  `Panner` returns. Reco turns a world pose into the render pose its view
  matrix uses with the rig tilt/roll (`match.rig_tilt` / `rig_roll`, 5.5):
  0/0 for iPhones (no level sensor in the video), filled in from the
  accelerometer for GoPro/DJI footage. The editor's "Straighten picture"
  replaces them for the preview and the export.
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
left.001.<ext>    or: the parts of a recording in several files, in order
left.002.<ext>…   (GoPro chapters, 4.10); right.001.<ext>… likewise
matched-<side>.mp4   matching copy, only when the two phones filmed in
matched-<side>.json  different formats (4.2), and what it was made from
match.json        Reco MatchCalibration
calib.json        CalibInfo for the editor (section 4.4)
proxy.mp4         stacked preview video (section 4.3)
ai_path.bin       AI camera path (section 4.4)
ai_seen.bin.gz    what the AI saw (every detection), for quick re-runs (4.9)
ai_seen.json      how it was recorded (4.9)
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
   `color_transfer`, rotation, audio presence. A video in parts (4.10) is
   probed part by part and joined (`media::join_probes`): frame count and
   duration add up, the rest is the first part's; parts that differ in
   size, fps, codec, pixel format or rotation are refused in plain words. Fail with a clear message if
   rotation is 90/270 (portrait) or a file has no video. Warn if HDR
   (`color_transfer` = `arib-std-b67` or `smpte2084`) and the colours were
   not changed (below): "Colours may look washed out — turn off HDR Video on
   the phones next time". Warn if fps > 31 ("60 fps works but 30 fps is
   recommended").

   **Matching copies.** Reco needs both videos in the same size, frame rate
   and pixel format (it takes size and format from the left probe; the
   Windows D3D11 zero-copy path uses one staging format for both). Two
   different iPhones often differ (e.g. 1920x1440 8-bit SDR and 1920x1080
   10-bit HLG). `media::plan_matching` (pure, unit-tested) finds a mismatch
   when the sizes differ, the fps differ by > 0.5 or one is 10-bit and the
   other 8-bit. Then the reference is the video whose aspect is closest to
   16:9 (tie: fewer pixels; tie: left). The other is centre-cropped to the
   reference's aspect, scaled to its width x height, and made 8-bit `yuv420p`
   H.264 BT.709; a 10-bit or HDR reference also gets an 8-bit SDR copy at
   its own size. Both end up at the lower of the two frame rates (`fps`
   filter only when the rates differ by > 0.5; dropping frames looks smooth,
   doubling them judders). A video already in that format is left alone; identical
   formats need no copies at all. HDR sources are tone-mapped
   (`zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`)
   when `ffmpeg -filters` lists `zscale` (BtbN's build does), otherwise
   only converted (with the washed-out warning). Encoder `h264_amf`
   (`-quality quality -rc cqp -qp_i 16 -qp_p 18`) with `-hwaccel auto`,
   else / on failure `libx264 -preset veryfast -crf 17` (sound as AAC then);
   keyframe every 2 s; sound copied; `-fps_mode passthrough` so no frame is
   dropped or doubled (Reco pairs by count). ffmpeg turns 180° videos
   upright and writes no rotation, so Reco does not turn them again.
   A video in parts is read through the concat demuxer (4.10) with
   `setpts=N/(<source fps>)/TB` first, so the joins leave no gap in the
   frame times, and becomes one file.
   Written to a temp name, renamed to `matched-<side>.mp4`, with
   `matched-<side>.json` (upload size + modified time + plan; for parts the
   total size and the latest change): reused while
   those still match, otherwise made again (and everything derived from
   the old copy is deleted). Removed when that side is uploaded again, on
   swap, and when no longer needed. Runs inside step 1 with its own message
   ("Making the two videos match…"), frame progress and time left, after a
   free-disk check; cancel kills ffmpeg. Warning, e.g.: "The two phones
   filmed in different formats (1920x1440 and 1920x1080 HDR), so VeoClone
   made matching copies of both videos and changed the right video's HDR
   colours to normal colours. Next time set both phones the same: Settings
   › Camera › Record Video › 4K at 30 fps, and turn off HDR Video."
   From here on every step and every export reads the **working files** per
   side (`store::working_files`: the matching copy when there is one, else
   the original, all its parts in order) and their probe;
   `original_files` never returns a copy.
2. **Calibrate** with `reco_calibrate::video::calibrate_videos`, GUI-like
   config: 4 frames, AKAZE detect y 0.05–0.95, skip_start = min(10 s, 10%
   of duration). It reads the first working file of each side (for parts,
   the first part: it carries the GoPro's motion data used for the IMU sync
   and the rig level; audio sync uses its first 60 s), and the 10 % are of
   the left one's duration. Lens: always the project's lens choice per phone (4.6):
   `left_params` from `lensId` (`null` = `generic:ultra`), `right_params`
   from `rightLensId` (`null` = the same as `lensId`), each loaded from
   `LensDatabase::embedded()` and scaled to that side's working file the
   way reco-gui does (`fx *= w/p.width` …); Reco's auto-detection only for
   the `auto` choice (4.6), per side. Explicit lens params no longer skip
   the IMU: `calibrate_videos` now calls the new
   `CalibrationPipeline::probe_native_gyro` (patched in `reco-calibrate`;
   before, a chosen lens silently dropped a GoPro's IMU sync and its rig
   tilt/roll), so GoPro footage keeps the camera's own level. Warn
   when a lens is a "Not sure" guess (once, also when both are). The
   summary's `lens` names both phones when they differ ("Left phone: …;
   right phone: …"). Audio sync is automatic (needs ffmpeg). Save
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
   - a video in parts is one input through the concat demuxer (4.10);
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
   exactly like reco-gui's export (`crates/reco-gui/src/export.rs`), a video
   in parts given as `InputPath::Chained` (4.10): the
   style's tracking mode and preset (`broadcast`/`action`/`frame_all`
   field mode; `ball` = `TrackingMode::Ball` with the broadcast preset,
   which Reco turns into `ball_weight` 1.0, `BallTracker` max jump 0.5 and
   no player tracker), detection interval from `aiAccuracy` (1 or 3),
   lookahead 1.5 s, the pitch outline as `field_roi` (4.8), output to a
   throwaway 640x360 MKV with audio disabled (deleted afterwards). Instead
   of `.events()`, install a custom `PipelineEventSink` that records only
   `PanDecision` poses (world space, smoothed) into memory → `ai_path.bin`.
   Missing frames hold the previous pose. Fail early (before the long run)
   if the ONNX runtime or model cannot load; detect whether DirectML really
   registered and report the AI provider in `/api/health` and the job log.
   Reco is given the session through a `DetectionTarget` wrapper
   (`seen::Wiring`) that puts a chain around the detector it picks:
   record (4.9) → ball-mode confidence floor 0.25 → `RoiFilteredDetector`
   with the person class anchored at the feet (what `setup_autocam` does for
   a `field_roi`). The detector itself always runs at 0.10 (the field-mode
   floor) so the recording suits every style; Reco keeps a detection when
   `confidence >= threshold` and both filters keep the order, so the
   trackers get exactly the detections of Reco's own setup (verified: the
   ball path is bit-identical to `confidence_threshold = 0.25`).
   When a usable recording exists (4.9), this step instead rebuilds the
   path from it in about a second ("Using what the AI saw last time").
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
  "pathBase64": "<Float32 LE array, frameCount*3, [yaw,pitch,fov] per synced frame>",
  "overlays": [{ "pngBase64": "<PNG, export size>", "ranges": [[2.0, 7.0]] }],
  "rigTiltDeg": 12.5, "rigRollDeg": -1.5
}
```

- `segments`: keep-ranges, sorted, non-overlapping, `endFrame` exclusive.
- The path is the editor's **final** per-frame pose (already zoomed,
  smoothed, keyframed and clamped) for every synced frame. The helper never
  re-implements the editing algorithm — the editor is the single source of
  truth, so preview == export.
- For each segment: a `StitchJob::with_calibration` from the working files
  (4.2), `start_time(startFrame/fps)`, `end_time(endFrame/fps)` (a video in
  parts: from the part holding the first frame, see 4.10),
  `force_cpu_decode()`
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
- `overlays` (optional, default none): text boxes burned in after the
  concat, section 5.4.
- `rigTiltDeg` / `rigRollDeg` (optional; the editor always sends both):
  "Straighten picture" (5.5), Reco's rig tilt / roll in degrees, tilt
  −35..35, roll −25..25; `null` or out of range is refused in plain words
  ("Straighten picture: the tilt must be between -35 and 35 degrees …").
  Each one given replaces match.json's value in a copy of the
  `MatchCalibration` used for every part's `StitchJob` (match.json on disk
  is not changed); `StitchJob` hands them to the viewport, which the
  session's `director_position` (clamp in world space, then
  `world_to_render_pose`) and the renderer's view matrix use. Missing:
  match.json's values (older editors), so 0/0 is the same video as before.
  The job log names the values used.
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
`frameCount*3` values `[yaw, pitch, fovDeg]`, world space for match.json's
rig tilt/roll (the AI pass renders with it), before the FOV cap/clamp (the
editor applies them).

### 4.5 HTTP API (JSON unless noted; errors are `{ "error": "plain words", "detail": "technical" }` with 4xx/5xx)

| Method & path | Purpose |
|---|---|
| `GET /api/health` | `{ app:"veoclone-helper", version, gpu:{name,backend}, ai:{available, provider, model}, ffmpeg:bool, dataDir, freeDiskBytes }` |
| `GET /api/lenses` | Curated lens choices, see 4.6 |
| `GET /api/projects` | `ProjectMeta[]` newest first |
| `POST /api/projects` | body `{ name, lensId?, rightLensId?, style, aiAccuracy? }` → `ProjectMeta` |
| `GET /api/projects/:id` | `ProjectMeta` |
| `PATCH /api/projects/:id` | `{ name?, lensId?, rightLensId?, style?, aiAccuracy? }` |
| `DELETE /api/projects/:id` | deletes the folder (refuse while a job runs on it) |
| `PUT /api/projects/:id/files/:side` | side = `left`/`right`; raw body streamed to disk (write `*.part`, rename at end); header `X-Filename` (original name, for the extension); `?part=N&parts=M`: part N (from 1) of a video in M files (4.10), else (or 1 of 1) the whole video; deletes that side's matching copy; returns updated `ProjectMeta` |
| `POST /api/projects/:id/process` | start/queue the pipeline (also used for "Try again" and "Re-run AI with a different style") |
| `POST /api/projects/:id/cancel` | cancel the running/queued job of this project |
| `GET /api/projects/:id/calibration` | `CalibInfo` |
| `GET /api/projects/:id/proxy.mp4` | video with HTTP Range support |
| `GET /api/projects/:id/ai-path.bin` | binary path |
| `GET/PUT /api/projects/:id/edits` | editor state JSON (≤ 10 MB), `{}` if none |
| `PUT /api/projects/:id/pitch` | `{ points, left, right }` (4.8) → `ProjectMeta` |
| `DELETE /api/projects/:id/pitch` | remove the pitch outline → `ProjectMeta` |
| `POST /api/projects/:id/exports` | start export (section 4.3) → `ExportMeta` |
| `GET /api/projects/:id/exports/:eid/file` | download (`Content-Disposition: attachment`, Range) |
| `DELETE /api/projects/:id/exports/:eid` | delete an export |
| `POST /api/projects/:id/open-folder` | open the project (or `?export=eid`) folder in Explorer/Finder |
| `POST /api/projects/:id/swap` | swap the left and right videos (no re-upload) and, when `rightLensId` is set, the two lens ids; clears calibration, preview, AI path and matching copies; status back to `uploaded` |

`ProjectMeta`:

```ts
{
  id: string; name: string; createdAt: string; updatedAt: string;
  lensId: string | null;       // the left phone (and the right one unless rightLensId)
  rightLensId: string | null;  // the right phone when it is another model; null = same as left
  style: "broadcast" | "action" | "frame_all" | "ball";
  aiAccuracy: "best" | "faster";   // detection interval 1 / 3; missing in older files: best
  pitch: null | { id: string; points: [number, number][]; left: [number, number][]; right: [number, number][] }; // 4.8
  aiRun: null | { style; aiAccuracy; pitchId: string | null };  // what ai_path.bin was made with
  aiSeen: null | { every: number };  // a recording for quick re-runs exists (4.9); filled in when read
  status: "new" | "uploaded" | "queued" | "processing" | "ready" | "failed" | "cancelled";
  files: { left?: FileInfo; right?: FileInfo };  // FileInfo = { name, sizeBytes, probe?: {...}, parts? } (4.10)
  job: null | { kind: "process" | "export"; exportId?: string;
                step: "probe" | "calibrate" | "proxy" | "track" | "export" | "finalize" | "overlay";
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
`GET /api/lenses` are accepted. `rightLensId` (missing in older
`project.json` files: `null`) accepts those ids or `null`; changing either
id clears `calibration` so the next `process` calibrates again. `swap` also works with only one video
uploaded (it moves sides; status `new`) and refuses while busy (409).

### 4.6 Lens choices

The raw lens database has ~160 crowd-sourced Apple entries with messy names.
The user picks two simple things instead: **which iPhone** and **which lens**.
Normally once for both phones (`lensId`). Ticking **"The two phones are
different models"** (off by default; on when `rightLensId` is set) shows
the choice twice, headed **Left phone** (`lensId`) and **Right phone**
(`rightLensId`); unticking sends `rightLensId: null`. The same picker is
used on the new match page, the match page before processing and the
"Change phone or lens" dialog. Copy: "Two identical phones work best, but
different iPhones are fine".

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

- **Action cameras.** After the iPhones: `auto` ("GoPro or other action
  camera – detect automatically", lens `auto`) and GoPro HERO13/12/11/10/9
  Black, each `wide` and `linear` (`gopro-hero12-black:linear`, …), group
  "Action camera" (`LensOption.group`; iPhones "iPhone", "Not sure" empty).
  A GoPro option is Reco's own `LensDatabase::find("GoPro", model, w, h,
  Some("Wide"|"Linear"))` (the 16:9 profiles of HERO9/10/11 Black). The
  database has no 16:9 Wide or Linear profile for the HERO12/13 Black
  (only 8:7 Wide), so they use the HERO11 Black profile of the same lens
  mode (same lens and sensor), with a note. `auto` resolves each side from
  its working file: the fast telemetry probe
  (`telemetry::extract_metadata`); GoPro HERO12/13 Black with lens info
  Wide or Linear → the HERO11 Black profile; otherwise Reco's
  `lens_database::detect_profile` (a profile embedded in the file, then
  camera model + lens mode in the database, then the first profile with
  that picture size). That last one (`ProfileSource::Fallback`) is named
  "General action-camera settings (camera not recognised)" and warns:
  "VeoClone couldn't recognise the camera from the video file, so it used
  general settings for this picture size, which may not suit your camera.
  If the picture looks bent or the two halves don't join up, click “Change
  phone or lens” and choose your camera." The summary names the camera
  found ("GoPro HERO11 Black · Wide (found in the video file)").
- GoPro footage gives Reco the rig tilt/roll from the accelerometer
  (`imu_sync`, capped at 25°); nothing in VeoClone overrides it: the AI
  pass renders with match.json's values and the editor's Straighten picture
  starts from them (5.5).

### 4.7 Re-runs never lock the user out

If a re-run of a match that was `ready` (new style, Try again) is cancelled
or fails, or the helper closes during it, and the previous calibration,
preview and AI path are still valid, the match goes back to `ready` (old
outputs kept) with the problem added to `warnings`. Warnings are shown in
the editor and on the home card, not only on the processing page.

### 4.8 Pitch outline ("Mark the pitch")

People outside the pitch (substitutes, parents, a neighbouring game) pull
the player cluster, and so the camera, away from the play. Reco can drop
detections outside a per-camera polygon (match.json `field_roi`,
`AutocamConfig::with_field_roi` → `RoiFilteredDetector`): normalised
`[x, y]` image coordinates of each camera (y = 0 at the top, the
detector's own coordinates), a ball counts by its box centre, a person by
its feet and the point a quarter of its height above them (both must be
inside, `RoiAnchor::Bottom`). A camera with fewer than 3 corners is not
filtered at all.

- Editor: "Mark the pitch" (side panel under Whole pitch, and a one-time
  tip "Mark the pitch so the camera ignores people outside it", hidden for
  good with ×, `veoclone.hint.pitch.<id>`). A dialog shows a large
  whole-pitch overview with the editor's straightening (so it is level);
  the user clicks round the pitch (at least 4 points; more along curved
  edges), with Undo last point / Start again / Remove the outline.
- Engine (`engine/pitch.ts`, unit tested against Reco's
  `camera_to_panorama`): the clicked overview points (render yaw/pitch)
  are sampled on a 121×121 grid inside the outline (even-odd rule) plus 200
  points per edge; each direction goes through `sampleRay` (the renderer's
  own lens maths) to each camera's normalised image coordinates; each
  camera's points → convex hull (5 decimals). A camera that sees none of it
  gets `[]`. The outline itself is stored as aims (`points`, [yaw, pitch]),
  so it stays put when the straightening changes. For a real pitch (a
  ground rectangle clicked along its edges) the hulls miss nothing and add
  under 1 % (the fisheye bends the lines outwards).
- Helper: `PUT /pitch` checks the numbers (3–100 aims; polygons empty or
  3–500 corners in [−0.01, 1.01]; at least one camera) and stores it in
  `ProjectMeta.pitch` with a new `id`; `DELETE` removes it. New uploads and
  swaps drop it (it was marked on other videos). The AI pass uses
  `PitchOutline::field_roi()`; a camera with `[]` gets a polygon outside
  its picture (it sees nothing of the pitch, so everything it sees is
  ignored). `aiRun.pitchId` says which outline the AI path used; the editor
  shows "Pitch marked, but the AI camera doesn't use it yet: run the AI
  again" with a button, and asks right after saving ("Run the AI again" /
  "Later"). Running it from the editor returns to the editor afterwards.

### 4.9 Quick re-runs: what the AI saw

The AI pass records every detection of the person and ball classes before
any filtering (`seen::Recorder`, one block per `detect()` call: camera,
count, then class `u16` and confidence, centre, size as `f32`, gzip via
`flate2`) to `ai_seen.bin.gz`, and `ai_seen.json` (`SeenMeta`: model file
name + size, class ids resolved like `setup_autocam`, the fps given to
`setup_autocam`, lookahead frames, detection interval, frames, sync
offset). Size: about 11 bytes per detection; on the synthetic footage
(35 detections per frame) 399 bytes per frame, about 65 MB for 90 minutes
at 30 fps.

`seen::repan` rebuilds the path without the video, mirroring the session:
detection frame k ↔ frame k·interval, left then right detections; ball
floor and `RoiFilteredDetector` (Reco's code, on a replaying detector);
`camera_to_panorama` with the pipeline's scene; the last detections
re-used between detection frames; the trackers of `setup_autocam` (players
then ball, `dispatch_detect_only`); `FieldPanner::decide_with_lookahead`
with the next n = round(1.5 s × fps) world states (`run_buffered`'s
buffer); `centered_smooth` over half = max(n/2, 1) poses each side in the
same summation order. Every AI pass replays its own recording with its own
settings and keeps it only if the path is the same (yaw/pitch within 1e-4
rad, fov 1e-3°; measured: exactly 0); the job log names the difference.
Measured on the synthetic footage with the release helper: replay = live
pass bit for bit for every style, for every 3rd frame emulated from a
recording of every frame, and with a pitch outline; a re-run takes 0.5 s
against 70 s for the AI pass.

`process` uses the recording when the model is the same, the sync offset
matches and the new detection interval is a multiple of the recorded one
(every frame → every frame or every 3rd; every 3rd → only every 3rd), else
it runs the AI pass. Anything that recalibrates or changes the videos
deletes the recording with the AI path. `ProjectMeta.aiSeen` tells the
editor, which says "This takes a few seconds: VeoClone reuses what the AI
saw last time." or "about as long as the first time".

### 4.10 Recordings in parts (GoPro chapters)

A GoPro splits one long recording into files of about 4 GB ("chapters",
8–12 min each in 4K): GX010123.MP4, GX020123.MP4… on HERO6 and later (GX =
H.265, GH = H.264), GOPR0123.MP4 then GP010123.MP4, GP020123.MP4… on HERO5
and older. A 90-minute match is about 8–10 files per camera. They are never
joined into a new file (and so never re-encoded: the first part keeps the
GoPro's motion data untouched); every step reads the parts in order as one
video.

- **Editor** (`web/src/ui/parts.ts`, unit tested; `dropzone.ts`): a drop box
  takes several files (drop or multi-select; a new choice replaces the old
  one). They are ordered GoPro-aware (`sortParts`: recording number, then
  part, GOPR before GP01; other names by name, numbers counted) and listed
  under a summary ("4 parts · 1:32:10 · 15.2 GB", lengths read by the
  browser), each with ×. `checkParts` warns in plain words about files from
  different recordings (another recording number or camera letter, or a mix
  with other names), a missing part (also the first one, which carries the
  line-up data) or one there twice; other cameras' files get a note that
  they are joined in this order. Non-video files (a GoPro's .LRV and .THM)
  are left out. One file works as before. Parts are sent one after the other
  with `?part=N&parts=M` (progress per part and overall); Try again skips
  parts already sent, and parts the helper already has (same position, name
  and size in `FileInfo.parts`, e.g. after a reload) are skipped too. The
  old shortcut "two files in one box go left and right by name" is gone:
  several files in one box are that camera's parts.
- **Helper storage**: `left.001.<ext>`, `left.002.<ext>`… (one file stays
  `left.<ext>`). `store::side_files` lists both kinds, `original_files`
  gives the parts in order (empty when one in between is missing),
  `uploaded_files` only when as many as `ProjectMeta.files` lists are there
  and all were sent. A part upload replaces that part (any extension) and
  removes the single file and parts beyond M; a whole-video upload removes
  all parts; both drop the side's matching copy and everything derived, like
  any upload. Swap renames every part (all or nothing). `FileInfo.parts`:
  `(PartInfo | null)[]` with `PartInfo = { name, sizeBytes }`, null for a
  part not sent yet; `name` is the first part's, `sizeBytes` the total,
  `probe` the joined video's. The match is `uploaded` (and `process`
  accepted) only when both sides are complete.
- **Our ffmpeg steps** (preview, matching copy): one input
  `-f concat -safe 0 -i <list>` with an ffconcat list (`media::join_list`:
  absolute paths, `'` escaped as `'\''`) written next to the output with
  `.tmp.` in its name and deleted afterwards. The concat demuxer passes on
  every frame of every part in order; the preview counts frames
  (`trim=start_frame`, `setpts=N/…`), so the joins' timing does not matter;
  the matching copy renumbers the frame times first (4.2). Probe: per part,
  summed (4.2).
- **Reco** (AI pass, export): `InputPath::Chained`, decoded through Reco's
  ffconcat manifest and paired by frame count across the chain. Patched in
  `reco-io`: the manifest escapes `'` in paths (before, a data folder such
  as `C:\Users\O'Brien\…` broke chained input).
- **Export**: Reco finds a start by time, but the parts don't add up
  exactly in time (each part's sound runs a little past its picture, and
  Reco's manifest uses each file's container duration), so a time from the
  start of the recording can land a frame off in later parts; and Reco's
  chained sound passthrough only trims the first file. So each export
  segment reads from the part holding its first frame (`export::reads`):
  per side, the part and the frame within it of synced frame
  `startFrame + skip` (part frame counts: ffprobe `nb_frames`), the chain
  from there to the part holding the last frame, `start_time` = the smaller
  of the two in-part frames, `sync_offset` = right − left. With one file per
  side this is exactly `start_time(startFrame/fps)` and the match's sync
  offset, as before. It assumes each part decodes on its own to `nb_frames`
  frames (a GoPro chapter starts with a keyframe).
- **Verified**: unit tests (`store`, `api::upload_in_parts`,
  `media::joined_parts_keep_every_frame_once` with real ffmpeg: preview and
  matching copies from parts keep every frame once, also 60→30 fps,
  `export::reads_start_in_the_right_part`); the ignored GPU test
  `export_frame_alignment_in_parts` (brightness-coded parts of 400/400/400
  and 380/420/400 frames, each with its own sound: export segments inside a
  part, across joins, starting in a later part with drained and time seeks,
  and the preview, all frame-exact, sound continuous); and `e2e.py --only
  chapters` with the release helper: each synthetic clip encoded once more
  (no B-frames, keyframes at the cuts) is the one-file video, and cut by
  stream copy into 3 GoPro-named parts (256/256/88 and 256/256/100 frames,
  picture and sound from time 0) sent as parts: frameCount 600 like the
  one-file match; calibrated from the first parts the camera path differs
  from the one-file match's by at most 0.0004 rad and 0.02°; with the
  one-file match's calibration the AI path is bit-identical, the preview
  has the same 600 frames, and an export across the joins and into the
  last part has the same 195 frames and the same sound packets as the
  one-file export.

## 5. Editor engine (`web/src/engine/`) — pure TS, unit tested

### 5.1 Projection (must match Reco's export exactly)

Ported from `crates/reco-core/src/render/{scene.rs,renderer.rs}`,
`shaders/fisheye.wgsl`, `projection/virtual_camera.rs` and
`lens/rig_correction.rs` (rig tilt/roll, `web/src/engine/rigtilt.ts`).
Rendering samples the stacked proxy (left tile on top) directly — there is
no panorama image anywhere in Reco.

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
- Rig tilt `t` / roll `r` (radians; each applied only when |x| > 1e-6, as in
  Reco; with neither, everything below is the identity and the formulas
  above hold exactly). `view_matrix`: `B = rot(br, t)·bf`, `Ut = rot(br,
  t)·Y`, yaw axis `A = rot(B, −r)·Ut`; for a **render** pose (ry, rp):
  `F = rot(A, ry)·(cos rp·B + sin rp·Ut)`, camera up `rot(A, ry)·rot(br,
  rp)·A`, `R = normalize(F × up)`, `U = R × F` (look_at_rh). A **world**
  pose (what the path holds) goes through Reco's `world_to_render_pose`
  first: `C = rot(B, −r)·rot(br, t)`, render pose = yaw/pitch of
  `Cᵀ·dir(world)`; `render_to_world` is its exact inverse. Note that with
  roll Reco pitches about the un-rolled `br`, so the centre of a world pose's
  view is not exactly `dir(world)`; `directionToRenderPose` inverts the
  forward in closed form (`sin rp = d·A / (Ut·A)`, then the yaw about `A`),
  so "the pose that looks at this spot" is exact. Positive tilt = the phones
  point down (the IMU convention of `reco-calibrate` `telemetry::rig_tilt`);
  positive roll = they lean right (the picture turns clockwise).
- Per plane: intersect ray with the plane, local `(tu, tv)`, extended
  `uv = (tu,tv)·2 − 0.5`, KB4 fisheye distortion with normalised intrinsics
  (`fx/w, fy/h, cx/w, cy/h`, `d = [k1..k4]`, correction 1.0), reject outside
  [0,1]²; left alpha 1, right alpha `smoothstep(0, blend, uv.x)`; composite
  over black: left first, right on top.
- Sample the proxy: left tile = top half (v ∈ [0,0.5]), right = bottom half;
  clamp to half a texel inside each tile to avoid bleeding.
- Overview: an equirectangular map in **render** yaw/pitch (x → yaw from
  yawMax on the left to yawMin on the right; y → pitch from pitchMax at top
  to pitchMin at bottom; the ray of a point is the view centre of that
  render pose, so a straightened overview is level too), fitted to where
  the cameras show something (refitted when the straightening changes);
  same per-ray sampling. Helpers convert canvas ↔ render yaw/pitch
  (a click → `render_to_world` → clamp), directions → overview points (AI
  marker, fixes), and draw the camera frustum outline (edge rays → render
  yaw/pitch). Dragging the camera view moves the render pose, so a sideways
  drag pans level.

### 5.2 Clamp

Port `CoverageBoundary::safe_clamp` / `safe_clamp_world`
(`crates/reco-core/src/projection/coverage.rs`) and the FOV cap from
`session/frame_processing.rs::director_position`: cap fov to
`[1, maxFovDeg]` (min 8° in the editor UI), clamp pitch to
`[pitchMin + v/2, pitchMax − v/2]` (midpoint if empty), clamp yaw to the
yaw range at that pitch shrunk by `half_hfov = atan(aspect·tan(v/2))`, using
the 400-slice table with the same interpolation as `yaw_range_at`.

With rig tilt/roll the clamp does not change: `director_position` clamps
the Panner's **world** pose with `safe_clamp(…, rig_tilt = 0)` (the coverage
table is world space and does not depend on the rig) and only then applies
`world_to_render_pose`. The engine does the same, so a straightened path is
still a fixed point of Reco's clamp (checked against `reco stitch` events,
`fixtures/reco-rig-synth.json`). The clamp keeps the un-turned centre box
inside the coverage; a straightened view near the edge of the coverage can
show a little black in a corner, in the preview and the export alike.

### 5.3 Final path algorithm (`computeFinalPath`)

Input: AI path (Float32Array, frameCount×3), fps, `Edits`, `CalibInfo`.
Output: Float32Array frameCount×3 of final clamped poses.

```ts
interface Edits {
  version: 1;
  segments: { start: number; end: number }[]; // keep-ranges, frames, end exclusive; default [{0, frameCount}]
  keyframes: { frame: number; yaw: number; pitch: number; fov: number }[]; // yaw/pitch = aim (5.5), fov = pre-zoom (see below)
  zoom: number;          // 0.5..2, default 1; final fov = fov / zoom
  smoothSeconds: number; // 0..5, default 0; extra smoothing of the AI path
  holdSeconds: number;   // default 1.0: a fix holds fully this long before/after its keyframe(s)
  fadeSeconds: number;   // default 1.5: then blends back to the AI over this long
  joinSeconds: number;   // default 4.0: keyframes closer than this are joined into one move
  overlays: Overlay[];   // 5.4
  straighten: { tiltDeg: number; rollDeg: number }; // 5.5; default match.json's rig tilt/roll
  export: { width: number; height: number; quality: "fast" | "balanced" | "high" };
}
```

0. Straightening (5.5): the AI poses (world poses for match.json's rig) and
   the keyframes (aims) become **render** poses for `edits.straighten`;
   steps 1–4 work on render poses (yaw about the straightened up axis, so a
   move between fixes pans level), and step 5 turns them back into world
   poses before the clamp. When the straightening equals match.json's (the
   default) the AI poses only go through `world_to_render_pose` and back;
   without any rig tilt/roll nothing is converted (bit-identical to the
   rig-0 algorithm).
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
5. Render → world pose (`render_to_world`), then clamp (5.2) with aspect
   16/9. The output is exactly what the export's Panner returns (with
   `rigTiltDeg`/`rigRollDeg` = `edits.straighten`).

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

### 5.5 Straighten picture

Phones on a pole pointed **down** at the pitch: the virtual camera turns
about the phones' own up axis, which leans toward the pitch, so the picture
leans more and more as the camera turns left or right and the far side
slopes. Veo knows gravity; iPhone videos carry no level sensor data, so
Reco's calibration leaves `rig_tilt = rig_roll = 0`. Reco already corrects
a known rig tilt/roll (5.1); the editor lets the user set it.

- `Edits.straighten = { tiltDeg, rollDeg }`: Reco's rig tilt and roll in
  degrees (tilt −35..35, positive = the phones pointed down; roll −25..25,
  positive = they lean right, the picture turns clockwise). Default:
  match.json's values (0/0 for iPhones; a GoPro's or DJI's own level from
  the accelerometer, which Reco caps at 25°). `normalizeEdits` clamps them.
  Used for the preview (both views, picking, the frustum) and sent with
  every export (4.3).
- Aims: a keyframe stores where the centre of the picture looks, as the
  un-tilted yaw/pitch of that direction (`aimOfWorld` of the view the user
  saw). Changing the straightening never moves what a fix or the AI looks
  at; only the picture turns about its centre. The AI path's aims come from
  its world poses under match.json's rig. (Storing aims is simpler than
  storing world poses and converting them whenever the straightening
  changes, and undo/redo need nothing special.)
- UI: a "Straighten picture" section in the side panel: help text ("Move
  these until the far side of the pitch looks level when the camera looks
  left, centre and right…"), **Look left / Look centre / Look right**
  (preview only, not a fix: same fov and height above the straightened
  horizon, turned to where the clamp starts to push back, `lookAcross`;
  ends on play, seek, a camera move or pressing it again), **Tilt** and
  **Level** sliders (0.5° steps) each with a Reset to match.json's values
  ("Reset tilt to the camera's own level" when those are not 0). While a
  slider moves, four thin horizontal lines are drawn over the camera view.
  Undo/redo and autosave like other edits. A tip "Picture leaning when the
  camera turns? Use Straighten picture." shows at the top of the side panel while a
  match from cameras without level data (match.json 0/0) is not
  straightened; dismissing it (or using the sliders) is remembered in
  `localStorage` (`veoclone.hint.straighten`).
- No automatic estimate: in a perspective view even a perfectly levelled
  far touchline slopes toward its vanishing point when the camera turns,
  so a line-based guess would be confidently wrong; only the user can judge
  "level" from the horizon, buildings and posts.
- Parity (`web/tests/engine/parity.pw.ts` with world poses, synthetic
  footage, lossless proxy): `reco stitch` with rig tilt/roll in match.json
  vs the WebGL view gives 48–53 dB PSNR, the same as without, and the same
  render poses within 1e-6 rad.

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
  with HDR Video off. (Only when the two videos differ in format does the
  matching copy turn HDR into normal colours, 4.2.)
- Phones filming in different formats cost an extra conversion in step 1
  (about as long as decoding and encoding the video once) and disk space
  for the copy; a 4:3 video loses a strip at the top and bottom.
- One recording per camera per project (a recording in parts is fine,
  4.10). If the phones were stopped at half-time, make two projects.
- Audio sync needs the phones started within about 15 s of each other.
- 60 fps works but the AI camera tuning assumes 30 fps.
- No iPhone 16/17 lens profiles in Reco's database: those models use the
  closest older profile (4.6). GoPro HERO12/13 Black use the HERO11 Black's.
- A GoPro recording in parts (4.10): a missing part cannot be noticed at
  the end of a recording (only gaps and the first part), and a part
  missing in one camera puts the two cameras out of step from there on.
  Not tried with real GoPro chapter files here (no sample files).
- "Follow the ball" keeps a fixed zoom (Reco's ball mode has no player
  cluster to size it) and holds still when the ball is lost.
- GoPro auto-detection could not be tried on real GoPro footage here (no
  sample files); the unrecognised-camera path is tested.
- Straightening is set by eye (5.5); Reco's clamp keeps only the centre box
  of the view inside the coverage, so a straightened wide view at the very
  edge can show a black corner (the preview shows it too).
