// Timeline canvas: the whole match in lanes under a time ruler. Video: kept
// parts, cut parts and the camera's left/right movement. Fixes: the camera
// fixes (keyframes) and how long each acts. Text: a bar for each text box.
// The playhead runs through all of them. Zoomable (buttons, Ctrl+wheel) and
// scrollable (wheel when zoomed in).
import { formatFrameTime, type Edits, type Fps, type Overlay } from "../engine";
import { cutParts } from "./segments";

export interface TimelineModel {
  frameCount: number;
  fps: Fps;
  frame: number;
  edits: Edits;
  finalPath: Float32Array;
  yawRange: [number, number];
  selected: number | null;
  /** Id of the selected text box, or null. */
  selectedText: string | null;
  /** First frame of a cut being marked, or null. */
  cutStart: number | null;
}

export interface TimelineEvents {
  seek(frame: number, done: boolean): void;
  selectKeyframe(frame: number): void;
  /** A text box's bar was clicked at `frame` (inside the text's time). */
  selectOverlay(id: string, frame: number): void;
}

/** Heights (CSS px) of the ruler and the lanes, top to bottom; the editor labels the lanes. */
export const LANES = { ruler: 24, video: 44, fixes: 24, text: 24, gap: 4 } as const;
type Lane = "video" | "fixes" | "text";
/** Top of each lane. */
const TOP: Record<Lane, number> = {
  video: LANES.ruler + LANES.gap,
  fixes: LANES.ruler + LANES.gap * 2 + LANES.video,
  text: LANES.ruler + LANES.gap * 3 + LANES.video + LANES.fixes,
};
/** Height of the whole timeline canvas. */
export const TIMELINE_HEIGHT = TOP.text + LANES.text + LANES.gap;
const MIN_FRAMES_VISIBLE = 60;

// The light theme (styles.css): neutral lanes, ink marks, lime for what is selected.
const C = {
  bg: "#ffffff",
  lane: "#f4f4f6",
  tick: "#c8cad0",
  label: "#6a6e78",
  rulerLine: "#ececf0",
  kept: "#e4e5e9",
  keptEdge: "#d6d7dc",
  hatch: "#dcdde2",
  cutLabel: "#6a6e78",
  curve: "#5d616a",
  ink: "#111214",
  fixLine: "rgba(17, 18, 20, 0.22)",
  fixBand: "#e6e7eb",
  fixBandSelected: "#e4f6b4",
  text: "#2c2e33",
  textEmpty: "#b4b6bd",
  lime: "#c2f24a",
  pending: "rgba(17, 18, 20, 0.08)",
  scroll: "#e6e7eb",
  scrollThumb: "#9a9da6",
};

/** A rounded rectangle path (radius clamped to the size). */
function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.roundRect(x, y, w, h, rr);
}

export class Timeline {
  readonly canvas: HTMLCanvasElement;
  /** Visible window in frames [view0, view1). */
  view0 = 0;
  view1 = 1;
  private dragging = false;
  private resizeObserver: ResizeObserver;
  private model: TimelineModel | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly events: TimelineEvents,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "timeline-canvas";
    this.canvas.setAttribute("role", "slider");
    this.canvas.setAttribute("aria-label", "Timeline: click or drag to move through the match. Arrow keys move by one frame.");
    this.canvas.setAttribute("aria-valuemin", "0");
    this.canvas.tabIndex = 0;
    host.append(this.canvas);
    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(host);
    this.canvas.addEventListener("pointerdown", this.onDown);
    this.canvas.addEventListener("pointermove", this.onMove);
    this.canvas.addEventListener("pointerup", this.onUp);
    this.canvas.addEventListener("pointercancel", this.onUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
  }

  setModel(m: TimelineModel): void {
    const first = !this.model;
    const moved = m.frame !== this.model?.frame;
    this.model = m;
    if (first) this.fit();
    if (moved && (m.frame >= this.view1 || m.frame < this.view0)) {
      // Keep the playhead in view (page forward while playing).
      const span = this.view1 - this.view0;
      this.setView(m.frame - span * 0.1, m.frame + span * 0.9);
    }
    this.draw();
  }

  fit(): void {
    if (this.model) this.setView(0, this.model.frameCount);
  }

  /** Zoom by a factor around a frame (default: the playhead). */
  zoom(factor: number, around?: number): void {
    if (!this.model) return;
    const at = around ?? this.model.frame;
    const span = Math.min(this.model.frameCount, Math.max(MIN_FRAMES_VISIBLE, (this.view1 - this.view0) / factor));
    const t = (at - this.view0) / (this.view1 - this.view0);
    const start = at - t * span;
    this.setView(start, start + span);
    this.draw();
  }

  get zoomedIn(): boolean {
    return !!this.model && this.view1 - this.view0 < this.model.frameCount - 0.5;
  }

  private setView(a: number, b: number) {
    const n = this.model?.frameCount ?? 1;
    const span = Math.min(n, Math.max(Math.min(MIN_FRAMES_VISIBLE, n), b - a));
    let start = Math.min(Math.max(a, 0), n - span);
    if (!Number.isFinite(start)) start = 0;
    this.view0 = start;
    this.view1 = start + span;
  }

  private x(frame: number, w: number): number {
    return ((frame - this.view0) / (this.view1 - this.view0)) * w;
  }

  private frameAt(clientX: number): number {
    const r = this.canvas.getBoundingClientRect();
    const f = this.view0 + ((clientX - r.left) / r.width) * (this.view1 - this.view0);
    return Math.min(Math.max(Math.round(f), 0), (this.model?.frameCount ?? 1) - 1);
  }

  private keyframeNear(clientX: number, clientY: number): number | null {
    const m = this.model;
    if (!m) return null;
    const r = this.canvas.getBoundingClientRect();
    const y = clientY - r.top;
    if (y < TOP.fixes - 2 || y > TOP.fixes + LANES.fixes + 2) return null;
    let best: number | null = null;
    let bestD = 8;
    for (const k of m.edits.keyframes) {
      const d = Math.abs(this.x(k.frame, r.width) + r.left - clientX);
      if (d < bestD) {
        bestD = d;
        best = k.frame;
      }
    }
    return best;
  }

  /** The text bars: rows (overlapping texts on separate rows), the bar height and each row's top. */
  private textBars(overlays: Overlay[]) {
    const ends: number[] = [];
    const rows = new Map<string, number>();
    for (const o of [...overlays].sort((a, b) => a.start - b.start)) {
      let row = ends.findIndex((end) => end <= o.start);
      if (row < 0) row = ends.length;
      ends[row] = o.end;
      rows.set(o.id, row);
    }
    const gap = 2;
    const count = Math.max(1, ends.length);
    const barH = Math.max(3, Math.min(16, (LANES.text - 6 - gap * (count - 1)) / count));
    const first = TOP.text + (LANES.text - (count * barH + (count - 1) * gap)) / 2;
    return { rows, barH, top: (row: number) => first + row * (barH + gap) };
  }

  private overlayNear(clientX: number, clientY: number): Overlay | null {
    const m = this.model;
    if (!m) return null;
    const r = this.canvas.getBoundingClientRect();
    const y = clientY - r.top;
    if (y < TOP.text || y >= TOP.text + LANES.text) return null;
    const bars = this.textBars(m.edits.overlays);
    const x = clientX - r.left;
    // Later texts are drawn on top, so they win.
    for (const o of [...m.edits.overlays].reverse()) {
      const top = bars.top(bars.rows.get(o.id) ?? 0);
      const x0 = this.x(o.start, r.width);
      const x1 = Math.max(x0 + 3, this.x(o.end, r.width));
      if (x >= x0 - 3 && x <= x1 + 3 && y >= top - 2 && y <= top + bars.barH + 2) return o;
    }
    return null;
  }

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const k = this.keyframeNear(e.clientX, e.clientY);
    if (k !== null) {
      this.events.selectKeyframe(k);
      return;
    }
    const o = this.overlayNear(e.clientX, e.clientY);
    if (o) {
      this.events.selectOverlay(o.id, Math.min(Math.max(this.frameAt(e.clientX), o.start), o.end - 1));
      return;
    }
    this.dragging = true;
    this.canvas.setPointerCapture(e.pointerId);
    this.events.seek(this.frameAt(e.clientX), false);
  };

  private onMove = (e: PointerEvent) => {
    if (this.dragging) {
      this.events.seek(this.frameAt(e.clientX), false);
      return;
    }
    const near = this.keyframeNear(e.clientX, e.clientY) !== null || this.overlayNear(e.clientX, e.clientY) !== null;
    this.canvas.style.cursor = near ? "pointer" : "";
  };

  private onUp = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.dragging = false;
    this.events.seek(this.frameAt(e.clientX), true);
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.model) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      this.zoom(Math.exp(-e.deltaY * 0.002), this.frameAt(e.clientX));
    } else if (this.zoomedIn) {
      e.preventDefault();
      const span = this.view1 - this.view0;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      this.setView(this.view0 + (delta / this.canvas.clientWidth) * span, this.view1 + (delta / this.canvas.clientWidth) * span);
      this.draw();
    }
  };

  draw(): void {
    const m = this.model;
    const cv = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!m || w === 0 || h === 0) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
    }
    const g = cv.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, w, h);
    const fps = m.fps.num / m.fps.den;
    const lane = (name: Lane) => ({ top: TOP[name], h: LANES[name] });
    const video = lane("video");
    const fixes = lane("fixes");
    const text = lane("text");
    const span = (a: number, b: number) => [this.x(a, w), this.x(b, w)] as const;

    // Ruler.
    g.fillStyle = C.rulerLine;
    g.fillRect(0, LANES.ruler - 1, w, 1);
    const secondsVisible = (this.view1 - this.view0) / fps;
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const step = steps.find((s) => (s / secondsVisible) * w >= 80) ?? 3600;
    g.font = "11px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
    g.textBaseline = "middle";
    for (let s = Math.floor(this.view0 / fps / step) * step; s * fps <= this.view1; s += step) {
      const x = this.x(s * fps, w);
      g.fillStyle = C.tick;
      g.fillRect(Math.round(x), LANES.ruler - 9, 1, 8);
      for (let i = 1; i < 5; i++) g.fillRect(Math.round(this.x((s + (step * i) / 5) * fps, w)), LANES.ruler - 5, 1, 4);
      g.fillStyle = C.label;
      g.fillText(formatFrameTime(Math.round(s * fps), m.fps), x + 4, LANES.ruler / 2 - 2);
    }

    // Lane backgrounds.
    g.fillStyle = C.lane;
    for (const l of [video, fixes, text]) {
      roundRect(g, 0, l.top, w, l.h, 6);
      g.fill();
    }

    // Video: kept parts as clips, cut parts striped.
    for (const s of m.edits.segments) {
      const [x0, x1] = span(s.start, s.end);
      if (x1 < 0 || x0 > w) continue;
      roundRect(g, x0 + 0.5, video.top + 0.5, Math.max(1, x1 - x0 - 1), video.h - 1, 6);
      g.fillStyle = C.kept;
      g.fill();
      g.strokeStyle = C.keptEdge;
      g.lineWidth = 1;
      g.stroke();
    }
    for (const c of cutParts(m.edits.segments, m.frameCount)) {
      const [x0, x1] = span(c.start, c.end);
      if (x1 < 0 || x0 > w) continue;
      g.save();
      roundRect(g, x0, video.top, x1 - x0, video.h, 6);
      g.clip();
      g.strokeStyle = C.hatch;
      g.lineWidth = 1;
      g.beginPath();
      for (let x = x0 - video.h; x < x1; x += 7) {
        g.moveTo(x, video.top + video.h);
        g.lineTo(x + video.h, video.top);
      }
      g.stroke();
      if (x1 - x0 > 60) {
        const label = "Cut out";
        const lx = Math.max(x0, 0) + 8;
        const tw = g.measureText(label).width;
        g.fillStyle = C.lane;
        g.fillRect(lx - 4, video.top + 6, tw + 8, 15);
        g.fillStyle = C.cutLabel;
        g.fillText(label, lx, video.top + 14);
      }
      g.restore();
    }

    // Camera left/right movement (yaw: left of the pitch at the top).
    const [ymin, ymax] = m.yawRange;
    const n = Math.floor(m.finalPath.length / 3);
    if (n > 0 && ymax > ymin) {
      g.save();
      roundRect(g, 0, video.top, w, video.h, 6);
      g.clip();
      g.strokeStyle = C.curve;
      g.lineWidth = 1.25;
      g.beginPath();
      const pad = 7;
      for (let px = 0; px <= w; px += 2) {
        const f = Math.min(n - 1, Math.max(0, Math.round(this.view0 + (px / w) * (this.view1 - this.view0))));
        const yaw = m.finalPath[f * 3];
        const y = video.top + pad + ((ymax - yaw) / (ymax - ymin)) * (video.h - 2 * pad);
        if (px === 0) g.moveTo(px, y);
        else g.lineTo(px, y);
      }
      g.stroke();
      g.restore();
    }

    // Fixes: where each acts (hold + fade), a line through the video and a diamond.
    const reach = (m.edits.holdSeconds + m.edits.fadeSeconds) * fps;
    const cy = fixes.top + fixes.h / 2;
    for (const k of m.edits.keyframes) {
      const [x0, x1] = span(k.frame - reach, k.frame + reach);
      if (x1 < 0 || x0 > w) continue;
      roundRect(g, x0, cy - 5, x1 - x0, 10, 5);
      g.fillStyle = k.frame === m.selected ? C.fixBandSelected : C.fixBand;
      g.fill();
    }
    for (const k of m.edits.keyframes) {
      const x = this.x(k.frame, w);
      if (x < -8 || x > w + 8) continue;
      const sel = k.frame === m.selected;
      g.fillStyle = C.fixLine;
      g.fillRect(Math.round(x), video.top, 1, video.h);
      const r = sel ? 7 : 5.5;
      g.beginPath();
      g.moveTo(x, cy - r);
      g.lineTo(x + r, cy);
      g.lineTo(x, cy + r);
      g.lineTo(x - r, cy);
      g.closePath();
      g.fillStyle = sel ? C.lime : C.ink;
      g.fill();
      if (sel) {
        g.strokeStyle = C.ink;
        g.lineWidth = 1.5;
        g.stroke();
      }
    }

    // Text: a bar for each text box, with its first line when there is room.
    const bars = this.textBars(m.edits.overlays);
    g.save();
    roundRect(g, 0, text.top, w, text.h, 6);
    g.clip();
    for (const o of m.edits.overlays) {
      const x0 = this.x(o.start, w);
      const x1 = Math.max(x0 + 4, this.x(o.end, w));
      if (x1 < 0 || x0 > w) continue;
      const top = bars.top(bars.rows.get(o.id) ?? 0);
      const sel = o.id === m.selectedText;
      const words = o.text.trim();
      roundRect(g, x0, top, x1 - x0, bars.barH, Math.min(5, bars.barH / 2));
      g.fillStyle = sel ? C.lime : words ? C.text : C.textEmpty;
      g.fill();
      if (sel) {
        g.strokeStyle = C.ink;
        g.lineWidth = 1.25;
        g.stroke();
      }
      const name = words.split("\n")[0];
      if (name && bars.barH >= 12 && x1 - x0 > 36) {
        g.save();
        g.beginPath();
        g.rect(x0 + 6, top, x1 - x0 - 12, bars.barH);
        g.clip();
        g.fillStyle = sel ? C.ink : "#ffffff";
        g.fillText(name, Math.max(x0, 0) + 7, top + bars.barH / 2 + 0.5);
        g.restore();
      }
    }
    g.restore();

    // A cut being marked: from where it starts to the playhead.
    if (m.cutStart !== null) {
      const x0 = this.x(m.cutStart, w);
      const x1 = this.x(m.frame, w);
      g.fillStyle = C.pending;
      g.fillRect(Math.min(x0, x1), video.top, Math.abs(x1 - x0), video.h);
      g.fillStyle = C.ink;
      g.fillRect(Math.round(x0) - 1, video.top, 2, video.h);
      g.beginPath();
      g.moveTo(Math.round(x0) + 1, video.top);
      g.lineTo(Math.round(x0) + 8, video.top + 4);
      g.lineTo(Math.round(x0) + 1, video.top + 8);
      g.closePath();
      g.fill();
    }

    // Which part of the match is shown, when zoomed in (under the ruler).
    if (this.zoomedIn) {
      g.fillStyle = C.scroll;
      g.fillRect(0, LANES.ruler - 3, w, 3);
      g.fillStyle = C.scrollThumb;
      roundRect(g, (this.view0 / m.frameCount) * w, LANES.ruler - 3, Math.max(6, ((this.view1 - this.view0) / m.frameCount) * w), 3, 1.5);
      g.fill();
    }

    // Playhead: an ink line with a lime handle on the ruler.
    const px = Math.round(this.x(m.frame, w));
    g.fillStyle = C.ink;
    g.fillRect(px - 1, 6, 2, h - 6);
    g.beginPath();
    g.moveTo(px - 6, 2.5);
    g.lineTo(px + 6, 2.5);
    g.lineTo(px + 6, 11);
    g.lineTo(px, 16);
    g.lineTo(px - 6, 11);
    g.closePath();
    g.fillStyle = C.lime;
    g.fill();
    g.strokeStyle = C.ink;
    g.lineWidth = 1.5;
    g.stroke();

    this.canvas.setAttribute("aria-valuemax", String(m.frameCount - 1));
    this.canvas.setAttribute("aria-valuenow", String(m.frame));
    this.canvas.setAttribute("aria-valuetext", formatFrameTime(m.frame, m.fps));
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.canvas.remove();
  }
}
