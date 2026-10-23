// The editor (#/edit/:id): camera view, whole-pitch overview, timeline,
// trims, camera fixes (keyframes), sliders, autosave and export.
import { api, helperUrl, watchProject, type ProjectMeta } from "../api";
import {
  aimOfWorld,
  buildRig,
  CameraViewRenderer,
  clampPose,
  drawOverlay,
  formatFrameTime,
  frameToTime,
  frustumOutline,
  globalYawRange,
  keptFrameCount,
  keyframeFromView,
  lookAcross,
  maxFovOf,
  normalizeEdits,
  OverviewRenderer,
  overviewPointOf,
  poseAt,
  renderToWorldPose,
  STRAIGHTEN_LIMITS,
  straightenOfMatch,
  straightenRadians,
  timeToFrame,
  withRigTilt,
  worldToRenderPose,
  yawPitchToDirection,
  type CalibInfo,
  type Edits,
  type LookSide,
  type Pose,
  type Rig,
  type Straighten,
} from "../engine";
import { button, describeError, errorBox, iconButton, notice, toast } from "./common";
import { debounce, formatDuration, h, icon, setChildren } from "./dom";
import { EditStore, upsertKeyframe, type SaveState } from "./editStore";
import { ExportPanel } from "./exportPanel";
import { I } from "./icons";
import { changeLens } from "./lens";
import type { Page, PageContext } from "./page";
import { STYLES } from "./newMatch";
import { editableTitle } from "./project";
import { cutOut, cutParts, isKept, keep, nextKept, setEnd, setStart } from "./segments";
import { TextPanel } from "./textPanel";
import { Timeline } from "./timeline";

const ASPECT = 16 / 9;
const MIN_FOV = 8;
const DEG = Math.PI / 180;

/** Straighten picture values as shown next to the sliders. */
const fmtTilt = (v: number) => (Math.abs(v) < 0.05 ? "0°" : `${Math.abs(v).toFixed(1)}° ${v > 0 ? "down" : "up"}`);
const fmtLevel = (v: number) => (Math.abs(v) < 0.05 ? "0°" : `${v > 0 ? "↻" : "↺"} ${Math.abs(v).toFixed(1)}°`);

export function editorPage(ctx: PageContext, id: string): Page {
  ctx.setTitle("Editor");
  document.body.classList.add("editor-mode");
  ctx.root.append(h("div", { class: "editor-loading" }, h("div", { class: "spinner", "aria-hidden": "true" }), h("p", null, "Opening the editor…")));

  let disposed = false;
  let cleanup: (() => void) | null = null;
  let store: EditStore | null = null;

  const showError = (message: string, detail?: string) => {
    setChildren(ctx.root, h("div", { class: "page" }, errorBox(message, detail, button("Try again", () => location.reload(), { variant: "primary", icon: I.refresh }), h("a", { class: "btn btn-ghost", href: "#/" }, "Back to your matches"))));
  };

  (async () => {
    const project = await api.getProject(id);
    if (disposed) return;
    if (project.status !== "ready") {
      location.replace(`#/project/${id}`);
      return;
    }
    const [calib, ai, raw] = await Promise.all([api.calibration(id), api.aiPath(id), api.getEdits(id)]);
    if (disposed) return;
    const result = build(ctx, id, project, calib, ai, normalizeEdits(raw, calib.frameCount, straightenOfMatch(calib.match)));
    store = result.store;
    cleanup = result.dispose;
  })().catch((e) => {
    if (disposed) return;
    const { message, detail } = describeError(e);
    showError(message, detail);
  });

  return {
    dispose() {
      disposed = true;
      cleanup?.();
    },
    leaveWarning: () =>
      store?.saveState === "error" ? "Some of your changes are not saved yet because VeoClone can't be reached. If you leave now, they will be lost." : null,
  };
}

function build(ctx: PageContext, id: string, project: ProjectMeta, calib: CalibInfo, ai: Float32Array, initial: Edits) {
  const n = Math.max(1, Math.floor(calib.frameCount));
  const fps = calib.fps;
  const fpsValue = fps.num / fps.den;
  const cov = calib.coverage;
  const maxFov = maxFovOf(cov);
  // The AI path holds world poses for match.json's rig tilt/roll (0 for
  // iPhones); the view uses the editor's "Straighten picture" (rigtilt.ts).
  const aiRig = buildRig(calib);
  // match.json's own level: 0/0 for iPhones, a GoPro's from its accelerometer.
  // The default straightening, and what Reset goes back to.
  const matchStraighten = straightenOfMatch(calib.match);
  const cameraLevel = matchStraighten.tiltDeg !== 0 || matchStraighten.rollDeg !== 0;
  let rig: Rig = buildRig(calib, straightenRadians(initial.straighten));
  const store = new EditStore(ai, calib, initial, (e) => api.putEdits(id, e));
  const disposers: (() => void)[] = [];
  const listen = <K extends keyof WindowEventMap>(target: Window, type: K, fn: (e: WindowEventMap[K]) => void) => {
    target.addEventListener(type, fn);
    disposers.push(() => target.removeEventListener(type, fn));
  };

  // State.
  let disposedFlag = false;
  let frame = 0; // playhead
  let shownFrame = 0; // frame the video is showing
  let livePose: Pose | null = null; // while dragging / zooming
  let selected: number | null = null;
  let picked: "fix" | "text" = "fix"; // what Delete removes: the last one picked
  let cutStart: number | null = null;
  let skipCuts = true;
  let wantFrame = 0;
  let pendingSeek = false;
  let textureFresh = false;
  let ovDirty = true;
  let lastOverview = 0;
  let videoReady = false;
  let hintDone = false; // the user has moved the camera once
  let textShown = ""; // what the text canvas shows
  let peek: LookSide | null = null; // "Look left / centre / right": preview only

  // ---------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------
  const camCanvas = h("canvas", {
    class: "camera-canvas",
    "aria-label": "Camera view: what your video will look like. Drag or scroll here to move or zoom the camera at this moment (adds a fix). The Zoom slider changes the whole video.",
  });
  const badge = h("div", { class: "view-badge" });
  const viewerMsg = h("div", { class: "viewer-msg" }, h("div", { class: "spinner", "aria-hidden": "true" }), h("p", null, "Loading the preview…"));
  const hint = h("div", { class: "viewer-hint" }, "Drag or scroll to fix the camera here · Whole video: Zoom slider");
  // Text boxes, drawn by the same function as the export (DESIGN.md 5.4).
  const textCanvas = h("canvas", { class: "text-canvas", "aria-hidden": "true", "data-testid": "text-canvas" });
  // Thin level lines over the picture while a Straighten slider moves.
  const guides = h("div", { class: "level-guides", "aria-hidden": "true", "data-testid": "level-guides" }, [1, 2, 3, 4].map(() => h("span", null)));
  const viewerBox = h("div", { class: "viewer-box", "data-testid": "camera-view" }, camCanvas, textCanvas, guides, badge, hint, viewerMsg);
  const video = h("video", { class: "proxy-video", preload: "auto", playsInline: true, crossOrigin: "anonymous", "aria-hidden": "true" });

  const ovCanvas = h("canvas", { class: "overview-canvas" });
  const ovOverlay = h("canvas", { class: "overview-overlay", "aria-label": "Whole pitch. Click or drag to point the camera there.", "data-testid": "overview" });
  const ovBox = h("div", { class: "overview-box" }, ovCanvas, ovOverlay);

  const timeLabel = h("span", { class: "time-label", "aria-live": "off" });
  const playBtn = iconButton(I.play, "Play (Space)", () => void togglePlay(), "btn-play");
  const speed = h(
    "select",
    {
      class: "input input-small",
      "aria-label": "Playback speed",
      onChange: () => {
        video.playbackRate = Number(speed.value);
        speed.blur(); // so Space and the arrow keys go back to playing and stepping
      },
    },
    [0.25, 0.5, 1, 2, 4].map((s) => h("option", { value: String(s), selected: s === 1 }, `${s}×`)),
  );
  const muteBtn = iconButton(I.volume, "Sound on/off", () => {
    video.muted = !video.muted;
    setChildren(muteBtn, icon(video.muted ? I.mute : I.volume, 20));
  });
  const startBtn = button("Set start here", () => trim("start"), { icon: I.start, title: "The video starts at the playhead" });
  const endBtn = button("Set end here", () => trim("end"), { icon: I.end, title: "The video ends at the playhead" });
  const cutBtn = button("Cut out a section", () => markCut(), { icon: I.scissors, title: "Remove a part, for example half-time" });
  const cutCancel = button("Cancel cut", () => {
    cutStart = null;
    updateCutUi();
  }, { variant: "ghost" });
  const fixBtn = button("Add fix", () => addFixHere(), { icon: I.pin, title: "Keep the camera exactly as it is now at this moment (K)" });

  const transport = h(
    "div",
    { class: "transport", role: "toolbar", "aria-label": "Playback and trimming" },
    h(
      "div",
      { class: "transport-group" },
      iconButton(I.back5, "Back 5 seconds (Shift+Left)", () => step(-5 * fpsValue)),
      iconButton(I.frameBack, "Back 1 frame (Left)", () => step(-1)),
      playBtn,
      iconButton(I.frameForward, "Forward 1 frame (Right)", () => step(1)),
      iconButton(I.forward5, "Forward 5 seconds (Shift+Right)", () => step(5 * fpsValue)),
      timeLabel,
      speed,
      muteBtn,
    ),
    h("div", { class: "transport-group" }, startBtn, endBtn, cutBtn, cutCancel, fixBtn),
  );

  const timelineHost = h("div", { class: "timeline-host", "data-testid": "timeline" });
  const skipBox = h("input", {
    type: "checkbox",
    checked: true,
    onChange: () => {
      skipCuts = skipBox.checked;
      skipBox.blur();
    },
  });
  const timeline = new Timeline(timelineHost, {
    seek: (f) => {
      pause();
      seek(f);
    },
    selectKeyframe: (f) => {
      pause();
      selected = f;
      picked = "fix";
      seek(f);
      renderSide();
    },
    selectOverlay: (overlayId, f) => {
      pause();
      seek(f);
      textPanel.select(overlayId, false);
    },
  });
  const timelineWrap = h(
    "div",
    { class: "timeline-wrap" },
    h(
      "div",
      { class: "timeline-head" },
      h(
        "div",
        { class: "legend" },
        h("span", { class: "legend-kept" }, "Kept"),
        h("span", { class: "legend-cut" }, "Cut out"),
        h("span", { class: "legend-fix" }, "Your fixes"),
        h("span", { class: "legend-text" }, "Text"),
        h("span", { class: "legend-curve" }, "Camera left/right"),
      ),
      h("label", { class: "check small" }, skipBox, "Skip cut parts when playing"),
      h(
        "div",
        { class: "zoom-btns" },
        iconButton(I.zoomOut, "Zoom out the timeline", () => timeline.zoom(0.5)),
        iconButton(I.zoomIn, "Zoom in the timeline (Ctrl + mouse wheel)", () => timeline.zoom(2)),
        iconButton(I.fit, "Show the whole match", () => {
          timeline.fit();
          timeline.draw();
        }),
      ),
    ),
    timelineHost,
  );

  // Sidebar.
  const textPanel = new TextPanel(store, {
    frameCount: n,
    fps,
    playhead: () => frame,
    goTo: (f) => {
      pause();
      seek(f);
    },
    selectionChanged: (textId) => {
      if (textId) picked = "text";
      requestDraw();
    },
  });
  const sliders = h("div", { class: "sliders" });
  const straightenBox = h("div", { class: "sliders" });
  const lookRow = h("div", { class: "look-row", role: "group", "aria-label": "Point the preview across the pitch" });
  const straightenHint = h("div", { class: "straighten-hint-host" });
  const fixList = h("div", { class: "fix-list" });
  const trimInfo = h("div", { class: "trim-info" });
  const notes = h("div", { class: "editor-notes" });
  const side = h(
    "aside",
    { class: "editor-side", "aria-label": "Editing tools" },
    notes,
    straightenHint,
    h(
      "section",
      { class: "side-section" },
      h("h2", null, "Whole pitch"),
      h("p", { class: "muted small" }, "The blue box is what the camera sees. Click or drag to point it elsewhere."),
      ovBox,
      h("div", { class: "overview-legend" }, h("span", { class: "ov-box" }, "Camera"), h("span", { class: "ov-ai" }, "Where the AI looks"), h("span", { class: "ov-fix" }, "Your fixes")),
    ),
    h(
      "section",
      { class: "side-section" },
      h("h2", null, "Camera"),
      sliders,
      h(
        "p",
        { class: "small muted style-line" },
        `Camera style: ${STYLES.find((s) => s.id === project.style)?.name ?? project.style} · `,
        h("a", { href: `#/project/${id}` }, "Change (runs the AI again)"),
      ),
      h(
        "p",
        { class: "small muted" },
        "Picture looks bent, or the two halves don't join? ",
        h(
          "a",
          {
            href: `#/project/${id}`,
            onClick: (e: MouseEvent) => {
              e.preventDefault();
              void fixLens();
            },
          },
          "Change phone or lens",
        ),
      ),
    ),
    h(
      "section",
      { class: "side-section straighten", id: "straighten-section", "data-testid": "straighten" },
      h("h2", null, icon(I.level, 20), "Straighten picture"),
      h(
        "p",
        { class: "muted small" },
        "Phones pointed down make the picture lean when the camera turns. Move these until the far side of the pitch looks level when the camera looks left, centre and right. Goal posts and flag poles should stand straight up.",
      ),
      cameraLevel
        ? h("p", { class: "small camera-level", "data-testid": "camera-level" }, `Your cameras measured their own level (tilt ${fmtTilt(matchStraighten.tiltDeg)}, level ${fmtLevel(matchStraighten.rollDeg)}); Reset goes back to it.`)
        : null,
      lookRow,
      straightenBox,
      h("p", { class: "muted small" }, "Tip for next time: keep the phones as level as possible: tilt them down only as much as the pitch needs, and not to one side."),
    ),
    h("section", { class: "side-section" }, h("h2", null, "Your fixes"), fixList),
    h("section", { class: "side-section" }, h("h2", null, "Trim"), trimInfo),
    textPanel.el,
    h(
      "details",
      { class: "side-section shortcuts" },
      h("summary", null, icon(I.keyboard, 18), "Keyboard shortcuts"),
      h(
        "dl",
        null,
        [
          ["Space", "Play / pause"],
          ["← →", "1 frame back / forward"],
          ["Shift + ← →", "5 seconds back / forward"],
          ["K", "Add a fix with the current view"],
          ["Delete", "Remove the selected fix or text"],
          ["Ctrl + Z", "Undo"],
          ["Ctrl + Y", "Redo"],
        ].map(([k, v]) => [h("dt", null, h("kbd", null, k)), h("dd", null, v)]),
      ),
    ),
  );

  const editor = h(
    "div",
    { class: "editor" },
    h("div", { class: "stage" }, h("div", { class: "viewer" }, viewerBox)),
    side,
    transport,
    timelineWrap,
    video,
  );
  setChildren(ctx.root, editor);

  // App bar: name, save state, undo/redo, export.
  const saveLabel = h("span", { class: "save-state", "aria-live": "polite", "data-testid": "save-state" });
  const undoBtn = iconButton(I.undo, "Undo (Ctrl+Z)", () => undo());
  const redoBtn = iconButton(I.redo, "Redo (Ctrl+Y)", () => redo());
  const exportBtn = button("Export", () => exportPanel.open(), { variant: "primary", icon: I.export, class: "export-btn" });
  ctx.slot.append(
    h("a", { class: "btn btn-icon btn-ghost", href: "#/", title: "Your matches", "aria-label": "Back to your matches" }, icon(I.back, 20)),
    editableTitle(project.name, async (name) => void (await api.updateProject(id, { name })), "span"),
    saveLabel,
    h("div", { class: "slot-spacer" }),
    undoBtn,
    redoBtn,
    exportBtn,
  );
  ctx.setTitle(project.name);

  // ---------------------------------------------------------------------
  // Renderers
  // ---------------------------------------------------------------------
  let camR: CameraViewRenderer;
  let ovR: OverviewRenderer;
  try {
    camR = new CameraViewRenderer(camCanvas, calib, rig.tilt);
    ovR = new OverviewRenderer(ovCanvas, calib, rig.tilt);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const friendly = msg.startsWith("This browser") ? msg : "The video preview could not start in this browser.";
    setChildren(ctx.root, h("div", { class: "page" }, errorBox(friendly, msg === friendly ? undefined : msg, h("a", { class: "btn btn-ghost", href: "#/" }, "Back to your matches"))));
    ctx.slot.replaceChildren();
    video.remove();
    store.dispose();
    return { store, dispose: () => undefined };
  }
  const fitOverviewBox = () => {
    const ex = ovR.extent;
    ovBox.style.aspectRatio = String(Math.min(4, Math.max(1.5, (ex.yawMax - ex.yawMin) / (ex.pitchMax - ex.pitchMin))));
  };
  fitOverviewBox();
  const yawRange = globalYawRange(cov);

  const exportPanel = new ExportPanel(id, store, calib, () => watch.refresh());

  // ---------------------------------------------------------------------
  // Video
  // ---------------------------------------------------------------------
  const hasRvfc = "requestVideoFrameCallback" in HTMLVideoElement.prototype;
  const onVideoFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
    if (disposedFlag) return;
    presented(timeToFrame(meta.mediaTime, fps, n));
    video.requestVideoFrameCallback(onVideoFrame);
  };
  let rafId = 0;
  const rafLoop = () => {
    // Fallback for browsers without requestVideoFrameCallback.
    if (disposedFlag) return;
    if (!video.paused) presented(timeToFrame(video.currentTime, fps, n));
    rafId = requestAnimationFrame(rafLoop);
  };

  function presented(f: number) {
    shownFrame = f;
    if (!video.paused) {
      frame = f;
      if (skipCuts && !isKept(store.edits.segments, f)) {
        const next = nextKept(store.edits.segments, f);
        if (next === null) {
          pause();
          seek(lastKept());
        } else seek(next);
      }
    } else if (!video.seeking && !pendingSeek) {
      // A frame shown just after pausing: the playhead follows the picture,
      // so trims and fixes land on the frame on screen.
      frame = wantFrame = f;
    }
    camR.updateVideoFrame(video);
    textureFresh = true;
    if (!videoReady) {
      videoReady = true;
      viewerMsg.hidden = true;
    }
    draw();
  }

  video.addEventListener("loadeddata", () => seek(frame));
  video.addEventListener("seeked", () => {
    if (pendingSeek) {
      pendingSeek = false;
      if (timeToFrame(video.currentTime, fps, n) !== wantFrame) video.currentTime = frameToTime(wantFrame + 0.25, fps);
    }
    // requestVideoFrameCallback normally reports the new frame; this makes
    // sure a paused seek always shows up.
    presented(timeToFrame(video.currentTime, fps, n));
  });
  video.addEventListener("play", () => updatePlayButton());
  video.addEventListener("pause", () => updatePlayButton());
  video.addEventListener("error", () => {
    const err = video.error;
    // A failed download also reports "not supported", so blame the browser
    // only when it really can't play the preview (H.264, High profile).
    const unplayable =
      err?.code === MediaError.MEDIA_ERR_DECODE ||
      (err?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED && video.canPlayType('video/mp4; codecs="avc1.640028"') === "");
    viewerMsg.hidden = false;
    setChildren(
      viewerMsg,
      errorBox(
        unplayable
          ? "This browser can't play the preview video. Please use the latest Google Chrome or Microsoft Edge."
          : "The preview video could not be loaded. Make sure VeoClone is still running on your PC.",
        err ? `Video error ${err.code}: ${err.message}` : undefined,
        button("Try again", () => {
          setChildren(viewerMsg, h("div", { class: "spinner" }), h("p", null, "Loading the preview…"));
          videoReady = false; // the first frame hides the message again
          video.load();
        }, { variant: "primary" }),
      ),
    );
  });
  if (hasRvfc) video.requestVideoFrameCallback(onVideoFrame);
  else rafId = requestAnimationFrame(rafLoop);
  video.src = helperUrl(calib.proxy.url);

  function seek(f: number) {
    f = Math.min(Math.max(Math.round(f), 0), n - 1);
    if (f !== frame) endPeek();
    frame = f;
    wantFrame = f;
    if (video.readyState >= 1) {
      if (video.seeking) pendingSeek = true;
      else video.currentTime = frameToTime(f + 0.25, fps);
    }
    requestDraw();
  }

  function step(frames: number) {
    pause();
    seek(frame + Math.round(frames));
  }

  function pause() {
    if (!video.paused) video.pause();
  }

  function lastKept(): number {
    const segs = store.edits.segments;
    return segs.length ? segs[segs.length - 1].end - 1 : n - 1;
  }

  async function togglePlay() {
    if (!video.paused) return pause();
    endPeek();
    if (frame >= n - 1 || (skipCuts && frame >= lastKept())) seek(store.edits.segments[0]?.start ?? 0);
    else if (skipCuts && !isKept(store.edits.segments, frame)) seek(nextKept(store.edits.segments, frame) ?? frame);
    try {
      await video.play();
    } catch (e) {
      if ((e as DOMException)?.name !== "AbortError") toast("The video could not play. Try again in a moment.", "error");
    }
  }

  function updatePlayButton() {
    const playing = !video.paused;
    setChildren(playBtn, icon(playing ? I.pause : I.play, 22));
    playBtn.title = playing ? "Pause (Space)" : "Play (Space)";
    playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
  }

  // ---------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------
  let drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      draw();
    });
  }

  /** The camera's pose at the frame shown (a world pose for the current straightening). */
  const pathPose = (): Pose => poseAt(store.finalPath, shownFrame);
  const currentPose = (): Pose => livePose ?? (peek ? lookAcross(peek, pathPose(), rig, cov, ASPECT) : pathPose());

  function draw() {
    if (disposedFlag) return;
    const pose = currentPose();
    camR.render(pose);
    const now = performance.now();
    if (textureFresh && (video.paused || now - lastOverview > 150)) {
      ovR.updateVideoFrame(video);
      textureFresh = false;
      lastOverview = now;
      ovDirty = true;
    }
    if (ovDirty) {
      ovR.render();
      ovDirty = false;
    }
    drawPitchOverlay(pose);
    drawText();
    textPanel.playheadMoved(frame);
    updateBadge();
    timeline.setModel({ frameCount: n, fps, frame, edits: store.edits, finalPath: store.finalPath, yawRange, selected, selectedText: textPanel.selected, cutStart });
    timeLabel.textContent = `${formatFrameTime(frame, fps)} / ${formatFrameTime(n, fps)}`;
  }

  function sizeCanvas(c: HTMLCanvasElement): [CanvasRenderingContext2D, number, number] {
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const hh = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hh * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hh * dpr);
    }
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return [g, w, hh];
  }

  /** The text boxes on screen at the frame shown, at the canvas's real pixel size. */
  function drawText() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(textCanvas.clientWidth * dpr);
    const hh = Math.round(textCanvas.clientHeight * dpr);
    const shown = store.edits.overlays.filter((o) => o.text.trim() && shownFrame >= o.start && shownFrame < o.end);
    // The hint would sit on top of text at the bottom.
    hint.classList.toggle("hidden", hintDone || shown.length > 0);
    const key = JSON.stringify([w, hh, shown]);
    if (key === textShown) return;
    textShown = key;
    textCanvas.width = w; // also clears it
    textCanvas.height = hh;
    const g = textCanvas.getContext("2d");
    if (g) for (const o of shown) drawOverlay(g, o, w, hh);
  }

  function drawPitchOverlay(pose: Pose) {
    const [g, w, hh] = sizeCanvas(ovOverlay);
    g.clearRect(0, 0, w, hh);
    // The overview maps render yaw/pitch (level when straightened); aims and
    // the view's edges go through overviewPointOf.
    const toCanvas = (aim: { yaw: number; pitch: number }) => {
      const o = overviewPointOf(yawPitchToDirection(aim.yaw, aim.pitch, rig), rig);
      return ovR.yawPitchToCanvas(o.yaw, o.pitch);
    };
    const pts = frustumOutline(pose, rig, ASPECT, 12).map((p) => ovR.yawPitchToCanvas(p.yaw, p.pitch));
    const path = new Path2D();
    pts.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)));
    path.closePath();
    // Dim everything outside the camera's view.
    const dim = new Path2D();
    dim.rect(0, 0, w, hh);
    dim.addPath(path);
    g.fillStyle = "rgba(4, 7, 11, 0.5)";
    g.fill(dim, "evenodd");
    g.strokeStyle = "#38bdf8";
    g.lineWidth = 2;
    g.stroke(path);
    // Where the AI wanted to look.
    const f = shownFrame;
    if (ai.length >= (f + 1) * 3) {
      const a = toCanvas(aimOfWorld({ yaw: ai[f * 3], pitch: ai[f * 3 + 1] }, aiRig, aiRig.tilt));
      g.strokeStyle = "rgba(255,255,255,0.85)";
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(a.x, a.y, 4, 0, Math.PI * 2);
      g.stroke();
    }
    // Fixes near the playhead.
    const reach = (store.edits.holdSeconds + store.edits.fadeSeconds) * fpsValue;
    for (const k of store.edits.keyframes) {
      if (Math.abs(k.frame - f) > reach) continue;
      const p = toCanvas(k);
      const r = k.frame === selected ? 6 : 4.5;
      g.fillStyle = "#fbbf24";
      g.beginPath();
      g.moveTo(p.x, p.y - r);
      g.lineTo(p.x + r, p.y);
      g.lineTo(p.x, p.y + r);
      g.lineTo(p.x - r, p.y);
      g.closePath();
      g.fill();
    }
  }

  /** Is the camera at this frame the AI's, a fix, or easing between them? */
  function influence(f: number): "ai" | "fix" | "fade" {
    const ks = store.edits.keyframes;
    if (!ks.length) return "ai";
    const hold = store.edits.holdSeconds * fpsValue;
    const fade = store.edits.fadeSeconds * fpsValue;
    const join = store.edits.joinSeconds * fpsValue;
    let d = Infinity;
    for (let i = 0; i < ks.length; i++) {
      d = Math.min(d, Math.abs(ks[i].frame - f));
      const next = ks[i + 1];
      if (next && ks[i].frame <= f && f <= next.frame && next.frame - ks[i].frame <= join) return "fix";
    }
    return d <= hold ? "fix" : d <= hold + fade ? "fade" : "ai";
  }

  function updateBadge() {
    if (livePose) {
      badge.className = "view-badge badge-live";
      badge.textContent = "Moving the camera…";
      return;
    }
    if (peek) {
      badge.className = "view-badge badge-live";
      badge.textContent = `Looking ${peek === "centre" ? "at the centre" : peek} · preview only`;
      return;
    }
    const kind = influence(frame);
    badge.className = `view-badge badge-${kind}`;
    badge.textContent = kind === "ai" ? "AI camera" : kind === "fix" ? "Your fix" : "Easing back to the AI";
  }

  // ---------------------------------------------------------------------
  // Camera fixes
  // ---------------------------------------------------------------------
  const clampView = (p: Pose): Pose => clampPose({ ...p, fov: Math.min(Math.max(p.fov, MIN_FOV), maxFov) }, cov, ASPECT);

  function commitLive() {
    if (!livePose) return;
    const pose = livePose;
    const f = frame;
    const viewRig = rig;
    store.change((e) => {
      e.keyframes = upsertKeyframe(e.keyframes, keyframeFromView(pose, f, e.zoom, viewRig));
    });
    store.recompute.flush();
    livePose = null;
    selected = f;
    picked = "fix";
    hintDone = true;
    renderSide();
    requestDraw();
  }
  const commitWheel = debounce(commitLive, 450);

  function addFixHere() {
    pause();
    endPeek();
    if (livePose) return commitLive();
    livePose = poseAt(store.finalPath, frame);
    commitLive();
    toast("Fix added: the camera keeps this view here.", "success", 2500);
  }

  function removeFix(f: number) {
    store.change((e) => {
      e.keyframes = e.keyframes.filter((k) => k.frame !== f);
    });
    if (selected === f) selected = null;
    renderSide();
  }

  let drag: { x: number; y: number; pose: Pose; moved: boolean; id: number } | null = null;
  viewerBox.addEventListener("pointerdown", (e) => {
    // Never capture clicks meant for the loading / error message and its buttons.
    if (e.button !== 0 || !videoReady || !viewerMsg.hidden) return;
    pause();
    commitWheel.flush();
    const start = currentPose();
    endPeek();
    drag = { x: e.clientX, y: e.clientY, pose: start, moved: false, id: e.pointerId };
    viewerBox.setPointerCapture(e.pointerId);
    viewerBox.classList.add("grabbing");
  });
  viewerBox.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    // Grab-and-drag like a map: dragging right shows what is further left.
    // Moves in render yaw/pitch, so a sideways drag pans level when straightened.
    const k = (drag.pose.fov * DEG) / Math.max(1, viewerBox.clientHeight);
    const r0 = worldToRenderPose(drag.pose, rig, rig.tilt);
    const w = renderToWorldPose({ yaw: r0.yaw + dx * k, pitch: r0.pitch + dy * k }, rig, rig.tilt);
    livePose = clampView({ ...w, fov: drag.pose.fov });
    requestDraw();
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    viewerBox.classList.remove("grabbing");
    if (moved) commitLive();
  };
  viewerBox.addEventListener("pointerup", endDrag);
  viewerBox.addEventListener("pointercancel", endDrag);
  viewerBox.addEventListener(
    "wheel",
    (e) => {
      if (!videoReady) return;
      e.preventDefault();
      pause();
      const base = currentPose();
      endPeek();
      const delta = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
      livePose = clampView({ ...base, fov: base.fov * Math.exp(delta * 0.0012) });
      requestDraw();
      commitWheel();
    },
    { passive: false },
  );

  let aiming: number | null = null;
  const aim = (e: PointerEvent) => {
    const r = ovOverlay.getBoundingClientRect();
    // An overview point is a render yaw/pitch: the view centred there.
    const yp = renderToWorldPose(ovR.canvasToYawPitch(e.clientX - r.left, e.clientY - r.top), rig, rig.tilt);
    const fov = (livePose ?? currentPose()).fov;
    endPeek();
    livePose = clampView({ yaw: yp.yaw, pitch: yp.pitch, fov });
    requestDraw();
  };
  ovOverlay.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !videoReady) return;
    pause();
    commitWheel.flush();
    aiming = e.pointerId;
    ovOverlay.setPointerCapture(e.pointerId);
    aim(e);
  });
  ovOverlay.addEventListener("pointermove", (e) => {
    if (aiming === e.pointerId) aim(e);
  });
  const endAim = (e: PointerEvent) => {
    if (aiming !== e.pointerId) return;
    aiming = null;
    commitLive();
  };
  ovOverlay.addEventListener("pointerup", endAim);
  ovOverlay.addEventListener("pointercancel", endAim);

  // ---------------------------------------------------------------------
  // Trims
  // ---------------------------------------------------------------------
  function trim(kind: "start" | "end") {
    const segs = kind === "start" ? setStart(store.edits.segments, frame) : setEnd(store.edits.segments, frame);
    if (!segs) {
      toast(kind === "start" ? "The start must be before the end of the video." : "The end must be after the start of the video.", "error");
      return;
    }
    store.change((e) => (e.segments = segs));
    toast(kind === "start" ? `Your video now starts at ${formatFrameTime(frame, fps)}.` : `Your video now ends at ${formatFrameTime(frame, fps)}.`, "success", 2500);
  }

  function markCut() {
    if (cutStart === null) {
      pause();
      cutStart = frame;
      updateCutUi();
      toast("Now move to where the cut should end and press “Cut to here”.", "info", 5000);
      return;
    }
    const segs = cutOut(store.edits.segments, cutStart, frame);
    if (!segs) {
      toast("That would cut out the whole video.", "error");
      return;
    }
    if (cutStart === frame) {
      toast("Move the playhead to where the cut should end first.", "info");
      return;
    }
    const [a, b] = [Math.min(cutStart, frame), Math.max(cutStart, frame)];
    store.change((e) => (e.segments = segs));
    cutStart = null;
    updateCutUi();
    toast(`Cut out ${formatFrameTime(a, fps)} to ${formatFrameTime(b, fps)}.`, "success", 2500);
  }

  function updateCutUi() {
    cutBtn.querySelector("span")!.textContent = cutStart === null ? "Cut out a section" : "Cut to here";
    cutBtn.className = `btn ${cutStart === null ? "btn-secondary" : "btn-primary"}`;
    cutCancel.hidden = cutStart === null;
    requestDraw();
  }

  // ---------------------------------------------------------------------
  // Sidebar
  // ---------------------------------------------------------------------
  type SliderDef = { key: "zoom" | "smoothSeconds" | "holdSeconds"; label: string; min: number; max: number; step: number; ends: [string, string]; fmt: (v: number) => string; help: string };
  const SLIDERS: SliderDef[] = [
    { key: "zoom", label: "Zoom", min: 0.5, max: 2, step: 0.05, ends: ["Wider", "Closer"], fmt: (v) => `${Math.round(v * 100)}%`, help: "Makes the whole video wider or closer." },
    { key: "smoothSeconds", label: "Smoothness", min: 0, max: 5, step: 0.25, ends: ["Lively", "Very smooth"], fmt: (v) => (v === 0 ? "Off" : `${v} s`), help: "Calms down quick camera moves." },
    { key: "holdSeconds", label: "How long a fix lasts", min: 0.5, max: 10, step: 0.5, ends: ["Short", "Long"], fmt: (v) => `${v} s`, help: "How long the camera stays where you put it before going back to the AI." },
  ];
  const sliderEls = SLIDERS.map((d) => {
    const out = h("output", { class: "slider-value" });
    const input = h("input", {
      type: "range",
      min: d.min,
      max: d.max,
      step: d.step,
      "aria-label": d.label,
      "data-testid": `slider-${d.key}`,
      onInput: () => {
        const v = Number(input.value);
        out.textContent = d.fmt(v);
        store.change((e) => (e[d.key] = v), d.key);
      },
      onChange: () => input.blur(), // the arrow keys step through the video again
    });
    sliders.append(
      h(
        "div",
        { class: "slider" },
        h("div", { class: "slider-top", title: d.help }, h("label", null, d.label), out),
        input,
        h("div", { class: "slider-ends muted small" }, h("span", null, d.ends[0]), h("span", null, d.ends[1])),
      ),
    );
    return { d, input, out };
  });

  // ---------------------------------------------------------------------
  // Straighten picture (DESIGN.md 5.5)
  // ---------------------------------------------------------------------
  /** Point the renderers, picking and new fixes at the edits' straightening. */
  function syncStraighten() {
    const { tilt, roll } = straightenRadians(store.edits.straighten);
    if (tilt === rig.tilt.tilt && roll === rig.tilt.roll) return;
    rig = withRigTilt(rig, tilt, roll);
    camR.setRigTilt(tilt, roll);
    ovR.setRigTilt(tilt, roll);
    ovDirty = true;
    refitOverview();
    renderStraightenHint();
  }
  // Fitting the overview to the turned picture samples it; not on every slider step.
  const refitOverview = debounce(() => {
    if (disposedFlag) return;
    ovR.refit();
    fitOverviewBox();
    ovDirty = true;
    requestDraw();
  }, 200);

  let guidesTimer = 0;
  function showGuides() {
    guides.classList.add("shown");
    clearTimeout(guidesTimer);
    guidesTimer = window.setTimeout(() => guides.classList.remove("shown"), 1500);
  }

  type StraightenDef = { key: keyof Straighten; label: string; ends: [string, string]; fmt: (v: number) => string; help: string };
  const STRAIGHTEN: StraightenDef[] = [
    {
      key: "tiltDeg",
      label: "Tilt",
      ends: ["Phones pointed up", "Phones pointed down"],
      fmt: fmtTilt,
      help: "How much the phones pointed down. Look left or right and move this until the far side is level.",
    },
    {
      key: "rollDeg",
      label: "Level",
      ends: ["Left side down", "Right side down"],
      fmt: fmtLevel,
      help: "Turns the picture if it leans left or right even when the camera looks at the centre.",
    },
  ];
  const straightenEls = STRAIGHTEN.map((d) => {
    const [min, max] = STRAIGHTEN_LIMITS[d.key];
    const out = h("output", { class: "slider-value" });
    const set = (v: number) => {
      store.change((e) => (e.straighten = { ...e.straighten, [d.key]: v }), `straighten-${d.key}`);
      dismissStraightenHint();
    };
    const input = h("input", {
      type: "range",
      min,
      max,
      step: 0.5,
      "aria-label": d.label,
      "data-testid": `straighten-${d.key}`,
      onInput: () => {
        const v = Number(input.value);
        out.textContent = d.fmt(v);
        pause();
        showGuides();
        set(v);
      },
      onPointerdown: () => showGuides(),
      onChange: () => input.blur(),
    });
    const home = matchStraighten[d.key];
    const reset = iconButton(
      I.refresh,
      cameraLevel ? `Reset ${d.label.toLowerCase()} to the camera's own level (${d.fmt(home)})` : `Reset ${d.label.toLowerCase()}`,
      () => {
        if (store.edits.straighten[d.key] === home) return;
        showGuides();
        set(home);
      },
      "btn-ghost btn-small",
    );
    reset.dataset.testid = `reset-${d.key}`;
    straightenBox.append(
      h(
        "div",
        { class: "slider" },
        h("div", { class: "slider-top", title: d.help }, h("label", null, d.label), out, reset),
        input,
        h("div", { class: "slider-ends muted small" }, h("span", null, d.ends[0]), h("span", null, d.ends[1])),
      ),
    );
    return { d, input, out, reset };
  });

  const LOOKS: [LookSide, string][] = [
    ["left", "Look left"],
    ["centre", "Look centre"],
    ["right", "Look right"],
  ];
  const lookBtns = LOOKS.map(([side, label]) => {
    const b = button(label, () => {
      pause();
      livePose = null;
      peek = peek === side ? null : side;
      renderLooks();
      requestDraw();
    }, { class: "btn-small", title: `Point the preview at the ${side === "centre" ? "middle" : `${side} edge`} of the pitch now. Not saved as a fix.` });
    b.dataset.testid = `look-${side}`;
    return { side, b };
  });
  lookRow.append(...lookBtns.map((x) => x.b));
  function renderLooks() {
    for (const { side, b } of lookBtns) {
      b.setAttribute("aria-pressed", String(peek === side));
      b.classList.toggle("btn-primary", peek === side);
      b.classList.toggle("btn-secondary", peek !== side);
    }
  }
  function endPeek() {
    if (peek === null) return;
    peek = null;
    renderLooks();
    requestDraw();
  }
  renderLooks();

  // One-time hint for matches whose cameras recorded no level (iPhones) and
  // that are not straightened yet (remembered in this browser).
  const HINT_KEY = "veoclone.hint.straighten";
  const hintDismissed = () => {
    try {
      return localStorage.getItem(HINT_KEY) === "dismissed";
    } catch {
      return false;
    }
  };
  function dismissStraightenHint() {
    try {
      localStorage.setItem(HINT_KEY, "dismissed");
    } catch {
      // Private mode: hidden until the editor opens again.
    }
    setChildren(straightenHint);
  }
  function renderStraightenHint() {
    const s = store.edits.straighten;
    if (cameraLevel || s.tiltDeg !== 0 || s.rollDeg !== 0 || hintDismissed()) return setChildren(straightenHint);
    if (straightenHint.firstChild) return;
    const box = notice(
      "info",
      "Picture leaning when the camera turns? Use Straighten picture.",
      button("Straighten picture", () => {
        const section = document.getElementById("straighten-section");
        section?.scrollIntoView({ behavior: "smooth", block: "start" });
        straightenEls[0].input.focus({ preventScroll: true });
        peek = "left";
        renderLooks();
        requestDraw();
        dismissStraightenHint();
      }, { variant: "secondary", class: "btn-small", icon: I.level }),
    );
    box.dataset.testid = "straighten-hint";
    box.append(iconButton(I.x, "Hide this tip", () => dismissStraightenHint(), "btn-ghost btn-small"));
    setChildren(straightenHint, box);
  }

  function renderSide() {
    for (const { d, input, out } of sliderEls) {
      const v = store.edits[d.key];
      if (document.activeElement !== input) input.value = String(v);
      out.textContent = d.fmt(v);
    }
    for (const { d, input, out, reset } of straightenEls) {
      const v = store.edits.straighten[d.key];
      if (document.activeElement !== input) input.value = String(v);
      out.textContent = d.fmt(v);
      reset.disabled = v === matchStraighten[d.key];
    }

    const ks = store.edits.keyframes;
    setChildren(
      fixList,
      ks.length === 0
        ? h("p", { class: "muted small empty-small" }, "No fixes yet. If the camera looks at the wrong place, drag the picture or click the whole pitch to point it where you want. That adds a fix at the playhead.")
        : h(
            "ul",
            { class: "fixes" },
            ks.map((k) =>
              h(
                "li",
                { class: k.frame === selected ? "selected" : "" },
                h(
                  "button",
                  {
                    type: "button",
                    class: "fix-go",
                    onClick: () => {
                      pause();
                      selected = k.frame;
                      picked = "fix";
                      seek(k.frame);
                      renderSide();
                    },
                  },
                  h("span", { class: "fix-dot" }),
                  h("span", null, formatFrameTime(k.frame, fps)),
                  h("span", { class: "muted small" }, k.frame === selected ? "selected" : "camera fixed"),
                ),
                iconButton(I.trash, `Remove the fix at ${formatFrameTime(k.frame, fps)}`, () => removeFix(k.frame), "btn-ghost btn-small"),
              ),
            ),
          ),
      h(
        "div",
        { class: "row" },
        button("Add fix here", () => addFixHere(), { icon: I.pin, class: "btn-small" }),
        ks.length
          ? button("Remove all", () => {
              store.change((e) => (e.keyframes = []));
              selected = null;
              renderSide();
            }, { variant: "ghost", class: "btn-small" })
          : null,
      ),
    );

    const kept = keptFrameCount(store.edits);
    const cuts = cutParts(store.edits.segments, n);
    setChildren(
      trimInfo,
      h("p", null, "Your video: ", h("strong", { "data-testid": "kept-length" }, formatDuration(frameToTime(kept, fps))), ` of ${formatDuration(frameToTime(n, fps))}`),
      cuts.length
        ? h(
            "ul",
            { class: "cuts" },
            cuts.map((c) =>
              h(
                "li",
                null,
                h(
                  "span",
                  null,
                  c.start === 0 ? `Before ${formatFrameTime(c.end, fps)}` : c.end === n ? `After ${formatFrameTime(c.start, fps)}` : `${formatFrameTime(c.start, fps)} – ${formatFrameTime(c.end, fps)}`,
                  h("span", { class: "muted small" }, " cut out"),
                ),
                button("Put back", () => store.change((e) => (e.segments = keep(e.segments, c.start, c.end))), { variant: "ghost", class: "btn-small" }),
              ),
            ),
          )
        : h("p", { class: "muted small" }, "Nothing is cut. Use “Set start here”, “Set end here” and “Cut out a section” below the picture."),
      cuts.length ? button("Keep everything", () => store.change((e) => (e.segments = [{ start: 0, end: n }])), { variant: "ghost", class: "btn-small" }) : null,
    );

    textPanel.render();
    undoBtn.disabled = !store.canUndo;
    redoBtn.disabled = !store.canRedo;
  }

  function undo() {
    if (store.undo()) {
      livePose = null;
      endPeek();
      if (selected !== null && !store.edits.keyframes.some((k) => k.frame === selected)) selected = null;
      toast("Undone.", "info", 1500);
    }
  }
  function redo() {
    if (store.redo()) toast("Redone.", "info", 1500);
  }

  // ---------------------------------------------------------------------
  // Save state, exports
  // ---------------------------------------------------------------------
  const saveText: Record<SaveState, string> = {
    saved: "All changes saved",
    pending: "Saving…",
    saving: "Saving…",
    error: "Not saved – VeoClone can't be reached. Retrying…",
  };
  disposers.push(
    store.onSave((s) => {
      saveLabel.textContent = saveText[s];
      saveLabel.className = `save-state save-${s}`;
    }),
  );
  disposers.push(
    store.onChange(() => {
      syncStraighten();
      renderSide();
      requestDraw();
    }),
  );

  function updateExportButton(p: ProjectMeta) {
    const running = p.exports.find((e) => e.status === "running" || e.status === "queued");
    exportBtn.querySelector("span")!.textContent = running ? `Making video ${Math.round(running.progress * 100)}%` : "Export";
    exportBtn.classList.toggle("busy", !!running);
  }
  const watch = watchProject(
    id,
    (p) => {
      latest = p;
      exportPanel.update(p);
      updateExportButton(p);
      renderNotes(p);
    },
    () => undefined,
  );

  // ---------------------------------------------------------------------
  // Warnings from processing (HDR, poor line-up, a re-run that failed…)
  // ---------------------------------------------------------------------
  const hiddenKey = `veoclone.hiddenNotes.${id}`;
  function renderNotes(p: ProjectMeta) {
    const key = JSON.stringify(p.warnings);
    let hidden = null;
    try {
      hidden = localStorage.getItem(hiddenKey);
    } catch {
      // Private mode: show them.
    }
    if (!p.warnings.length || hidden === key) return setChildren(notes);
    if (notes.dataset.key === key && notes.firstChild) return;
    notes.dataset.key = key;
    const box = notice("warning", "Good to know", h("ul", { class: "warn-list" }, p.warnings.map((w) => h("li", null, w))));
    box.dataset.testid = "editor-warnings";
    box.append(
      iconButton(I.x, "Hide these notes", () => {
        try {
          localStorage.setItem(hiddenKey, key);
        } catch {
          // Private mode: hidden until the editor opens again.
        }
        setChildren(notes);
      }, "btn-ghost btn-small"),
    );
    setChildren(notes, box);
  }
  let latest = project;
  renderNotes(project);

  async function fixLens() {
    pause();
    if (await changeLens(latest)) location.hash = `#/project/${id}`;
  }

  // ---------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------
  listen(window, "keydown", (e) => {
    if (document.querySelector("dialog[open]")) return;
    const t = e.target as HTMLElement;
    // Sliders and tick boxes don't take typing: the shortcuts win over them.
    const typing = t.closest("textarea, [contenteditable], select, input:not([type=range]):not([type=checkbox]):not([type=radio])") !== null;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && (e.key === "z" || e.key === "Z") && !typing) {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (ctrl && (e.key === "y" || e.key === "Y") && !typing) {
      e.preventDefault();
      redo();
      return;
    }
    if (typing || ctrl || e.altKey) return;
    switch (e.key) {
      case " ":
        e.preventDefault();
        void togglePlay();
        break;
      case "ArrowLeft":
      case "ArrowRight": {
        e.preventDefault();
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        step(e.shiftKey ? dir * 5 * fpsValue : dir);
        break;
      }
      case "Home":
        e.preventDefault();
        step(-n);
        break;
      case "End":
        e.preventDefault();
        step(n);
        break;
      case "k":
      case "K":
        e.preventDefault();
        addFixHere();
        break;
      case "Delete":
      case "Backspace":
        if (picked === "text" && textPanel.selected) {
          e.preventDefault();
          textPanel.deleteSelected();
        } else if (selected !== null) {
          e.preventDefault();
          removeFix(selected);
        }
        break;
      case "Escape":
        if (cutStart !== null) {
          cutStart = null;
          updateCutUi();
        }
        endPeek();
        break;
    }
  });
  listen(window, "beforeunload", (e) => {
    if (store.hasUnsaved) {
      void store.save();
      e.preventDefault();
    }
  });

  const resize = new ResizeObserver(() => {
    ovDirty = true;
    requestDraw();
  });
  resize.observe(viewerBox);
  resize.observe(ovBox);

  updateCutUi();
  updatePlayButton();
  renderSide();
  renderStraightenHint();
  requestDraw();

  return {
    store,
    dispose() {
      disposedFlag = true;
      commitWheel.flush();
      cancelAnimationFrame(rafId);
      watch.stop();
      resize.disconnect();
      for (const d of disposers) d();
      store.dispose();
      video.pause();
      video.removeAttribute("src");
      video.load();
      camR.dispose();
      ovR.dispose();
      // Free the two WebGL contexts now rather than when the browser gets round to it.
      for (const c of [camCanvas, ovCanvas]) c.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
      timeline.dispose();
      exportPanel.dispose();
      refitOverview.cancel();
      clearTimeout(guidesTimer);
    },
  };
}
