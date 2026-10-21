// Export drawer: size and quality, "Make video", progress, past videos.
import { api, type ExportMeta, type ExportOverlay, type ProjectMeta } from "../api";
import {
  bytesToBase64,
  drawOverlay,
  encodePathBase64,
  frameToTime,
  keptFrameCount,
  overlayOutputRanges,
  type CalibInfo,
  type Edits,
  type ExportQuality,
  type Fps,
  type Overlay,
} from "../engine";
import { button, confirmDialog, describeError, details, errorBox, iconButton, progressBar, setProgress, toast } from "./common";
import { formatBytes, formatDate, formatDuration, formatTimeLeft, h, icon, setChildren } from "./dom";
import type { EditStore } from "./editStore";
import { I } from "./icons";

const SIZES: { w: number; h: number; name: string; text: string }[] = [
  { w: 1920, h: 1080, name: "1080p", text: "Full HD. Plays everywhere. Recommended." },
  { w: 2560, h: 1440, name: "1440p", text: "2K. Sharper, bigger file." },
  { w: 3840, h: 2160, name: "4K", text: "Sharpest. Big file and the slowest to make." },
];
const QUALITIES: { id: ExportQuality; name: string; text: string }[] = [
  { id: "fast", name: "Good", text: "Smaller file, made faster." },
  { id: "balanced", name: "Better", text: "A good balance. Recommended." },
  { id: "high", name: "Best", text: "Best picture, biggest file." },
];

const sizeName = (e: { width: number; height: number }) => SIZES.find((s) => s.w === e.width)?.name ?? `${e.width}x${e.height}`;
const qualityName = (q: ExportQuality) => QUALITIES.find((x) => x.id === q)?.name ?? q;

/** One text box as a PNG of the whole video picture (see-through around the box). */
async function overlayPng(o: Overlay, width: number, height: number): Promise<string> {
  let blob: Blob;
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    drawOverlay(canvas.getContext("2d")!, o, width, height);
    blob = await canvas.convertToBlob({ type: "image/png" });
  } else {
    const canvas = h("canvas", { width, height });
    drawOverlay(canvas.getContext("2d")!, o, width, height);
    blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas.toBlob gave nothing"))), "image/png"));
  }
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

/** The text boxes for the export: those with words that are in a kept part. */
async function exportOverlays(edits: Edits, fps: Fps): Promise<ExportOverlay[]> {
  const out: ExportOverlay[] = [];
  for (const o of edits.overlays) {
    const ranges = overlayOutputRanges(o, edits.segments, fps);
    if (!o.text.trim() || ranges.length === 0) continue;
    out.push({ pngBase64: await overlayPng(o, edits.export.width, edits.export.height), ranges });
  }
  return out;
}

export class ExportPanel {
  readonly el: HTMLDialogElement;
  private list = h("div", { class: "export-list", "aria-live": "polite" });
  private summary = h("p", { class: "export-summary" });
  private error = h("div", { class: "export-error" });
  private makeBtn: HTMLButtonElement;
  private project: ProjectMeta | null = null;
  private starting = false;
  private clock = new Map<string, { at: number; progress: number; start: number }>();
  /** What the list shows now, and the running rows' progress bars (moved without a rebuild). */
  private shown = "";
  private live = new Map<string, { bar: HTMLElement; text: HTMLElement }>();

  constructor(
    private readonly id: string,
    private readonly store: EditStore,
    private readonly calib: CalibInfo,
    private readonly onStarted: () => void,
  ) {
    const exp = store.edits.export;
    this.makeBtn = button("Make video", () => void this.start(), { variant: "primary", big: true, icon: I.film });
    // Segmented buttons with a line explaining the chosen one.
    const radios = <T>(name: string, label: string, items: { key: T; label: string; text: string }[], value: T, set: (v: T) => void) => {
      const note = h("p", { class: "muted small seg-note" }, items.find((it) => it.key === value)?.text ?? "");
      return h(
        "div",
        null,
        h(
          "div",
          { class: "seg", role: "radiogroup", "aria-label": label },
          items.map((it) =>
            h(
              "label",
              null,
              h("input", {
                type: "radio",
                name,
                checked: it.key === value,
                onChange: () => {
                  note.textContent = it.text;
                  set(it.key);
                },
              }),
              h("span", null, it.label),
            ),
          ),
        ),
        note,
      );
    };
    this.el = h(
      "dialog",
      { class: "drawer", "aria-label": "Export your video" },
      h(
        "div",
        { class: "drawer-head" },
        h("h2", null, "Export your video"),
        iconButton(I.x, "Close", () => this.close()),
      ),
      h(
        "div",
        { class: "drawer-body" },
        this.summary,
        h("h3", null, "Size"),
        radios(
          "export-size",
          "Size",
          SIZES.map((s) => ({ key: s.w, label: s.name, text: s.text })),
          exp.width,
          (w) => {
            const s = SIZES.find((x) => x.w === w)!;
            this.store.setExport({ ...this.store.edits.export, width: s.w, height: s.h });
          },
        ),
        h("h3", null, "Quality"),
        radios(
          "export-quality",
          "Quality",
          QUALITIES.map((q) => ({ key: q.id, label: q.name, text: q.text })),
          exp.quality,
          (quality) => this.store.setExport({ ...this.store.edits.export, quality }),
        ),
        h("div", { class: "drawer-action" }, this.makeBtn),
        this.error,
        h(
          "p",
          { class: "muted small" },
          "Videos are saved in the VeoClone folder on your PC. You can keep editing while a video is being made. Keep the black VeoClone window open; your PC won't go to sleep while VeoClone is working (the screen may turn off).",
        ),
        h("h3", null, "Your videos"),
        this.list,
      ),
    );
    this.el.addEventListener("click", (e) => {
      if (e.target === this.el) this.close(); // click on the backdrop
    });
    this.el.addEventListener("keydown", (e) => e.stopPropagation());
    document.body.append(this.el);
    store.onChange(() => this.renderSummary());
    this.renderSummary();
  }

  open(): void {
    this.renderSummary();
    if (!this.el.open) this.el.showModal();
  }

  close(): void {
    this.el.close();
  }

  private renderSummary() {
    const frames = keptFrameCount(this.store.edits);
    const parts = this.store.edits.segments.length;
    setChildren(
      this.summary,
      "Your video will be ",
      h("strong", null, formatDuration(frameToTime(frames, this.calib.fps))),
      " long",
      parts > 1 ? ` (${parts} parts joined together)` : "",
      ".",
    );
    this.updateButton();
  }

  private running(): ExportMeta | undefined {
    return this.project?.exports.find((e) => e.status === "running" || e.status === "queued");
  }

  private updateButton() {
    const busy = !!this.running() || this.starting || this.project?.job?.kind === "process";
    this.makeBtn.disabled = busy || keptFrameCount(this.store.edits) === 0;
    this.makeBtn.querySelector("span")!.textContent = this.running() ? "Making a video…" : "Make video";
  }

  update(p: ProjectMeta): void {
    this.project = p;
    this.updateButton();
    const exports = [...p.exports].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    // Rebuild the rows only when one changes, so their buttons stay put under the mouse.
    const key = JSON.stringify(exports.map((e) => [e.id, e.status, e.fileName, e.sizeBytes, e.error]));
    if (key === this.shown) {
      for (const e of exports) {
        const row = this.live.get(e.id);
        if (!row) continue;
        setProgress(row.bar, e.progress);
        row.text.textContent = this.progressText(p, e);
      }
      return;
    }
    this.shown = key;
    this.live.clear();
    if (!exports.length) {
      setChildren(this.list, h("p", { class: "muted empty-small" }, "No videos yet. Press Make video when you're happy with your edit."));
      return;
    }
    setChildren(this.list, exports.map((e) => this.row(p, e)));
  }

  private progressText(p: ProjectMeta, e: ExportMeta): string {
    if (e.status === "queued") return "Waiting to start…";
    const adding = p.job?.exportId === e.id && p.job.step === "overlay";
    return [`${adding ? "Adding your text" : "Making your video"}… ${Math.round(e.progress * 100)}%`, this.timeLeft(p, e)].filter(Boolean).join(" · ");
  }

  private timeLeft(p: ProjectMeta, e: ExportMeta): string {
    const job = p.job?.kind === "export" && p.job.exportId === e.id ? p.job : null;
    if (job?.etaSeconds !== undefined) return formatTimeLeft(job.etaSeconds);
    // Estimate from how fast the progress moves.
    const now = performance.now();
    const c = this.clock.get(e.id) ?? { at: now, progress: e.progress, start: now };
    if (!this.clock.has(e.id)) this.clock.set(e.id, c);
    const elapsed = (now - c.start) / 1000;
    const done = e.progress - c.progress;
    if (elapsed < 4 || done <= 0.01) return "";
    return formatTimeLeft((elapsed / done) * (1 - e.progress));
  }

  private row(p: ProjectMeta, e: ExportMeta): HTMLElement {
    const what = `${sizeName(e)} · ${qualityName(e.quality)}`;
    const head = h("div", { class: "export-head" }, h("strong", null, e.fileName ?? "Your video"), h("span", { class: "muted small" }, `${what} · ${formatDate(e.createdAt)}`));
    let body: HTMLElement;
    switch (e.status) {
      case "queued":
      case "running": {
        const bar = progressBar(e.progress, "Making your video");
        const text = h("span", { class: "small" }, this.progressText(p, e));
        this.live.set(e.id, { bar, text });
        body = h("div", { class: "export-progress" }, bar, h("div", { class: "row" }, text, button("Stop", () => void this.cancel(), { variant: "ghost", class: "btn-small" })));
        break;
      }
      case "done":
        body = h(
          "div",
          { class: "row export-actions" },
          h("a", { class: "btn btn-primary", href: api.exportFileUrl(this.id, e.id), download: e.fileName ?? "", "data-testid": "download" }, icon(I.download, 18), h("span", null, "Download")),
          button("Show in folder", () => void api.openFolder(this.id, e.id).catch((err) => toast(describeError(err).message, "error")), { icon: I.folder }),
          h("span", { class: "muted small grow nowrap" }, formatBytes(e.sizeBytes)),
          iconButton(I.trash, "Delete this video", () => void this.remove(e), "btn-ghost"),
        );
        break;
      default: {
        // The helper sends the plain reason, then the technical part after a newline.
        const [why, ...more] = (e.error ?? "").split("\n");
        body = h(
          "div",
          { class: "export-failed" },
          h("p", { class: e.status === "failed" ? "text-bad small" : "muted small" }, e.status === "failed" ? why || "This video could not be made." : "Stopped before it was finished."),
          e.status === "failed" ? details(more.join("\n")) : null,
          h("div", { class: "row" }, button("Try again", () => void this.start(), { variant: "secondary", icon: I.refresh, class: "btn-small" }), iconButton(I.trash, "Remove from the list", () => void this.remove(e), "btn-ghost")),
        );
      }
    }
    return h("div", { class: `export-row export-${e.status}`, "data-testid": "export-row" }, head, body);
  }

  async start(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    this.updateButton();
    this.error.replaceChildren();
    try {
      const edits = this.store.edits;
      const path = this.store.currentPath();
      const exp = await api.startExport(this.id, {
        segments: edits.segments.map((s) => ({ startFrame: s.start, endFrame: s.end })),
        width: edits.export.width,
        height: edits.export.height,
        quality: edits.export.quality,
        pathBase64: encodePathBase64(path),
        overlays: await exportOverlays(edits, this.calib.fps),
      });
      if (this.project) this.update({ ...this.project, exports: [...this.project.exports.filter((x) => x.id !== exp.id), exp] });
      this.list.scrollIntoView({ behavior: "smooth", block: "nearest" });
      this.onStarted();
    } catch (e) {
      const { message, detail } = describeError(e);
      setChildren(this.error, errorBox(message, detail));
    } finally {
      this.starting = false;
      this.updateButton();
    }
  }

  private async cancel() {
    const ok = await confirmDialog({ title: "Stop making this video?", text: "The part made so far is thrown away.", confirm: "Stop", dismiss: "Keep going", danger: true });
    if (!ok) return;
    try {
      this.update(await api.cancel(this.id));
    } catch (e) {
      toast(describeError(e).message, "error");
    }
    this.onStarted();
  }

  private async remove(e: ExportMeta) {
    const ok = await confirmDialog({
      title: "Delete this video?",
      text: e.status === "done" ? "The video file is deleted from your PC. Copies you downloaded elsewhere are kept." : "It is removed from the list.",
      confirm: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      this.update(await api.deleteExport(this.id, e.id));
    } catch (err) {
      toast(describeError(err).message, "error");
    }
  }

  dispose(): void {
    this.el.remove();
  }
}
