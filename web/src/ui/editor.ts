// The editor (#/edit/:id): camera view with the whole-pitch map, transport
// and timeline, and a rail of tools (camera, fixes, straighten, pitch, text,
// trim, tips) that each show their own panel; autosave and export.
import { aiUsesWidestView, api, helperUrl, quickRerun, rerunTime, watchProject, widestViewOf, type ProjectMeta, type WidestView } from "../api";
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
  overviewPointOfAim,
  poseAt,
  renderToWorldPose,
  STRAIGHTEN_LIMITS,
  straightenOfMatch,
  straightenRadians,
  timeToFrame,
  widestViewMaxFov,
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
import { button, confirmDialog, describeError, errorBox, iconButton, notice, progressBar, rangeFill, setProgress, toast } from "./common";
import { debounce, formatDuration, h, icon, setChildren, type Child } from "./dom";
import { EditStore, upsertKeyframe, type SaveState } from "./editStore";
import { ExportPanel } from "./exportPanel";
import { I } from "./icons";
import { changeLens } from "./lens";
import type { Page, PageContext } from "./page";
import { STYLES, WIDEST, WIDEST_HELP, widestPicker } from "./newMatch";
import { aiReportButton } from "./aiReport";
import { AI_REPORT_HELP, ballWords } from "./ballWords";
import { markPitchDialog } from "./pitchTool";
import { editableTitle, returnToEditorAfterRun } from "./project";
import { cutOut, cutParts, isKept, keep, nextKept, setEnd, setStart } from "./segments";
import { TextPanel } from "./textPanel";
import { LANES, Timeline, TIMELINE_HEIGHT } from "./timeline";

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
  // "Widest view" (DESIGN.md 4.12): no frame of the final path is wider.
  const store = new EditStore(ai, calib, initial, (e) => api.putEdits(id, e), widestViewMaxFov(project.widestView));
  const disposers: (() => void)[] = [];
  const listen = <K extends keyof WindowEventMap>(target: Window, type: K, fn: (e: WindowEventMap[K]) => void) => {
    target.addEventListener(type, fn);
    disposers.push(() => target.removeEventListener(type, fn));
  };

  // State.
  let latest = project; // the match as VeoClone last reported it
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
  let textShown = ""; // what the text canvas shows
  let peek: LookSide | null = null; // "Look left / centre / right": preview only

  // ---------------------------------------------------------------------
  // Layout
  //   app bar: back · name · undo/redo · saved ……… VeoClone status · Export
  //   tool rail | tool panel | camera view (whole-pitch map in its corner)
  //             |            | transport · timeline
  // ---------------------------------------------------------------------
  const camCanvas = h("canvas", {
    class: "camera-canvas",
    "aria-label": "Camera view: what your video will look like. Drag or scroll here to move or zoom the camera at this moment (adds a fix). The Zoom slider changes the whole video.",
  });
  const badge = h("div", { class: "view-badge" });
  const viewerMsg = h("div", { class: "viewer-msg" }, h("div", { class: "spinner", "aria-hidden": "true" }), h("p", null, "Loading the preview…"));
  // Text boxes, drawn by the same function as the export (DESIGN.md 5.4).
  const textCanvas = h("canvas", { class: "text-canvas", "aria-hidden": "true", "data-testid": "text-canvas" });
  // Thin level lines over the picture while a Straighten slider moves.
  const guides = h("div", { class: "level-guides", "aria-hidden": "true", "data-testid": "level-guides" }, [1, 2, 3, 4].map(() => h("span", null)));
  const viewerBox = h("div", { class: "viewer-box", "data-testid": "camera-view" }, camCanvas, textCanvas, guides, badge, viewerMsg);
  const video = h("video", { class: "proxy-video", preload: "auto", playsInline: true, crossOrigin: "anonymous", "aria-hidden": "true" });

  // The whole pitch: a small map in the corner of the picture. Bigger on
  // request, or put away (remembered in this browser).
  const legend = () =>
    h(
      "div",
      { class: "overview-legend" },
      h("span", { class: "ov-box" }, "Camera"),
      h("span", { class: "ov-ai" }, "Where the AI looks"),
      h("span", { class: "ov-fix" }, "Your fixes"),
      h("span", { class: "ov-pitch" }, "Pitch outline"),
    );
  const ovCanvas = h("canvas", { class: "overview-canvas" });
  const ovOverlay = h("canvas", { class: "overview-overlay", "aria-label": "Whole pitch. Click or drag to point the camera there.", "data-testid": "overview" });
  const ovBox = h("div", { class: "overview-box" }, ovCanvas, ovOverlay);
  type MapSize = "small" | "big" | "hidden";
  const MAP_KEY = "veoclone.map";
  let mapSize: MapSize = "small";
  try {
    const saved = localStorage.getItem(MAP_KEY);
    if (saved === "big" || saved === "hidden") mapSize = saved;
  } catch {
    // Private mode: the small map.
  }
  const mapSizeBtn = iconButton(I.maximize, "Make the whole-pitch map bigger", () => setMap(mapSize === "big" ? "small" : "big"), "btn-ghost btn-xs");
  const mapCard = h(
    "div",
    { class: "minimap", "data-size": mapSize },
    h(
      "div",
      { class: "minimap-head" },
      h("span", { class: "minimap-title" }, "Whole pitch"),
      h("span", { class: "minimap-help" }, "Click to aim"),
      mapSizeBtn,
      iconButton(I.x, "Hide the whole-pitch map", () => setMap("hidden"), "btn-ghost btn-xs"),
    ),
    ovBox,
    legend(),
  );
  const mapShow = button("Whole pitch", () => setMap("small"), { icon: I.map, class: "minimap-show btn-small", title: "Show the whole-pitch map" });
  const viewerFrame = h("div", { class: "viewer-frame" }, viewerBox, mapCard, mapShow);
  function setMap(size: MapSize) {
    mapSize = size;
    try {
      localStorage.setItem(MAP_KEY, size);
    } catch {
      // Private mode: until the editor opens again.
    }
    mapCard.dataset.size = size;
    mapCard.hidden = size === "hidden";
    mapShow.hidden = size !== "hidden";
    const label = size === "big" ? "Make the whole-pitch map smaller" : "Make the whole-pitch map bigger";
    setChildren(mapSizeBtn, icon(size === "big" ? I.minimize : I.maximize, 16));
    mapSizeBtn.title = label;
    mapSizeBtn.setAttribute("aria-label", label);
    ovDirty = true;
    requestDraw();
  }

  // Transport: time, speed and sound · play and steps · timeline zoom.
  const timeNow = h("span", { class: "time-now" });
  const timeTotal = h("span", { class: "time-total" });
  const timeLabel = h("span", { class: "time-label", "aria-live": "off" }, timeNow, timeTotal);
  const playBtn = iconButton(I.play, "Play (Space)", () => void togglePlay(), "btn-play");
  const speed = h(
    "select",
    {
      class: "input input-small",
      "aria-label": "Playback speed",
      title: "Playback speed",
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
  const transport = h(
    "div",
    { class: "transport", role: "toolbar", "aria-label": "Playback" },
    h("div", { class: "transport-side" }, timeLabel, speed, muteBtn),
    h(
      "div",
      { class: "transport-main" },
      iconButton(I.back5, "Back 5 seconds (Shift+Left)", () => step(-5 * fpsValue)),
      iconButton(I.frameBack, "Back 1 frame (Left)", () => step(-1)),
      playBtn,
      iconButton(I.frameForward, "Forward 1 frame (Right)", () => step(1)),
      iconButton(I.forward5, "Forward 5 seconds (Shift+Right)", () => step(5 * fpsValue)),
    ),
    h(
      "div",
      { class: "transport-side transport-end" },
      iconButton(I.zoomOut, "Zoom out the timeline", () => timeline.zoom(0.5)),
      iconButton(I.zoomIn, "Zoom in the timeline (Ctrl + mouse wheel)", () => timeline.zoom(2)),
      iconButton(I.fit, "Show the whole match", () => {
        timeline.fit();
        timeline.draw();
      }),
    ),
  );

  // Timeline: lanes (labelled on the left) under a time ruler.
  const timelineHost = h("div", { class: "timeline-host", "data-testid": "timeline", style: `height:${TIMELINE_HEIGHT}px` });
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
      showTool("fixes");
    },
    selectOverlay: (overlayId, f) => {
      pause();
      seek(f);
      textPanel.select(overlayId, false);
      showTool("text");
    },
  });
  const laneLabel = (cls: string, iconPaths: string, label: string, title: string, height: number) =>
    h("span", { class: `lane-label ${cls}`, title, style: `height:${height}px` }, icon(iconPaths, 14), label);
  const timelineWrap = h(
    "div",
    { class: "timeline-wrap" },
    h(
      "div",
      { class: "lane-labels", "aria-hidden": "true", style: `padding-top:${LANES.ruler + LANES.gap}px; gap:${LANES.gap}px` },
      laneLabel("lane-video", I.film, "Video", "Kept parts, cut parts (striped) and the camera moving left and right", LANES.video),
      laneLabel("lane-fixes", I.fix, "Fixes", "Your camera fixes, and how long each one lasts", LANES.fixes),
      laneLabel("lane-text", I.type, "Text", "When each text is on screen", LANES.text),
    ),
    timelineHost,
  );

  // ---------------------------------------------------------------------
  // Tools: the rail on the left picks the panel shown next to it.
  // ---------------------------------------------------------------------
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
  const cameraSliders = h("div", { class: "sliders" });
  const fixSliders = h("div", { class: "sliders" });
  const straightenBox = h("div", { class: "sliders" });
  const lookRow = h("div", { class: "seg seg-buttons look-row", role: "group", "aria-label": "Point the preview across the pitch" });
  const straightenHint = h("div", { class: "tip-host" });
  const pitchHint = h("div", { class: "tip-host" });
  const naturalHint = h("div", { class: "tip-host" });
  const ballHint = h("div", { class: "tip-host" });
  const notes = h("div", { class: "tip-host editor-notes" });
  const widestHost = h("div", { class: "widest-host" });
  const widestNote = h("div", { class: "widest-note", "aria-live": "polite", "data-testid": "widest-note" });
  const ballHost = h("div", { class: "ball-words", "data-testid": "ball-words" });
  const pitchRow = h("div", { class: "pitch-row-side", "data-testid": "pitch-status" });
  const fixList = h("div", { class: "fix-list" });
  const keptInfo = h("div", { class: "kept-info" });
  const cutList = h("div", { class: "cut-list" });

  const startBtn = button("Set start here", () => trim("start"), { icon: I.start, title: "The video starts at the playhead" });
  const endBtn = button("Set end here", () => trim("end"), { icon: I.end, title: "The video ends at the playhead" });
  const cutBtn = button("Cut out a section", () => markCut(), { icon: I.scissors, title: "Remove a part, for example half-time" });
  const cutCancel = button("Cancel cut", () => {
    cutStart = null;
    updateCutUi();
  }, { variant: "ghost" });
  const skipBox = h("input", {
    type: "checkbox",
    checked: true,
    onChange: () => {
      skipCuts = skipBox.checked;
      skipBox.blur();
    },
  });

  /** A titled group of controls inside a tool panel. */
  const group = (title: string | null, ...body: Child[]) => h("div", { class: "tool-group" }, title ? h("h3", { class: "group-title" }, title) : null, body);

  // Tips: anything VeoClone noticed, one-time tips, the keyboard shortcuts.
  const tipHosts = [notes, ballHint, naturalHint, pitchHint, straightenHint];
  const tipsBadge = h("span", { class: "rail-badge", "aria-hidden": "true" });
  const tipsEmpty = h(
    "div",
    { class: "tips-empty" },
    h("span", { class: "tips-empty-icon" }, icon(I.checkCircle, 22)),
    h("div", null, h("strong", null, "You're all set"), h("p", { class: "muted small" }, "Tips, and anything VeoClone noticed about this match, show up here.")),
  );
  const shortcuts = h(
    "dl",
    { class: "shortcuts" },
    [
      ["Space", "Play / pause"],
      ["← →", "1 frame back / forward"],
      ["Shift + ← →", "5 seconds back / forward"],
      ["K", "Add a fix with the current view"],
      ["Delete", "Remove the selected fix or text"],
      ["Ctrl + Z", "Undo"],
      ["Ctrl + Y", "Redo"],
    ].map(([k, v]) => [h("dt", null, h("kbd", null, k)), h("dd", null, v)]),
  );

  type ToolId = "camera" | "fixes" | "straighten" | "pitch" | "text" | "trim" | "tips";
  const tools: { id: ToolId; label: string; icon: string; title: string; intro: string | null; body: Child[]; attrs?: Record<string, string> }[] = [
    {
      id: "camera",
      label: "Camera",
      icon: I.video,
      title: "Camera",
      intro: "How the AI camera films the whole video.",
      body: [
        group(null, cameraSliders),
        group(
          null,
          h(
            "p",
            { class: "style-line" },
            `Camera style: ${STYLES.find((s) => s.id === project.style)?.name ?? project.style} · `,
            h("a", { href: `#/project/${id}` }, "Change (runs the AI again)"),
          ),
          ballHost,
          h("p", { class: "muted small" }, AI_REPORT_HELP),
          aiReportButton(() => latest),
        ),
        group(
          null,
          h("div", { class: "widest", "data-testid": "widest-view" }, h("h3", { class: "group-title" }, "Widest view"), h("p", { class: "muted small" }, WIDEST_HELP), widestHost, widestNote),
        ),
        group(
          null,
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
      ],
    },
    {
      id: "fixes",
      label: "Fixes",
      icon: I.fix,
      title: "Camera fixes",
      intro: "Camera looking at the wrong place? Drag the picture, scroll on it, or click the whole-pitch map. That adds a fix: the camera keeps your view around that moment, then eases back to the AI.",
      body: [
        group(null, button("Add fix here", () => addFixHere(), { icon: I.fix, class: "btn-block", title: "Keep the camera exactly as it is now at this moment (K)" }), fixList),
        group(null, fixSliders),
      ],
    },
    {
      id: "straighten",
      label: "Straighten",
      icon: I.level,
      title: "Straighten picture",
      intro: "Phones pointed down make the picture lean when the camera turns. Move these until the far side of the pitch looks level when the camera looks left, centre and right. Goal posts and flag poles should stand straight up.",
      attrs: { "data-testid": "straighten" },
      body: [
        cameraLevel
          ? h("p", { class: "small camera-level", "data-testid": "camera-level" }, `Your cameras measured their own level (tilt ${fmtTilt(matchStraighten.tiltDeg)}, level ${fmtLevel(matchStraighten.rollDeg)}); Reset goes back to it.`)
          : null,
        group("Look across the pitch", lookRow),
        group(null, straightenBox),
        h("p", { class: "muted small tool-foot" }, "Tip for next time: keep the phones as level as possible: tilt them down only as much as the pitch needs, and not to one side."),
      ],
    },
    {
      id: "pitch",
      label: "Pitch",
      icon: I.pitch,
      title: "Mark the pitch",
      intro: "Click round the pitch so the AI camera ignores everyone outside it: substitutes, parents on the touchline or a game on the next pitch.",
      body: [
        group(null, pitchRow),
        group(
          "Whole-pitch map",
          h("p", { class: "muted small" }, "The map in the corner of the picture shows the whole pitch. Click or drag in it to point the camera there; that adds a fix."),
          legend(),
        ),
      ],
    },
    { id: "text", label: "Text", icon: I.type, title: "Text", intro: "Team names, the date, a player's name or your own words, shown on your video.", body: [textPanel.el] },
    {
      id: "trim",
      label: "Trim",
      icon: I.scissors,
      title: "Trim and cut",
      intro: "Move the playhead on the timeline, then choose where your video starts and ends, or cut out a part such as half-time.",
      body: [
        group(null, keptInfo, h("div", { class: "trim-actions" }, startBtn, endBtn, cutBtn, cutCancel)),
        group("Cut out", cutList),
        group(null, h("label", { class: "check" }, skipBox, "Skip cut parts when playing")),
      ],
    },
    { id: "tips", label: "Tips", icon: I.tips, title: "Tips", intro: null, body: [tipsEmpty, ...tipHosts, group("Keyboard shortcuts", shortcuts)] },
  ];

  const tabs = tools.map((t) => {
    const btn = h(
      "button",
      {
        type: "button",
        role: "tab",
        id: `tab-${t.id}`,
        class: "rail-tab",
        "aria-controls": `tool-${t.id}`,
        "aria-selected": "false",
        title: t.title,
        tabIndex: -1,
        onClick: () => showTool(t.id),
      },
      icon(t.icon, 20),
      h("span", { class: "rail-label" }, t.label),
      t.id === "tips" ? tipsBadge : null,
    );
    const panel = h(
      "section",
      { class: "tool-panel", id: `tool-${t.id}`, role: "tabpanel", "aria-labelledby": `tab-${t.id}`, ...t.attrs },
      h("header", { class: "tool-head" }, h("h2", null, t.title), t.intro ? h("p", { class: "tool-intro" }, t.intro) : null),
      h("div", { class: "tool-body" }, t.body),
    );
    panel.hidden = true;
    return { id: t.id, btn, panel };
  });
  const rail = h(
    "div",
    {
      class: "rail",
      role: "tablist",
      "aria-label": "Tools",
      "aria-orientation": "vertical",
      onKeydown: (e: KeyboardEvent) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const i = tabs.findIndex((t) => t.id === currentTool);
        showTool(tabs[(i + (e.key === "ArrowDown" ? 1 : tabs.length - 1)) % tabs.length].id, true);
      },
    },
    tabs.slice(0, -1).map((t) => t.btn),
    h("span", { class: "rail-spacer" }),
    tabs[tabs.length - 1].btn,
  );
  let currentTool: ToolId = "camera";
  function showTool(tool: ToolId, focus = false) {
    currentTool = tool;
    for (const t of tabs) {
      const on = t.id === tool;
      t.btn.setAttribute("aria-selected", String(on));
      t.btn.tabIndex = on ? 0 : -1;
      t.panel.hidden = !on;
      if (on && focus) t.btn.focus();
    }
  }
  function updateTips() {
    const count = tipHosts.filter((x) => x.firstChild).length;
    tipsBadge.textContent = String(count);
    tipsBadge.hidden = count === 0;
    tipsEmpty.hidden = count > 0;
  }
  const tipsObserver = new MutationObserver(updateTips);
  for (const x of tipHosts) tipsObserver.observe(x, { childList: true });

  const editor = h(
    "div",
    { class: "editor" },
    h("aside", { class: "editor-side", "aria-label": "Editing tools" }, rail, h("div", { class: "tool-panels" }, tabs.map((t) => t.panel))),
    h(
      "div",
      { class: "editor-main" },
      h("div", { class: "stage" }, h("div", { class: "viewer" }, viewerFrame)),
      h("div", { class: "editor-bottom" }, transport, timelineWrap),
    ),
    video,
  );
  setChildren(ctx.root, editor);

  // App bar: back, name, undo/redo, save state; Export after VeoClone's status.
  const saveLabel = h("span", { class: "save-state", "aria-live": "polite", "data-testid": "save-state" });
  const undoBtn = iconButton(I.undo, "Undo (Ctrl+Z)", () => undo());
  const redoBtn = iconButton(I.redo, "Redo (Ctrl+Y)", () => redo());
  const exportBtn = button("Export", () => exportPanel.open(), { variant: "primary", icon: I.export, class: "export-btn" });
  ctx.slot.append(
    h("a", { class: "btn btn-icon btn-ghost", href: "#/", title: "Your matches", "aria-label": "Back to your matches" }, icon(I.back, 20)),
    editableTitle(project.name, async (name) => void (await api.updateProject(id, { name })), "span"),
    h("span", { class: "appbar-divider", "aria-hidden": "true" }),
    undoBtn,
    redoBtn,
    saveLabel,
  );
  ctx.actions.append(exportBtn);
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
    ctx.actions.replaceChildren();
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
    setChildren(playBtn, icon(playing ? I.pause : I.play, 20));
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
    timeNow.textContent = formatFrameTime(frame, fps);
    timeTotal.textContent = ` / ${formatFrameTime(n, fps)}`;
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
    g.fillStyle = "rgba(17, 18, 20, 0.45)";
    g.fill(dim, "evenodd");
    g.strokeStyle = "#c2f24a";
    g.lineWidth = 2;
    g.stroke(path);
    // The pitch outline (stored as aims, so it follows the straightening).
    const outline = latest.pitch?.points ?? [];
    if (outline.length >= 3) {
      g.save();
      g.setLineDash([5, 4]);
      g.strokeStyle = "rgba(255, 255, 255, 0.9)";
      g.lineWidth = 1.5;
      g.beginPath();
      outline.forEach(([yaw, pitch], i) => {
        const o = overviewPointOfAim({ yaw, pitch }, rig);
        const c = ovR.yawPitchToCanvas(o.yaw, o.pitch);
        if (i) g.lineTo(c.x, c.y);
        else g.moveTo(c.x, c.y);
      });
      g.closePath();
      g.stroke();
      g.restore();
    }
    // Where the AI wanted to look.
    const f = shownFrame;
    const ai = store.aiPath;
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
      const sel = k.frame === selected;
      const r = sel ? 6 : 4.5;
      g.fillStyle = sel ? "#c2f24a" : "#111214";
      g.strokeStyle = sel ? "#111214" : "#ffffff";
      g.lineWidth = 1.25;
      g.beginPath();
      g.moveTo(p.x, p.y - r);
      g.lineTo(p.x + r, p.y);
      g.lineTo(p.x, p.y + r);
      g.lineTo(p.x - r, p.y);
      g.closePath();
      g.fill();
      g.stroke();
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
  const clampView = (p: Pose): Pose => clampPose({ ...p, fov: Math.min(Math.max(p.fov, MIN_FOV), maxFov, store.maxFovDeg) }, cov, ASPECT);

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
    cutBtn.className = `btn ${cutStart === null ? "btn-secondary" : "btn-primary"} cut-btn`;
    cutCancel.hidden = cutStart === null;
    requestDraw();
  }

  // ---------------------------------------------------------------------
  // Sidebar
  // ---------------------------------------------------------------------
  type SliderDef = {
    key: "zoom" | "smoothSeconds" | "holdSeconds";
    label: string;
    min: number;
    max: number;
    step: number;
    ends: [string, string];
    fmt: (v: number) => string;
    help: string;
    host: HTMLElement;
  };
  const SLIDERS: SliderDef[] = [
    { key: "zoom", label: "Zoom", min: 0.5, max: 2, step: 0.05, ends: ["Wider", "Closer"], fmt: (v) => `${Math.round(v * 100)}%`, help: "Makes the whole video wider or closer.", host: cameraSliders },
    { key: "smoothSeconds", label: "Smoothness", min: 0, max: 5, step: 0.25, ends: ["Lively", "Very smooth"], fmt: (v) => (v === 0 ? "Off" : `${v} s`), help: "Calms down quick camera moves.", host: cameraSliders },
    {
      key: "holdSeconds",
      label: "How long a fix lasts",
      min: 0.5,
      max: 10,
      step: 0.5,
      ends: ["Short", "Long"],
      fmt: (v) => `${v} s`,
      help: "How long the camera stays where you put it before going back to the AI.",
      host: fixSliders,
    },
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
        rangeFill(input);
        store.change((e) => (e[d.key] = v), d.key);
      },
      onChange: () => input.blur(), // the arrow keys step through the video again
    });
    d.host.append(
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
        rangeFill(input);
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
    const b = h(
      "button",
      {
        type: "button",
        class: "seg-btn",
        "data-testid": `look-${side}`,
        title: `Point the preview at the ${side === "centre" ? "middle" : `${side} edge`} of the pitch now. Not saved as a fix.`,
        onClick: () => {
          pause();
          livePose = null;
          peek = peek === side ? null : side;
          renderLooks();
          requestDraw();
        },
      },
      label,
    );
    return { side, b };
  });
  lookRow.append(...lookBtns.map((x) => x.b));
  function renderLooks() {
    for (const { side, b } of lookBtns) b.setAttribute("aria-pressed", String(peek === side));
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
        showTool("straighten");
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
      rangeFill(input);
    }
    for (const { d, input, out, reset } of straightenEls) {
      const v = store.edits.straighten[d.key];
      if (document.activeElement !== input) input.value = String(v);
      out.textContent = d.fmt(v);
      rangeFill(input);
      reset.disabled = v === matchStraighten[d.key];
    }

    const ks = store.edits.keyframes;
    setChildren(
      fixList,
      ks.length === 0
        ? h("p", { class: "empty-small" }, "No fixes yet. The AI camera films the whole match.")
        : [
            h(
              "ul",
              { class: "item-list fixes" },
              ks.map((k) =>
                h(
                  "li",
                  { class: k.frame === selected ? "selected" : "" },
                  h(
                    "button",
                    {
                      type: "button",
                      class: "item-go fix-go",
                      onClick: () => {
                        pause();
                        selected = k.frame;
                        picked = "fix";
                        seek(k.frame);
                        renderSide();
                      },
                    },
                    h("span", { class: "fix-dot" }),
                    h("span", { class: "item-time" }, formatFrameTime(k.frame, fps)),
                    h("span", { class: "muted small" }, k.frame === selected ? "selected" : "camera fixed"),
                  ),
                  iconButton(I.trash, `Remove the fix at ${formatFrameTime(k.frame, fps)}`, () => removeFix(k.frame), "btn-ghost btn-small"),
                ),
              ),
            ),
            h(
              "div",
              { class: "list-foot" },
              h("span", { class: "muted small" }, ks.length === 1 ? "1 fix" : `${ks.length} fixes`),
              button("Remove all", () => {
                store.change((e) => (e.keyframes = []));
                selected = null;
                renderSide();
              }, { variant: "ghost", class: "btn-small" }),
            ),
          ],
    );

    const kept = keptFrameCount(store.edits);
    const cuts = cutParts(store.edits.segments, n);
    setChildren(
      keptInfo,
      h("span", { class: "kept-label" }, "Your video"),
      h("span", { class: "kept-value" }, h("strong", { "data-testid": "kept-length" }, formatDuration(frameToTime(kept, fps))), h("span", { class: "muted" }, ` of ${formatDuration(frameToTime(n, fps))}`)),
    );
    setChildren(
      cutList,
      cuts.length
        ? [
            h(
              "ul",
              { class: "item-list cuts" },
              cuts.map((c) =>
                h(
                  "li",
                  null,
                  h(
                    "span",
                    { class: "item-go" },
                    h("span", { class: "cut-dot", "aria-hidden": "true" }),
                    h(
                      "span",
                      { class: "item-time" },
                      c.start === 0 ? `Before ${formatFrameTime(c.end, fps)}` : c.end === n ? `After ${formatFrameTime(c.start, fps)}` : `${formatFrameTime(c.start, fps)} – ${formatFrameTime(c.end, fps)}`,
                    ),
                    h("span", { class: "muted small" }, " cut out"),
                  ),
                  button("Put back", () => store.change((e) => (e.segments = keep(e.segments, c.start, c.end))), { variant: "ghost", class: "btn-small" }),
                ),
              ),
            ),
            h("div", { class: "list-foot" }, h("span"), button("Keep everything", () => store.change((e) => (e.segments = [{ start: 0, end: n }])), { variant: "ghost", class: "btn-small" })),
          ]
        : h("p", { class: "empty-small" }, "Nothing is cut out yet."),
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
      const pitchChanged = JSON.stringify([p.pitch, p.aiRun, p.aiSeen]) !== JSON.stringify([latest.pitch, latest.aiRun, latest.aiSeen]);
      latest = p;
      exportPanel.update(p);
      updateExportButton(p);
      renderNotes(p);
      renderBall(p);
      syncWidest(p);
      if (pitchChanged) {
        renderPitch();
        requestDraw();
      }
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
  renderNotes(project);

  // How often the AI saw the ball (DESIGN.md 4.13).
  function renderBall(p: ProjectMeta) {
    const words = ballWords(p.aiRun);
    const key = JSON.stringify(words);
    if (ballHost.dataset.key === key) return;
    ballHost.dataset.key = key;
    setChildren(
      ballHost,
      words.length ? words.map((w) => h("p", { class: "small" }, w)) : h("p", { class: "muted small" }, "Run the AI again to see how often it saw the ball."),
    );
  }
  renderBall(project);

  // ---------------------------------------------------------------------
  // Mark the pitch (DESIGN.md 4.8)
  // ---------------------------------------------------------------------
  const pitchHintKey = `veoclone.hint.pitch.${id}`;
  const pitchHintDismissed = () => {
    try {
      return localStorage.getItem(pitchHintKey) === "dismissed";
    } catch {
      return false;
    }
  };
  function dismissPitchHint() {
    try {
      localStorage.setItem(pitchHintKey, "dismissed");
    } catch {
      // Private mode: hidden until the editor opens again.
    }
    setChildren(pitchHint);
  }
  /** Does the AI camera path use the pitch outline as it is now? */
  const pitchInUse = () => (latest.pitch?.id ?? null) === (latest.aiRun?.pitchId ?? null);

  function renderPitch() {
    const marked = !!latest.pitch;
    const used = pitchInUse();
    // good: the AI uses the outline; off: no outline; todo: the AI must run again.
    const state = marked && used ? "good" : !marked && used ? "off" : "todo";
    setChildren(
      pitchRow,
      h(
        "p",
        { class: `status-line status-${state}` },
        h("span", { class: "status-dot", "aria-hidden": "true" }),
        !marked
          ? used
            ? "Pitch not marked: the AI looks at everyone it sees."
            : "You removed the pitch outline, but the AI camera still uses it until the AI runs again."
          : used
            ? "Pitch marked: the AI ignores everyone outside it."
            : "Pitch marked, but the AI camera doesn't use it yet: run the AI again.",
      ),
      h(
        "div",
        { class: "stack" },
        button(marked ? "Change the pitch outline" : "Mark the pitch", () => void markPitch(), { icon: I.pencil, class: "btn-block", title: "Click round the pitch so the AI camera ignores people outside it" }),
        used ? null : button("Run the AI again", () => void rerunAi(), { variant: "primary", class: "btn-block", icon: I.refresh }),
      ),
    );
    if (marked || pitchHintDismissed()) return setChildren(pitchHint);
    if (pitchHint.firstChild) return;
    const box = notice(
      "info",
      "Mark the pitch so the camera ignores people outside it.",
      h("p", { class: "small" }, "Substitutes, parents on the touchline or a game on the next pitch can pull the AI camera away from the play."),
      button("Mark the pitch", () => void markPitch(), { variant: "secondary", class: "btn-small", icon: I.pencil }),
    );
    box.dataset.testid = "pitch-hint";
    box.append(iconButton(I.x, "Hide this tip", () => dismissPitchHint(), "btn-ghost btn-small"));
    setChildren(pitchHint, box);
  }

  async function markPitch() {
    pause();
    endPeek();
    const result = await markPitchDialog({ calib, rigTilt: { tilt: rig.tilt.tilt, roll: rig.tilt.roll }, video, existing: latest.pitch ?? null });
    if (result === null || disposedFlag) return;
    try {
      latest = result === "remove" ? await api.clearPitch(id) : await api.setPitch(id, result);
    } catch (e) {
      toast(describeError(e).message, "error", 6000);
      return;
    }
    dismissPitchHint();
    renderPitch();
    showTool("pitch");
    requestDraw();
    if (pitchInUse()) return;
    const run = await confirmDialog({
      title: result === "remove" ? "Pitch outline removed" : "Pitch outline saved",
      text: [
        h("p", null, result === "remove" ? "The AI needs to run again to look at everyone again." : "The AI needs to run again to ignore the people outside the pitch."),
        h("p", { class: "small" }, rerunTime(latest), " Your trims, camera fixes and text are kept."),
      ],
      confirm: "Run the AI again",
      dismiss: "Later",
    });
    if (run) await rerunAi();
  }

  async function rerunAi() {
    pause();
    try {
      await api.process(id);
      returnToEditorAfterRun(id);
      location.hash = `#/project/${id}`;
    } catch (e) {
      toast(describeError(e).message, "error", 6000);
    }
  }

  async function fixLens() {
    pause();
    if (await changeLens(latest)) location.hash = `#/project/${id}`;
  }

  // ---------------------------------------------------------------------
  // Widest view (DESIGN.md 4.12)
  // ---------------------------------------------------------------------
  // A match setting, not an edit: it limits every frame of the final path at
  // once (store.setMaxFov), and the AI runs again (seconds, from what it saw
  // last time) so the AI camera zooms with the limit too.
  let aiMadeWith = JSON.stringify(project.aiRun ?? null); // what store.aiPath was made with
  let loadingAi = false;
  let widestRun: WidestView | null = null; // our own re-run is making this
  let ballRun = false; // our own re-run for the new Follow the ball is running
  let widestShown: WidestView | null = null;
  let widestSending = false; // saving the choice / starting the run
  const processing = (p: ProjectMeta) => p.status === "queued" || p.status === "processing" || p.job?.kind === "process";
  const widestBusy = () => widestSending || processing(latest);
  const widestName = (w: WidestView) => WIDEST.find((x) => x.id === w)?.name ?? w;

  function renderWidest() {
    const value = widestViewOf(latest);
    if (value !== widestShown) {
      widestShown = value;
      setChildren(widestHost, widestPicker(value, (w) => void changeWidest(w), "editor-widest", true));
    }
    // No other choice while the AI runs (VeoClone would refuse it).
    for (const input of widestHost.querySelectorAll("input")) input.disabled = widestBusy();
    renderWidestNote();
    renderNaturalHint();
    renderBallHint();
  }

  function renderWidestNote() {
    const p = latest;
    if (processing(p)) {
      const job = p.job?.kind === "process" ? p.job : null;
      if (!widestNote.querySelector(".progress")) {
        setChildren(widestNote, h("p", { class: "small widest-status" }), progressBar(0, "Updating the AI camera"), h("p", { class: "muted small widest-msg" }));
      }
      const what = widestRun ? `Updating the AI camera for “${widestName(widestRun)}”…` : "The AI is running again…";
      widestNote.querySelector(".widest-status")!.textContent = `${what} ${Math.round((job?.progress ?? 0) * 100)}%`;
      widestNote.querySelector(".widest-msg")!.textContent = job?.message ?? "Waiting to start";
      setProgress(widestNote.querySelector<HTMLElement>(".progress")!, job?.progress ?? 0);
      return;
    }
    if (widestSending) return setChildren(widestNote, h("p", { class: "small muted" }, "One moment…"));
    if (aiUsesWidestView(p) || loadingAi) return setChildren(widestNote);
    if (widestNote.dataset.key === JSON.stringify(p.aiRun) && widestNote.querySelector(".widest-stale")) return;
    widestNote.dataset.key = JSON.stringify(p.aiRun);
    setChildren(
      widestNote,
      h("p", { class: "small muted widest-stale" }, `The AI camera was made with “${widestName(p.aiRun?.widestView ?? "widest")}”. Your fixes and the Zoom slider already keep to “${widestName(widestViewOf(p))}”; run the AI again so the AI camera does too.`),
      button("Run the AI again", () => void runAiForWidest(), { variant: "secondary", class: "btn-small", icon: I.refresh }),
    );
  }

  /** The user picked another widest view. */
  async function changeWidest(w: WidestView) {
    pause();
    if (widestBusy()) return;
    widestSending = true;
    renderWidest();
    let p: ProjectMeta;
    try {
      p = await api.updateProject(id, { widestView: w });
    } catch (e) {
      widestSending = false;
      toast(describeError(e).message, "error", 6000);
      widestShown = null; // show what is stored again
      renderWidest();
      return;
    }
    if (disposedFlag) return;
    latest = p;
    watch.refresh(); // polls from before the change are dropped
    dismissNaturalHint();
    store.setMaxFov(widestViewMaxFov(w)); // the editor keeps to it at once
    if (aiUsesWidestView(p)) {
      widestSending = false;
      renderWidest();
      return;
    }
    await runAiForWidest(true);
  }

  /**
   * Run the AI again for the widest view: in seconds here, or the long way
   * on the match page. `sending`: called by changeWidest, which set widestSending.
   */
  async function runAiForWidest(sending = false) {
    pause();
    if (!sending) {
      if (widestBusy()) return;
      widestSending = true;
    }
    try {
      await startAiForWidest();
    } finally {
      widestSending = false;
      if (!disposedFlag) renderWidest();
    }
  }

  async function startAiForWidest() {
    if (!quickRerun(latest)) {
      const run = await confirmDialog({
        title: "Run the AI again?",
        text: [
          h("p", null, `Your fixes and the Zoom slider already keep to “${widestName(widestViewOf(latest))}”. For the AI camera to zoom with it too, the AI needs to run again.`),
          h("p", { class: "small" }, rerunTime(latest), " Your trims, camera fixes and text are kept."),
        ],
        confirm: "Run the AI again",
        dismiss: "Later",
      });
      if (run && !disposedFlag) await rerunAi();
      return;
    }
    try {
      latest = await api.process(id);
    } catch (e) {
      toast(describeError(e).message, "error", 6000);
      return;
    }
    widestRun = widestViewOf(latest);
    watch.refresh();
  }

  /** A poll: the widest view's limit, and the new AI path once a run is done. */
  function syncWidest(p: ProjectMeta) {
    store.setMaxFov(widestViewMaxFov(p.widestView));
    renderWidest();
    void refreshAiPath(p);
  }

  async function refreshAiPath(p: ProjectMeta) {
    if (processing(p) || loadingAi) return;
    if (p.status !== "ready") {
      if (widestRun || ballRun) {
        widestRun = null;
        ballRun = false;
        toast("The AI could not run again. Open the match page to see why.", "error", 8000);
      }
      return;
    }
    const key = JSON.stringify(p.aiRun ?? null);
    if (key === aiMadeWith) {
      if (widestRun || ballRun) {
        // The run ended without a new AI path (it failed or was stopped; the note at the top says why).
        widestRun = null;
        ballRun = false;
        toast("The AI camera could not be updated. Press Run the AI again to try once more.", "error", 6000);
        renderWidest();
      }
      return;
    }
    if (p.frameCount !== undefined && p.frameCount !== calib.frameCount) {
      // Made from other videos (e.g. in another tab): open the editor again.
      await store.save();
      location.reload();
      return;
    }
    loadingAi = true;
    try {
      const next = await api.aiPath(id);
      if (disposedFlag) return;
      aiMadeWith = key;
      store.setAiPath(next);
      if (widestRun) toast(`Done: the AI camera now uses “${widestName(widestRun)}”.`, "success", 3000);
      else if (ballRun) toast("Done: the camera now follows the ball the new way.", "success", 3000);
      widestRun = null;
      ballRun = false;
    } catch {
      // The next poll tries again.
    } finally {
      loadingAi = false;
      if (!disposedFlag) renderWidest();
    }
  }

  // Follow the ball made by an older VeoClone (Reco's ball mode: no ball
  // numbers): offer the new tracking brain (DESIGN.md 4.13), in seconds from
  // what the AI saw.
  const oldBallCamera = (p: ProjectMeta) => p.style === "ball" && p.aiRun?.style === "ball" && !p.aiRun.ball;
  const ballHintKey = `veoclone.hint.ballbrain.${id}`;
  const ballHintDismissed = () => {
    try {
      return localStorage.getItem(ballHintKey) === "dismissed";
    } catch {
      return false;
    }
  };
  function renderBallHint() {
    if (!oldBallCamera(latest) || ballRun || ballHintDismissed()) return setChildren(ballHint);
    if (ballHint.firstChild) return;
    const box = notice(
      "info",
      "New: Follow the ball is smarter.",
      h(
        "p",
        { class: "small" },
        "It ignores things on the grass that look like a ball but never move, keeps the players around the ball in the picture instead of looking down at the grass, and follows the players while the ball can't be seen. ",
        rerunTime(latest),
      ),
      button("Update the camera", () => void updateBallCamera(), { variant: "secondary", class: "btn-small", icon: I.sparkle }),
    );
    box.dataset.testid = "ball-hint";
    box.append(
      iconButton(I.x, "Hide this tip", () => {
        try {
          localStorage.setItem(ballHintKey, "dismissed");
        } catch {
          // Private mode: hidden until the editor opens again.
        }
        setChildren(ballHint);
      }, "btn-ghost btn-small"),
    );
    setChildren(ballHint, box);
  }

  /** Run the AI again for the new Follow the ball: in seconds here, or the long way on the match page. */
  async function updateBallCamera() {
    pause();
    if (widestBusy()) return;
    if (!quickRerun(latest)) {
      const run = await confirmDialog({
        title: "Run the AI again?",
        text: [h("p", null, "To use the new Follow the ball, the AI needs to run again."), h("p", { class: "small" }, rerunTime(latest), " Your trims, camera fixes and text are kept.")],
        confirm: "Run the AI again",
        dismiss: "Later",
      });
      if (run && !disposedFlag) await rerunAi();
      return;
    }
    showTool("camera"); // the progress shows there, under Widest view
    widestSending = true;
    renderWidest();
    try {
      latest = await api.process(id);
      ballRun = true;
      watch.refresh();
    } catch (e) {
      toast(describeError(e).message, "error", 6000);
    } finally {
      widestSending = false;
      if (!disposedFlag) renderWidest();
    }
  }

  // One-time tip for matches made before the setting existed (they keep
  // the old, widest camera until the user picks something).
  const NATURAL_HINT = "veoclone.hint.natural";
  const naturalHintDismissed = () => {
    try {
      return localStorage.getItem(NATURAL_HINT) === "dismissed";
    } catch {
      return false;
    }
  };
  function dismissNaturalHint() {
    try {
      localStorage.setItem(NATURAL_HINT, "dismissed");
    } catch {
      // Private mode: hidden until the editor opens again.
    }
    setChildren(naturalHint);
  }
  function renderNaturalHint() {
    if (latest.widestView || naturalHintDismissed()) return setChildren(naturalHint);
    if (naturalHint.firstChild) return;
    const box = notice(
      "info",
      "New: Natural look stops the camera zooming out so far that the edges stretch.",
      h("p", { class: "small" }, "Like Veo, the camera stays close to the play. You can change it any time under Camera › Widest view."),
      button("Try it", () => {
        showTool("camera");
        void changeWidest("natural");
      }, { variant: "secondary", class: "btn-small", icon: I.sparkle }),
    );
    box.dataset.testid = "natural-hint";
    box.append(iconButton(I.x, "Hide this tip", () => dismissNaturalHint(), "btn-ghost btn-small"));
    setChildren(naturalHint, box);
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
  renderPitch();
  renderStraightenHint();
  renderWidest();
  setMap(mapSize);
  updateTips();
  // Tips first while there are any (the first time a match opens), else the camera.
  showTool(tipHosts.some((x) => x.firstChild) ? "tips" : "camera");
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
      tipsObserver.disconnect();
    },
  };
}
