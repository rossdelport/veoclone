// A big "drop your video here" box for one camera, with upload progress.
// It takes one video file, or all the files of a recording the camera split
// into parts (a GoPro starts a new file every 4 GB), listed in the order
// VeoClone joins them.
import { hasVideo, type FileInfo, type Side, type UploadProgress } from "../api";
import { iconButton, progressBar, setProgress } from "./common";
import { formatBytes, formatDuration, formatTimeLeft, h, icon, setChildren } from "./dom";
import { I } from "./icons";
import { checkParts, partsNote, sortParts } from "./parts";

const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|avi|mts|m2ts|3gp)$/i;

export interface DropZone {
  el: HTMLElement;
  /** The files chosen in this browser, in the order they are joined (empty when using the video VeoClone already has). */
  readonly files: File[];
  /** Every chosen file has been sent to VeoClone. */
  readonly uploaded: boolean;
  /** File `index` of `files` has been sent to VeoClone. */
  sent(index: number): boolean;
  /** Use these files (put in order); [] goes back to the video VeoClone already has. */
  setFiles(files: File[]): void;
  /** Progress of sending file `index`; null when it stopped or finished. */
  setUploading(p: UploadProgress | null, index?: number): void;
  /** File `index` has been sent. */
  setSent(index: number): void;
  setDisabled(disabled: boolean): void;
}

export function isVideoFile(f: File): boolean {
  return f.type.startsWith("video/") || VIDEO_EXT.test(f.name);
}

interface Meta {
  duration: number;
  width: number;
  height: number;
}

/** One row of the list of parts. */
interface Row {
  name: string;
  size: number;
  duration?: number;
  /** Not on VeoClone yet (a part of the video VeoClone has that was never sent). */
  missing?: boolean;
}

export function dropZone(opts: {
  side: Side;
  /** Video already on the helper (shown until new files are picked). */
  existing?: FileInfo;
  onFiles(files: File[]): void;
  onChange(): void;
}): DropZone {
  const title = opts.side === "left" ? "Left phone" : "Right phone";
  const where =
    opts.side === "left"
      ? "The phone filming the left half of the pitch"
      : "The phone filming the right half of the pitch";
  const input = h("input", {
    type: "file",
    accept: "video/*,.mov,.mp4,.m4v",
    multiple: true,
    class: "visually-hidden",
    "aria-label": `Choose the ${title.toLowerCase()} video`,
    "data-testid": `file-${opts.side}`,
  });
  const body = h("div", { class: "dz-body" });
  const el = h(
    "div",
    { class: "dropzone", "data-side": opts.side },
    h("div", { class: "dz-head" }, h("span", { class: "dz-side" }, opts.side === "left" ? "L" : "R"), h("div", null, h("h3", null, title), h("p", { class: "muted small" }, where))),
    body,
    input,
  );

  let files: File[] = [];
  let sent: boolean[] = [];
  let disabled = false;
  let uploading = false;
  const metas = new Map<File, Meta>();
  /** The state cell of each row of the parts list, to show progress in place. */
  let rowStates: HTMLElement[] = [];

  const browse = () => {
    if (!disabled) input.click();
  };

  function renderEmpty() {
    el.classList.remove("has-file");
    setChildren(
      body,
      h(
        "button",
        { type: "button", class: "dz-target", onClick: browse, disabled },
        icon(I.upload, 34),
        h("strong", null, "Drop the video here"),
        h("span", { class: "muted" }, "or click to choose it on your PC"),
        h("span", { class: "muted small" }, "GoPro video in several files? Add them all."),
      ),
    );
  }

  function portraitWarning(meta: Meta | undefined) {
    return meta && meta.height > meta.width
      ? h("p", { class: "dz-warn" }, icon(I.alert, 16), "This video is upright. Film with the phone turned sideways (landscape) so VeoClone can join the two videos.")
      : null;
  }

  function changeButton() {
    return h("button", { type: "button", class: "btn btn-ghost btn-small", onClick: browse, disabled }, "Change");
  }

  /** One file: its name, size and length. */
  function renderFile(name: string, size: number, note: string) {
    el.classList.add("has-file");
    rowStates = [];
    const meta = files[0] ? metas.get(files[0]) : undefined;
    setChildren(
      body,
      h(
        "div",
        { class: "dz-file" },
        icon(I.film, 28),
        h(
          "div",
          { class: "dz-file-text" },
          h("strong", { class: "dz-name", title: name }, name),
          h("span", { class: "muted small" }, [formatBytes(size), meta ? formatDuration(meta.duration) + " long" : "", note].filter(Boolean).join(" · ")),
        ),
        changeButton(),
      ),
      portraitWarning(meta),
    );
  }

  /**
   * Several files, joined in this order: "3 parts · 1:32:10 · 15.2 GB" and
   * the list. `local`: picked in this browser (else: on VeoClone already,
   * `length` the whole video's length when known).
   */
  function renderParts(rows: Row[], local: boolean, length?: number) {
    el.classList.add("has-file");
    const durations = rows.map((r) => r.duration);
    const total = length ?? (durations.every((d) => d !== undefined) ? durations.reduce((a, b) => a! + b!, 0) : undefined);
    const size = rows.reduce((a, r) => a + r.size, 0);
    const summary = [`${rows.length} parts`, total !== undefined ? formatDuration(total) : "", formatBytes(size)].filter(Boolean).join(" · ");
    const names = rows.map((r) => r.name);
    rowStates = rows.map((r, i) =>
      h("span", { class: "dz-part-state small" }, r.missing ? "not sent yet" : local && sent[i] ? [icon(I.check, 14), "Sent"] : ""),
    );
    const warnings = local ? checkParts(names) : [];
    if (rows.some((r) => r.missing)) {
      warnings.push("Some files of this video haven't been sent to VeoClone yet. Add all its files again and press Start: the ones already sent are skipped.");
    }
    const info = local ? partsNote(names) : null;
    setChildren(
      body,
      h(
        "div",
        { class: "dz-file" },
        icon(I.film, 28),
        h(
          "div",
          { class: "dz-file-text" },
          h("strong", { class: "dz-name", "data-testid": "parts-summary" }, summary),
          h("span", { class: "muted small" }, local ? "Joined in this order:" : "Already added, joined in this order:"),
        ),
        changeButton(),
      ),
      h(
        "ol",
        { class: "dz-parts", "aria-label": `Files of the ${title.toLowerCase()} video` },
        rows.map((r, i) =>
          h(
            "li",
            { class: `dz-part${r.missing ? " missing" : ""}` },
            h("span", { class: "dz-part-n" }, String(i + 1)),
            h(
              "span",
              { class: "dz-part-text" },
              h("span", { class: "dz-name", title: r.name }, r.name || `Part ${i + 1}`),
              h("span", { class: "muted small" }, r.missing ? "" : [formatBytes(r.size), r.duration !== undefined ? formatDuration(r.duration) : ""].filter(Boolean).join(" · ")),
            ),
            rowStates[i],
            local ? iconButton(I.x, `Remove ${r.name}`, () => remove(i), "btn-ghost btn-small dz-remove") : null,
          ),
        ),
      ),
      warnings.map((w) => h("p", { class: "dz-warn", role: "note" }, icon(I.alert, 16), w)),
      info ? h("p", { class: "muted small dz-note" }, info) : null,
      portraitWarning(files[0] ? metas.get(files[0]) : undefined),
    );
    for (const b of body.querySelectorAll<HTMLButtonElement>("button")) b.disabled = disabled || uploading;
  }

  function render() {
    if (files.length === 1) return renderFile(files[0].name, files[0].size, "");
    if (files.length > 1) {
      return renderParts(
        files.map((f) => ({ name: f.name, size: f.size, duration: metas.get(f)?.duration })),
        true,
      );
    }
    const existing = opts.existing;
    if (!existing) return renderEmpty();
    if (!existing.parts?.length) return renderFile(existing.name, existing.sizeBytes, "already added");
    const rows: Row[] = existing.parts.map((p, i) => (p ? { name: p.name, size: p.sizeBytes } : { name: `Part ${i + 1}`, size: 0, missing: true }));
    // VeoClone knows the length of the whole video once it has checked it.
    renderParts(rows, false, hasVideo(existing) ? existing.probe?.duration : undefined);
  }

  function readMeta(f: File) {
    if (metas.has(f)) return;
    const url = URL.createObjectURL(f);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    const done = () => {
      URL.revokeObjectURL(url);
      v.removeAttribute("src");
      v.load();
    };
    v.onloadedmetadata = () => {
      if (Number.isFinite(v.duration)) {
        metas.set(f, { duration: v.duration, width: v.videoWidth, height: v.videoHeight });
        if (files.includes(f) && !uploading) render();
      }
      done();
    };
    v.onerror = done;
    v.src = url;
  }

  function remove(index: number) {
    if (disabled || uploading) return;
    files = files.filter((_, i) => i !== index);
    sent = sent.filter((_, i) => i !== index);
    el.classList.remove("uploaded");
    render();
    opts.onChange();
  }

  input.addEventListener("change", () => {
    const picked = [...(input.files ?? [])];
    input.value = "";
    if (picked.length) opts.onFiles(picked);
  });
  el.addEventListener("dragover", (e) => {
    if (disabled) return;
    e.preventDefault();
    el.classList.add("dragging");
  });
  el.addEventListener("dragleave", (e) => {
    if (!el.contains(e.relatedTarget as Node)) el.classList.remove("dragging");
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("dragging");
    if (disabled) return;
    const dropped = [...(e.dataTransfer?.files ?? [])];
    if (dropped.length) opts.onFiles(dropped);
  });

  render();

  const zone: DropZone = {
    el,
    get files() {
      return files;
    },
    get uploaded() {
      return files.length > 0 && sent.every(Boolean);
    },
    sent(index) {
      return sent[index] === true;
    },
    setFiles(list) {
      files = sortParts(list);
      sent = files.map(() => false);
      el.classList.remove("uploaded");
      for (const f of files) readMeta(f);
      render();
      opts.onChange();
    },
    setUploading(p, index = 0) {
      uploading = !!p;
      el.classList.toggle("uploading", !!p);
      if (!p) return render();
      let bar = body.querySelector<HTMLElement>(".progress");
      let text = body.querySelector<HTMLElement>(".dz-progress-text");
      if (!bar || !text) {
        bar = progressBar(0, `Sending the ${title.toLowerCase()} video`);
        text = h("p", { class: "dz-progress-text small" });
        body.append(h("div", { class: "dz-progress" }, bar, text));
        for (const b of body.querySelectorAll<HTMLButtonElement>(".dz-remove")) b.disabled = true;
      }
      const frac = p.total > 0 ? p.loaded / p.total : 0;
      if (files.length < 2) {
        setProgress(bar, frac);
        const left = p.rate > 0 ? (p.total - p.loaded) / p.rate : undefined;
        text.textContent = [`Sending to VeoClone… ${Math.round(frac * 100)}%`, formatTimeLeft(left)].filter(Boolean).join(" · ");
        return;
      }
      // Several files: the bar and the time left are for all of them.
      const all = files.reduce((a, f) => a + f.size, 0);
      const done = files.reduce((a, f, i) => a + (sent[i] ? f.size : 0), 0) + p.loaded;
      const todo = files.reduce((a, f, i) => a + (sent[i] || i === index ? 0 : f.size), 0) + (p.total - p.loaded);
      setProgress(bar, all > 0 ? done / all : 0);
      text.textContent = [
        `Sending part ${index + 1} of ${files.length} to VeoClone… ${Math.round(frac * 100)}%`,
        formatTimeLeft(p.rate > 0 ? todo / p.rate : undefined),
      ]
        .filter(Boolean)
        .join(" · ");
      const state = rowStates[index];
      if (state) state.textContent = `${Math.round(frac * 100)}%`;
    },
    setSent(index) {
      sent[index] = true;
      const state = rowStates[index];
      if (state) setChildren(state, icon(I.check, 14), "Sent");
      if (!zone.uploaded) return;
      uploading = false;
      el.classList.remove("uploading");
      el.classList.add("uploaded");
      render();
      body.append(h("p", { class: "dz-done small" }, icon(I.check, 16), "Sent to VeoClone"));
    },
    setDisabled(d) {
      disabled = d;
      el.classList.toggle("disabled", d);
      for (const b of body.querySelectorAll("button")) b.disabled = d || (uploading && b.classList.contains("dz-remove"));
    },
  };
  return zone;
}

/**
 * Put the dropped or chosen files in a box: all of them (a camera that
 * split its recording into several files), in the order they are joined.
 * Files that are not videos (a GoPro's .THM and .LRV files) are left out.
 */
export function assignFiles(files: File[], side: Side, zones: Record<Side, DropZone>, onReject: (msg: string) => void): void {
  const videos = files.filter(isVideoFile);
  if (videos.length === 0) {
    onReject("That doesn't look like a video file. Choose the .MOV or .MP4 file from the phone, or all the .MP4 files of a GoPro recording.");
    return;
  }
  zones[side].setFiles(videos);
}
