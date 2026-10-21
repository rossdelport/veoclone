// A big "drop your video here" box for one phone, with upload progress.
import type { FileInfo, Side, UploadProgress } from "../api";
import { progressBar, setProgress } from "./common";
import { formatBytes, formatDuration, formatTimeLeft, h, icon, setChildren } from "./dom";
import { I } from "./icons";

const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|avi|mts|m2ts|3gp)$/i;

export interface DropZone {
  el: HTMLElement;
  /** The file chosen in this browser (null when using the helper's copy). */
  file: File | null;
  setFile(file: File | null): void;
  setUploading(p: UploadProgress | null): void;
  setUploaded(): void;
  setDisabled(disabled: boolean): void;
}

export function isVideoFile(f: File): boolean {
  return f.type.startsWith("video/") || VIDEO_EXT.test(f.name);
}

export function dropZone(opts: {
  side: Side;
  /** File already on the helper (shown until a new one is picked). */
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

  let file: File | null = null;
  let disabled = false;
  let meta: { duration: number; width: number; height: number } | null = null;
  let metaToken = 0;

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
      ),
    );
  }

  function renderFile(name: string, size: number, note: string) {
    el.classList.add("has-file");
    const portrait = meta && meta.height > meta.width;
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
        h("button", { type: "button", class: "btn btn-ghost btn-small", onClick: browse, disabled }, "Change"),
      ),
      portrait
        ? h("p", { class: "dz-warn" }, icon(I.alert, 16), "This video is upright. Film with the phone turned sideways (landscape) so VeoClone can join the two videos.")
        : null,
    );
  }

  function render() {
    if (file) renderFile(file.name, file.size, "");
    else if (opts.existing) renderFile(opts.existing.name, opts.existing.sizeBytes, "already added");
    else renderEmpty();
  }

  function readMeta(f: File) {
    const token = ++metaToken;
    meta = null;
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
      if (token === metaToken && Number.isFinite(v.duration)) {
        meta = { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
        render();
      }
      done();
    };
    v.onerror = done;
    v.src = url;
  }

  input.addEventListener("change", () => {
    const files = [...(input.files ?? [])];
    input.value = "";
    if (files.length) opts.onFiles(files);
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
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) opts.onFiles(files);
  });

  render();

  const zone: DropZone = {
    el,
    get file() {
      return file;
    },
    setFile(f) {
      file = f;
      el.classList.remove("uploaded");
      if (f) readMeta(f);
      render();
      opts.onChange();
    },
    setUploading(p) {
      el.classList.toggle("uploading", !!p);
      if (!p) return render();
      let bar = body.querySelector<HTMLElement>(".progress");
      let text = body.querySelector<HTMLElement>(".dz-progress-text");
      if (!bar || !text) {
        bar = progressBar(0, `Sending the ${title.toLowerCase()} video`);
        text = h("p", { class: "dz-progress-text small" });
        body.append(h("div", { class: "dz-progress" }, bar, text));
      }
      const frac = p.total > 0 ? p.loaded / p.total : 0;
      setProgress(bar, frac);
      const left = p.rate > 0 ? (p.total - p.loaded) / p.rate : undefined;
      text.textContent = [`Sending to VeoClone… ${Math.round(frac * 100)}%`, formatTimeLeft(left)].filter(Boolean).join(" · ");
    },
    setUploaded() {
      el.classList.remove("uploading");
      el.classList.add("uploaded");
      render();
      body.append(h("p", { class: "dz-done small" }, icon(I.check, 16), "Sent to VeoClone"));
    },
    setDisabled(d) {
      disabled = d;
      el.classList.toggle("disabled", d);
      for (const b of body.querySelectorAll("button")) b.disabled = d;
    },
  };
  return zone;
}

/** Sort dropped files onto the two zones: one file → this zone; two → left, right by name. */
export function assignFiles(files: File[], side: Side, zones: Record<Side, DropZone>, onReject: (msg: string) => void): void {
  const videos = files.filter(isVideoFile);
  if (videos.length === 0) {
    onReject("That doesn't look like a video file. Choose the .MOV or .MP4 file from the phone.");
    return;
  }
  if (videos.length >= 2) {
    const [a, b] = [...videos].sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }));
    zones.left.setFile(a);
    zones.right.setFile(b);
    if (videos.length > 2) onReject("Only two videos are used: one per phone.");
    return;
  }
  zones[side].setFile(videos[0]);
}
