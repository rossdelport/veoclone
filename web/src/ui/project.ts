// Processing view (#/project/:id): steps with progress, warnings, errors,
// cancel / try again, and adding missing videos.
import { api, hasVideo, rerunTime, watchProject, widestViewOf, type AiAccuracy, type ApiError, type JobInfo, type JobStep, type ProjectMeta, type Side, type Style, type Upload, type WidestView } from "../api";
import { aiReportButton } from "./aiReport";
import { AI_REPORT_HELP, ballWords } from "./ballWords";
import { button, confirmDialog, describeError, errorBox, notice, progressBar, setProgress, toast } from "./common";
import { formatBytes, formatTimeLeft, h, icon, setChildren } from "./dom";
import { dropZone, assignFiles, type DropZone } from "./dropzone";
import { currentHealth } from "./health";
import { I } from "./icons";
import { changeLens, lensOptions, lensUnavailable, phonesPicker } from "./lens";
import { ACCURACY, accuracyPicker, sendVideos, slowAiNotice, stylePicker, STYLES, WIDEST, WIDEST_HELP, widestPicker } from "./newMatch";
import type { Page, PageContext } from "./page";

const STEPS: { step: JobStep; name: string; text: string }[] = [
  { step: "probe", name: "Check the videos", text: "Making sure both videos can be used." },
  { step: "calibrate", name: "Line up and join the videos", text: "Matching the sound and the picture of the two phones." },
  { step: "proxy", name: "Make the preview", text: "A smaller copy so the editor plays smoothly." },
  { step: "track", name: "AI ball tracking", text: "The AI watches the whole match and steers the camera. This takes the longest." },
];

/** Editable heading: click "Rename" to change the match name. */
export function editableTitle(name: string, onSave: (name: string) => Promise<void>, tag: "h1" | "span" = "h1"): HTMLElement {
  const wrap = h("div", { class: "title-edit" });
  const show = (n: string) => {
    setChildren(
      wrap,
      h(tag, { class: "title-text", title: n }, n),
      h("button", { type: "button", class: "btn btn-icon btn-ghost btn-small", title: "Rename", "aria-label": "Rename the match", onClick: edit }, icon(I.pencil, 16)),
    );
  };
  const edit = () => {
    const current = wrap.querySelector(".title-text")?.textContent ?? name;
    const input = h("input", { class: "input title-input", value: current, maxLength: 200, "aria-label": "Match name" });
    let done = false;
    const finish = async (save: boolean) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (save && next && next !== current) {
        try {
          await onSave(next);
          show(next);
          return;
        } catch (e) {
          toast(describeError(e).message, "error");
        }
      }
      show(current);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void finish(true);
      if (e.key === "Escape") void finish(false);
      e.stopPropagation();
    });
    input.addEventListener("blur", () => void finish(true));
    setChildren(wrap, input);
    input.focus();
    input.select();
  };
  show(name);
  return wrap;
}

const RETURN_KEY = "veoclone.returnToEditor";

/**
 * Called by the editor before it runs the AI again: when the run is done the
 * match page goes straight back to the editor (the editor shows the
 * warnings too).
 */
export function returnToEditorAfterRun(id: string): void {
  try {
    sessionStorage.setItem(RETURN_KEY, id);
  } catch {
    // Private mode: the user opens the editor from the match page.
  }
}

function takeReturnToEditor(id: string): boolean {
  try {
    if (sessionStorage.getItem(RETURN_KEY) !== id) return false;
    sessionStorage.removeItem(RETURN_KEY);
    return true;
  } catch {
    return false;
  }
}

export function projectPage(ctx: PageContext, id: string): Page {
  ctx.setTitle("Processing");
  const title = h("div", { class: "project-title" });
  const body = h("div", { class: "project-body", "aria-live": "polite" });
  ctx.root.append(h("div", { class: "page page-project" }, h("a", { class: "back-link", href: "#/" }, icon(I.back, 18), "Your matches"), title, body));
  setChildren(body, h("div", { class: "skeleton-card tall" }));

  let project: ProjectMeta | null = null;
  let sawWork = false; // watched it process, so open the editor when done
  const backToEditor = takeReturnToEditor(id); // the editor ran the AI again
  let lastStep: JobStep | null = null; // to show which step failed
  let openTimer = 0;
  let upload: Upload | null = null;
  let uploading = false;
  let forceSetup = false; // "Change videos or phone" after a failure
  let mode = "";
  let shown = ""; // what the page shows now (see render)
  let live: ((p: ProjectMeta) => void) | null = null; // moves the progress bar without a rebuild
  let restyleOpen = false;
  let newStyle: Style | null = null;
  let newAccuracy: AiAccuracy | null = null;
  let newWidest: WidestView | null = null;
  const stepClock = { key: "", start: 0 };

  // Re-built only when the kind of view changes, so inputs keep their state.
  let zones: Record<Side, DropZone> | null = null;

  const watch = watchProject(
    id,
    (p) => {
      const first = !project;
      if (first || p.name !== project?.name) {
        setChildren(title, editableTitle(p.name, async (n) => void (project = await api.updateProject(id, { name: n }))));
        ctx.setTitle(p.name);
      }
      if (p.status === "processing" || p.status === "queued") sawWork = true;
      if (p.job?.kind === "process") lastStep = p.job.step;
      project = p;
      render();
    },
    (e: ApiError) => {
      if (e.status === 404) {
        setChildren(body, errorBox("This match no longer exists. It may have been deleted.", undefined, h("a", { class: "btn btn-primary", href: "#/" }, "Back to your matches")));
        watch.stop();
      } else if (!project) {
        setChildren(body, errorBox(e.message, e.detail));
      }
    },
  );

  function render(force = false) {
    const p = project!;
    const working = p.status === "processing" || p.status === "queued";
    const next = uploading ? "upload" : working ? "work" : forceSetup ? "setup" : p.status;
    if (next !== mode) {
      mode = next;
      zones = null;
      restyleOpen = false;
      newStyle = null;
      newAccuracy = null;
      newWidest = null;
    }
    if (uploading) return;
    // Rebuild only when something on the page changes, so open boxes, choices
    // and the button under the mouse survive the polls; progress moves in place.
    const key = JSON.stringify([mode, p.status, p.job?.kind, p.job?.step, p.job?.startedAt, p.error, p.warnings, p.calibration, p.style, p.aiAccuracy, p.widestView, p.aiSeen, p.lensId, p.rightLensId, p.files, p.exports.map((e) => e.status), currentHealth()?.ai.provider]);
    if (key === shown && !force) return live?.(p);
    shown = key;
    live = null;
    if (working) return renderWork(p);
    if (p.status === "ready") return renderReady(p);
    if ((p.status === "failed" || p.status === "cancelled") && !forceSetup) return renderStopped(p);
    return renderSetup(p);
  }

  /** "45% · about 3 minutes left · 1,200 of 162,000 frames" */
  function progressText(job: JobInfo): string {
    const key = `${job.startedAt}/${job.step}`;
    if (stepClock.key !== key) Object.assign(stepClock, { key, start: performance.now() });
    let eta = job.etaSeconds;
    const elapsed = (performance.now() - stepClock.start) / 1000;
    // Our own guess only for steps that count frames (others move in jumps).
    if (eta === undefined && job.framesTotal && job.progress > 0.03 && elapsed > 3) eta = (elapsed / job.progress) * (1 - job.progress);
    const frames = job.framesTotal ? `${(job.framesDone ?? 0).toLocaleString()} of ${job.framesTotal.toLocaleString()} frames` : "";
    return [`${Math.round(job.progress * 100)}%`, formatTimeLeft(eta), frames].filter(Boolean).join(" · ");
  }

  function stepList(p: ProjectMeta, failed = false): HTMLElement {
    const job = p.job?.kind === "process" ? p.job : null;
    const step = job?.step ?? (failed ? lastStep : null);
    const activeIndex = step ? STEPS.findIndex((s) => s.step === step) : p.status === "ready" ? STEPS.length : -1;
    return h(
      "ol",
      { class: "steps" },
      STEPS.map((s, i) => {
        const state = i < activeIndex ? "done" : i === activeIndex ? (failed ? "failed" : "active") : "waiting";
        const text = h("span", { class: "muted small" }, state === "active" && job?.message ? job.message : s.text);
        let extra: HTMLElement | null = null;
        if (state === "active" && job) {
          const bar = progressBar(job.progress, s.name);
          const line = h("p", { class: "small muted" }, progressText(job));
          extra = h("div", { class: "step-progress" }, bar, line);
          live = (q) => {
            if (q.job?.kind !== "process") return;
            setProgress(bar, q.job.progress);
            line.textContent = progressText(q.job);
            text.textContent = q.job.message || s.text;
          };
        }
        return h(
          "li",
          { class: `step step-${state}`, "data-step": s.step },
          h("span", { class: "step-icon" }, state === "done" ? icon(I.check, 16) : state === "failed" ? icon(I.x, 16) : String(i + 1)),
          h("div", { class: "step-body" }, h("strong", null, s.name), text, extra),
        );
      }),
    );
  }

  function warnings(p: ProjectMeta): HTMLElement | null {
    if (!p.warnings.length) return null;
    return notice("warning", "Good to know", h("ul", { class: "warn-list" }, p.warnings.map((w) => h("li", null, w))));
  }

  function diskInfo(p: ProjectMeta): HTMLElement {
    const free = currentHealth()?.freeDiskBytes;
    return h("p", { class: "muted small disk-info" }, `This match uses ${formatBytes(p.diskBytes)} on your PC`, free ? ` · ${formatBytes(free)} free` : "", ".");
  }

  function renderWork(p: ProjectMeta) {
    const queued = p.status === "queued" && !p.job;
    setChildren(
      body,
      h(
        "section",
        { class: "card" },
        h(
          "div",
          { class: "card-head" },
          h(
            "div",
            null,
            h("h2", null, queued ? "Waiting to start…" : "Processing your match"),
            h(
              "p",
              { class: "muted" },
              queued ? "VeoClone will start as soon as it has finished its current job. " : "",
              "Keep the black VeoClone window open. Your PC won't go to sleep while VeoClone is working (the screen may turn off). You can leave this page.",
            ),
          ),
          button("Stop", () => void cancel(), { variant: "ghost", icon: I.x }),
        ),
        stepList(p),
        diskInfo(p),
      ),
      currentHealth()?.ai.provider === "CPU" ? slowAiNotice() : null,
      warnings(p),
    );
  }

  function renderReady(p: ProjectMeta) {
    const c = p.calibration;
    const syncText =
      c && c.syncOffsetFrames !== 0
        ? `The ${c.syncOffsetFrames > 0 ? "right" : "left"} phone started ${Math.abs(c.syncOffsetSeconds).toFixed(1)} s before the other one.`
        : "No time difference found between the two phones.";
    const quality = c ? (c.confidence >= 0.8 ? "Very good" : c.confidence >= 0.5 ? "Good" : "Poor – check the result carefully") : "";
    const exporting = p.job?.kind === "export";
    // Straight on to the editor after watching it process, unless there is something to read first.
    const autoOpen = sawWork && (backToEditor || (!p.warnings.length && (c?.confidence ?? 1) >= 0.5));
    const rerunNote = h("span", { "data-testid": "rerun-time" }, rerunTime(p, newAccuracy ?? undefined));
    const rerun = h(
      "details",
      { class: "card rerun", open: restyleOpen, onToggle: () => (restyleOpen = rerun.open) },
      h("summary", null, h("strong", null, "Change the camera style, widest view or AI accuracy"), h("span", { class: "muted small" }, " – runs the AI again")),
      h("p", { class: "muted small" }, "Your trims and camera fixes are kept. ", rerunNote),
      stylePicker(newStyle ?? p.style, (s) => (newStyle = s), "restyle"),
      h("h3", { class: "rerun-head" }, "Widest view"),
      h("p", { class: "muted small" }, WIDEST_HELP),
      widestPicker(newWidest ?? widestViewOf(p), (w) => (newWidest = w), "rewidest"),
      h("h3", { class: "rerun-head" }, "AI accuracy"),
      accuracyPicker(newAccuracy ?? p.aiAccuracy, (a) => {
        newAccuracy = a;
        rerunNote.textContent = rerunTime(p, a);
      }, "reaccuracy"),
      h(
        "div",
        { class: "row" },
        button("Run the AI again", () => void restyle(newStyle ?? p.style, newAccuracy ?? p.aiAccuracy ?? "best", newWidest ?? widestViewOf(p)), { variant: "secondary", icon: I.refresh }),
      ),
    );
    setChildren(
      body,
      h(
        "section",
        { class: "card ready-card" },
        h("div", { class: "ready-head" }, h("span", { class: "ready-icon" }, icon(I.check, 28)), h("div", null, h("h2", null, "Your match is ready"), h("p", { class: "muted" }, autoOpen ? "Opening the editor…" : "Fix the camera, trim the video, then export it."))),
        h("a", { class: "btn btn-primary btn-big", href: `#/edit/${p.id}` }, icon(I.film, 22), h("span", null, "Open the editor")),
        exporting ? notice("info", "VeoClone is making a video of this match right now.") : null,
        h(
          "dl",
          { class: "facts" },
          c ? [h("dt", null, "Lining up"), h("dd", null, syncText), h("dt", null, "Join quality"), h("dd", null, quality), h("dt", null, "Lens"), h("dd", null, c.lens)] : null,
          h("dt", null, "Camera style"),
          h("dd", null, STYLES.find((s) => s.id === p.style)?.name ?? p.style),
          h("dt", null, "Widest view"),
          h("dd", null, WIDEST.find((w) => w.id === widestViewOf(p))?.name ?? widestViewOf(p)),
          h("dt", null, "AI accuracy"),
          h("dd", null, ACCURACY.find((a) => a.id === (p.aiAccuracy ?? "best"))?.name ?? p.aiAccuracy),
          h("dt", null, "Space used"),
          h("dd", null, formatBytes(p.diskBytes)),
        ),
      ),
      warnings(p),
      h(
        "section",
        { class: "card fix-picture" },
        h("h2", null, "Picture looks bent, or the two halves don't join?"),
        h("p", { class: "muted small" }, "Tell VeoClone which camera and lens filmed the match, or swap the two videos if the left phone's video ended up on the right. Both do all the processing again."),
        h(
          "div",
          { class: "row" },
          button("Change phone or lens", () => void lensChange(p), { icon: I.pencil }),
          hasVideo(p.files.left) && hasVideo(p.files.right) ? button("Swap left and right", () => void swapSides(true), { variant: "ghost" }) : null,
        ),
      ),
      h(
        "section",
        { class: "card ai-ball", "data-testid": "ready-ball" },
        h("h2", null, "The ball"),
        ballWords(p.aiRun).map((w) => h("p", { class: "small" }, w)),
        h("p", { class: "muted small" }, AI_REPORT_HELP),
        h("div", { class: "row" }, aiReportButton(() => p)),
      ),
      rerun,
    );
    if (autoOpen && !openTimer) openTimer = window.setTimeout(() => (location.hash = `#/edit/${p.id}`), 1500);
  }

  function renderStopped(p: ProjectMeta) {
    const failed = p.status === "failed";
    const change = button("Change videos or phone", () => {
      forceSetup = true;
      render();
    }, { variant: "ghost" });
    setChildren(
      body,
      failed
        ? errorBox(
            p.error?.message ?? "Processing did not finish.",
            p.error?.detail,
            button("Try again", () => void start(), { variant: "primary", icon: I.refresh }),
            hasVideo(p.files.left) && hasVideo(p.files.right) ? button("Swap left and right and try again", () => void swapSides(true, false)) : null,
            change,
          )
        : notice("info", "Processing was stopped.", h("div", { class: "notice-actions" }, button("Start again", () => void start(), { variant: "primary", icon: I.refresh }), change)),
      h("section", { class: "card" }, stepList(p, failed), diskInfo(p)),
      warnings(p),
    );
  }

  function renderSetup(p: ProjectMeta) {
    if (zones) {
      updateStart();
      return;
    }
    const onFiles = (side: Side) => (files: File[]) => assignFiles(files, side, zones!, (m) => toast(m, "error"));
    zones = {
      left: dropZone({ side: "left", existing: p.files.left, onFiles: onFiles("left"), onChange: updateStart }),
      right: dropZone({ side: "right", existing: p.files.right, onFiles: onFiles("right"), onChange: updateStart }),
    };
    const lensHost = h("div", { class: "lens-host" }, lensUnavailable("Loading the list…"));
    lensOptions().then(
      (options) => setChildren(lensHost, phonesPicker(options, p, (lenses) => void api.updateProject(id, lenses).catch((e) => toast(describeError(e).message, "error")))),
      () => setChildren(lensHost, lensUnavailable()),
    );
    const both = hasVideo(p.files.left) && hasVideo(p.files.right);
    const unfinished = [p.files.left, p.files.right].some((f) => f && !hasVideo(f));
    setChildren(
      body,
      h(
        "section",
        { class: "card form-section" },
        h("h2", null, both ? "Ready to process" : "Add the videos"),
        h(
          "p",
          { class: "muted" },
          both
            ? "Both videos are here. Press Start, or replace a video first."
            : unfinished
              ? "Some files of a video are missing. Add all the files of that video again and press Start: the ones VeoClone already has are skipped."
              : "This match is missing a video. Add one video from each phone.",
        ),
        h("div", { class: "zones" }, zones.left.el, zones.right.el),
        h("div", { class: "zones-foot" }, both ? button("Swap left and right", () => void swapSides(false), { variant: "ghost", class: "btn-small swap" }) : null),
      ),
      h("section", { class: "card form-section" }, h("h2", null, "Which camera and lens filmed this?"), lensHost),
      h(
        "section",
        { class: "card form-section" },
        h("h2", null, "Camera style"),
        stylePicker(p.style, (style) => void api.updateProject(id, { style }).catch((e) => toast(describeError(e).message, "error"))),
        h("h3", { class: "rerun-head" }, "Widest view"),
        h("p", { class: "muted small" }, WIDEST_HELP),
        widestPicker(widestViewOf(p), (widestView) => void api.updateProject(id, { widestView }).catch((e) => toast(describeError(e).message, "error")), "setup-widest"),
      ),
      h(
        "section",
        { class: "card form-section" },
        h("h2", null, "AI accuracy"),
        accuracyPicker(p.aiAccuracy, (aiAccuracy) => void api.updateProject(id, { aiAccuracy }).catch((e) => toast(describeError(e).message, "error"))),
      ),
      h("div", { class: "start-row" }, button("Start", () => void start(), { variant: "primary", big: true, icon: I.sparkle, class: "start-btn" }), h("div", { class: "start-status" })),
    );
    updateStart();
  }

  function updateStart() {
    const btn = body.querySelector<HTMLButtonElement>(".start-btn");
    if (!btn || !zones || !project) return;
    const left = zones.left.files.length > 0 || hasVideo(project.files.left);
    const right = zones.right.files.length > 0 || hasVideo(project.files.right);
    btn.disabled = uploading || !left || !right;
    // Swapping moves the videos VeoClone already has; not with a new one picked.
    const swap = body.querySelector<HTMLButtonElement>(".swap");
    if (swap) swap.hidden = zones.left.files.length > 0 || zones.right.files.length > 0;
  }

  async function start() {
    forceSetup = false;
    clearTimeout(openTimer);
    openTimer = 0;
    try {
      if (zones && (zones.left.files.length || zones.right.files.length)) {
        uploading = true;
        mode = "upload";
        updateStart();
        zones.left.setDisabled(true);
        zones.right.setDisabled(true);
        project = (await sendVideos(id, zones, (u) => (upload = u), project)) ?? project;
        uploading = false;
      }
      project = await api.process(id);
      sawWork = true;
      render();
      watch.refresh();
    } catch (e) {
      uploading = false;
      zones?.left.setDisabled(false);
      zones?.right.setDisabled(false);
      updateStart();
      const { message, detail } = describeError(e);
      const host = body.querySelector(".start-status");
      if (host) setChildren(host, errorBox(message, detail));
      else toast(message, "error", 6000);
    }
  }

  async function restyle(style: Style, aiAccuracy: AiAccuracy, widestView: WidestView) {
    try {
      const p = project;
      if (!p || style !== p.style || aiAccuracy !== (p.aiAccuracy ?? "best") || widestView !== widestViewOf(p)) {
        // Sent only when changed: a match from before the setting keeps "not set".
        await api.updateProject(id, { style, aiAccuracy, ...(p && widestView === widestViewOf(p) ? {} : { widestView }) });
      }
      await start();
    } catch (e) {
      toast(describeError(e).message, "error", 6000);
    }
  }

  async function lensChange(p: ProjectMeta) {
    if (!(await changeLens(p))) return;
    sawWork = true;
    watch.refresh();
  }

  /** Swap the two videos VeoClone already has (nothing is sent again), then process if asked. */
  async function swapSides(process: boolean, ask = true) {
    if (process && ask) {
      const ok = await confirmDialog({
        title: "Swap left and right?",
        text: "Only do this if the left phone's video ended up on the right. VeoClone swaps the two videos (nothing is sent again) and does all the processing again. This takes about as long as the first time, and the editor can't be used until it has finished.",
        confirm: "Swap and process again",
      });
      if (!ok) return;
    }
    try {
      project = await api.swap(id);
      forceSetup = false;
      zones = null;
      if (process) {
        project = await api.process(id);
        sawWork = true;
      }
      render(true);
      watch.refresh();
    } catch (e) {
      toast(describeError(e).message, "error", 6000);
    }
  }

  async function cancel() {
    const ok = await confirmDialog({
      title: "Stop processing?",
      text: "You can start it again later, but it will begin from the start. If this match was ready before, its earlier result is kept.",
      confirm: "Stop processing",
      dismiss: "Keep going",
      danger: true,
    });
    if (!ok) return;
    try {
      project = await api.cancel(id);
      sawWork = false;
      render();
    } catch (e) {
      toast(describeError(e).message, "error");
    }
    watch.refresh();
  }

  return {
    dispose() {
      watch.stop();
      clearTimeout(openTimer);
      upload?.abort();
    },
    leaveWarning: () => (uploading ? "A video is still being sent to VeoClone. If you leave now, it will not be saved." : null),
  };
}
