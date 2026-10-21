// Processing view (#/project/:id): steps with progress, warnings, errors,
// cancel / try again, and adding missing videos.
import { api, watchProject, type ApiError, type JobStep, type Lens, type ProjectMeta, type Side, type Upload } from "../api";
import { button, confirmDialog, describeError, errorBox, notice, progressBar, toast } from "./common";
import { formatBytes, formatTimeLeft, h, icon, setChildren } from "./dom";
import { dropZone, assignFiles, type DropZone } from "./dropzone";
import { currentHealth } from "./health";
import { I } from "./icons";
import { lensSelect, sendVideos, stylePicker, STYLES } from "./newMatch";
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

export function projectPage(ctx: PageContext, id: string): Page {
  ctx.setTitle("Processing");
  const title = h("div", { class: "project-title" });
  const body = h("div", { class: "project-body", "aria-live": "polite" });
  ctx.root.append(h("div", { class: "page page-project" }, h("a", { class: "back-link", href: "#/" }, icon(I.back, 18), "Your matches"), title, body));
  setChildren(body, h("div", { class: "skeleton-card tall" }));

  let project: ProjectMeta | null = null;
  let sawWork = false; // watched it process, so open the editor when done
  let lastStep: JobStep | null = null; // to show which step failed
  let openTimer = 0;
  let lenses: Lens[] | null = null;
  let upload: Upload | null = null;
  let uploading = false;
  let forceSetup = false; // "Choose other videos" after a failure
  let mode = "";
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

  function render() {
    const p = project!;
    const working = p.status === "processing" || p.status === "queued";
    const next = uploading ? "upload" : working ? "work" : forceSetup ? "setup" : p.status;
    if (next !== mode) {
      mode = next;
      zones = null;
    }
    if (uploading) return;
    if (working) return renderWork(p);
    if (p.status === "ready") return renderReady(p);
    if ((p.status === "failed" || p.status === "cancelled") && !forceSetup) return renderStopped(p);
    return renderSetup(p);
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
        let extra: HTMLElement | null = null;
        if (state === "active" && job) {
          const key = `${job.startedAt}/${job.step}`;
          if (stepClock.key !== key) Object.assign(stepClock, { key, start: performance.now() });
          let eta = job.etaSeconds;
          const elapsed = (performance.now() - stepClock.start) / 1000;
          // Our own guess only for steps that count frames (others move in jumps).
          if (eta === undefined && job.framesTotal && job.progress > 0.03 && elapsed > 3) eta = (elapsed / job.progress) * (1 - job.progress);
          const frames = job.framesTotal ? `${(job.framesDone ?? 0).toLocaleString()} of ${job.framesTotal.toLocaleString()} frames` : "";
          extra = h(
            "div",
            { class: "step-progress" },
            progressBar(job.progress, s.name),
            h("p", { class: "small muted" }, [`${Math.round(job.progress * 100)}%`, formatTimeLeft(eta), frames].filter(Boolean).join(" · ")),
          );
        }
        return h(
          "li",
          { class: `step step-${state}`, "data-step": s.step },
          h("span", { class: "step-icon" }, state === "done" ? icon(I.check, 16) : state === "failed" ? icon(I.x, 16) : String(i + 1)),
          h(
            "div",
            { class: "step-body" },
            h("strong", null, s.name),
            h("span", { class: "muted small" }, state === "active" && job?.message ? job.message : s.text),
            extra,
          ),
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
          h("div", null, h("h2", null, queued ? "Waiting to start…" : "Processing your match"), h("p", { class: "muted" }, queued ? "VeoClone will start as soon as it has finished its current job." : "You can leave this page; VeoClone keeps working as long as its window is open.")),
          button("Cancel", () => void cancel(), { variant: "ghost", icon: I.x }),
        ),
        stepList(p),
        diskInfo(p),
      ),
      warnings(p),
    );
  }

  function renderReady(p: ProjectMeta) {
    const c = p.calibration;
    const syncText =
      c && c.syncOffsetFrames !== 0
        ? `The ${c.syncOffsetFrames > 0 ? "right" : "left"} phone started ${Math.abs(c.syncOffsetSeconds).toFixed(1)} s before the other one.`
        : "Both phones started at the same moment.";
    const quality = c ? (c.confidence >= 0.8 ? "Very good" : c.confidence >= 0.5 ? "Good" : "Poor – check the result carefully") : "";
    const exporting = p.job?.kind === "export";
    let newStyle = p.style;
    const rerun = h(
      "details",
      { class: "card rerun" },
      h("summary", null, h("strong", null, "Change the camera style"), h("span", { class: "muted small" }, " – runs the AI again")),
      h("p", { class: "muted small" }, "Your trims and camera fixes are kept. This takes about as long as the first time."),
      stylePicker(p.style, (s) => (newStyle = s), "restyle"),
      h(
        "div",
        { class: "row" },
        button("Run the AI again", () => void restyle(newStyle), { variant: "secondary", icon: I.refresh }),
      ),
    );
    setChildren(
      body,
      h(
        "section",
        { class: "card ready-card" },
        h("div", { class: "ready-head" }, h("span", { class: "ready-icon" }, icon(I.check, 28)), h("div", null, h("h2", null, "Your match is ready"), h("p", { class: "muted" }, sawWork ? "Opening the editor…" : "Fix the camera, trim the video, then export it."))),
        h("a", { class: "btn btn-primary btn-big", href: `#/edit/${p.id}` }, icon(I.film, 22), h("span", null, "Open the editor")),
        exporting ? notice("info", "VeoClone is making a video of this match right now.") : null,
        h(
          "dl",
          { class: "facts" },
          c ? [h("dt", null, "Lining up"), h("dd", null, syncText), h("dt", null, "Join quality"), h("dd", null, quality), h("dt", null, "Lens"), h("dd", null, c.lens)] : null,
          h("dt", null, "Camera style"),
          h("dd", null, STYLES.find((s) => s.id === p.style)?.name ?? p.style),
          h("dt", null, "Space used"),
          h("dd", null, formatBytes(p.diskBytes)),
        ),
      ),
      warnings(p),
      rerun,
    );
    if (sawWork && !openTimer) openTimer = window.setTimeout(() => (location.hash = `#/edit/${p.id}`), 1500);
  }

  function renderStopped(p: ProjectMeta) {
    const failed = p.status === "failed";
    setChildren(
      body,
      failed
        ? errorBox(
            p.error?.message ?? "Processing did not finish.",
            p.error?.detail,
            button("Try again", () => void start(), { variant: "primary", icon: I.refresh }),
            button("Choose other videos", () => {
              forceSetup = true;
              render();
            }, { variant: "ghost" }),
          )
        : notice("info", "Processing was stopped.", h("div", { class: "notice-actions" }, button("Start again", () => void start(), { variant: "primary", icon: I.refresh }))),
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
    const lensHost = h("div", { class: "lens-host" });
    const fill = (list: Lens[]) =>
      setChildren(lensHost, lensSelect(list, p.lensId, (lensId) => void api.updateProject(id, { lensId }).catch((e) => toast(describeError(e).message, "error"))));
    if (lenses) fill(lenses);
    else void api.lenses().then((l) => fill((lenses = l)), () => undefined);
    setChildren(
      body,
      h(
        "section",
        { class: "card form-section" },
        h("h2", null, p.files.left && p.files.right ? "Ready to process" : "Add the videos"),
        h("p", { class: "muted" }, p.files.left && p.files.right ? "Both videos are here. Press Start, or replace a video first." : "This match is missing a video. Add one video from each phone."),
        h("div", { class: "zones" }, zones.left.el, zones.right.el),
      ),
      h("section", { class: "card form-section" }, h("label", { class: "field-label", for: "lens" }, "Which iPhone filmed this?"), lensHost),
      h("section", { class: "card form-section" }, h("h2", null, "Camera style"), stylePicker(p.style, (style) => void api.updateProject(id, { style }).catch((e) => toast(describeError(e).message, "error")))),
      h("div", { class: "start-row" }, button("Start", () => void start(), { variant: "primary", big: true, icon: I.sparkle, class: "start-btn" }), h("div", { class: "start-status" })),
    );
    updateStart();
  }

  function updateStart() {
    const btn = body.querySelector<HTMLButtonElement>(".start-btn");
    if (!btn || !zones || !project) return;
    const left = zones.left.file || project.files.left;
    const right = zones.right.file || project.files.right;
    btn.disabled = uploading || !left || !right;
  }

  async function start() {
    forceSetup = false;
    clearTimeout(openTimer);
    openTimer = 0;
    try {
      if (zones && (zones.left.file || zones.right.file)) {
        uploading = true;
        mode = "upload";
        updateStart();
        zones.left.setDisabled(true);
        zones.right.setDisabled(true);
        await sendVideos(id, zones, (u) => (upload = u));
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

  async function restyle(style: ProjectMeta["style"]) {
    try {
      if (style !== project?.style) await api.updateProject(id, { style });
      await start();
    } catch (e) {
      toast(describeError(e).message, "error", 6000);
    }
  }

  async function cancel() {
    const ok = await confirmDialog({
      title: "Stop processing?",
      text: "You can start it again later, but it will begin from the start.",
      confirm: "Stop processing",
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
