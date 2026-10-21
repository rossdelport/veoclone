// Timeline canvas: the whole match with kept parts, cut parts, fixes
// (keyframes), the camera's left/right movement, text boxes and the playhead.
// Zoomable (buttons, Ctrl+wheel) and scrollable (wheel when zoomed in).
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

const RULER = 22;
/** Lane for the text boxes, between the track and the fix markers. */
const TEXT = 18;
const MARKERS = 22;
const MIN_FRAMES_VISIBLE = 60;

const C = {
  bg: "#0d1218",
  ruler: "#121923",
  tick: "#3a4656",
  label: "#8b98a9",
  kept: "rgba(52, 211, 153, 0.20)",
  keptEdge: "#34d399",
  cut: "rgba(248, 113, 113, 0.10)",
  hatch: "rgba(248, 113, 113, 0.28)",
  cutLabel: "#fca5a5",
  curve: "rgba(125, 211, 252, 0.75)",
  fix: "#fbbf24",
  fixBand: "rgba(251, 191, 36, 0.12)",
  text: "#a78bfa",
  textSelected: "#ddd6fe",
  textLane: "#0a0e14",
  playhead: "#ffffff",
  pending: "#fb923c",
};

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
    if (clientY - r.top < r.height - MARKERS - 4) return null;
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

  /** The text bars: rows (overlapping texts on separate rows) and the bar height. */
  private textBars(overlays: Overlay[], h: number) {
    const ends: number[] = [];
    const rows = new Map<string, number>();
    for (const o of [...overlays].sort((a, b) => a.start - b.start)) {
      let row = ends.findIndex((end) => end <= o.start);
      if (row < 0) row = ends.length;
      ends[row] = o.end;
      rows.set(o.id, row);
    }
    const gap = 2;
    const barH = Math.max(2, Math.min(8, (TEXT - 4 - gap * (ends.length - 1)) / Math.max(1, ends.length)));
    const laneTop = h - MARKERS - TEXT;
    return { rows, barH, top: (row: number) => laneTop + 2 + row * (barH + gap) };
  }

  private overlayNear(clientX: number, clientY: number): Overlay | null {
    const m = this.model;
    if (!m) return null;
    const r = this.canvas.getBoundingClientRect();
    const y = clientY - r.top;
    if (y < r.height - MARKERS - TEXT || y >= r.height - MARKERS) return null;
    const bars = this.textBars(m.edits.overlays, r.height);
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
    const trackTop = RULER;
    const trackH = h - RULER - TEXT - MARKERS;
    const fps = m.fps.num / m.fps.den;

    // Ruler.
    g.fillStyle = C.ruler;
    g.fillRect(0, 0, w, RULER);
    const secondsVisible = (this.view1 - this.view0) / fps;
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const step = steps.find((s) => (s / secondsVisible) * w >= 80) ?? 3600;
    g.font = "11px system-ui, sans-serif";
    g.textBaseline = "middle";
    for (let s = Math.floor(this.view0 / fps / step) * step; s * fps <= this.view1; s += step) {
      const x = this.x(s * fps, w);
      g.fillStyle = C.tick;
      g.fillRect(Math.round(x), RULER - 7, 1, 7);
      for (let i = 1; i < 5; i++) g.fillRect(Math.round(this.x((s + (step * i) / 5) * fps, w)), RULER - 3, 1, 3);
      g.fillStyle = C.label;
      g.fillText(formatFrameTime(Math.round(s * fps), m.fps), x + 4, RULER / 2);
    }

    // Kept parts and cut parts.
    for (const s of m.edits.segments) {
      const x0 = this.x(s.start, w);
      const x1 = this.x(s.end, w);
      if (x1 < 0 || x0 > w) continue;
      g.fillStyle = C.kept;
      g.fillRect(x0, trackTop, x1 - x0, trackH);
      g.fillStyle = C.keptEdge;
      g.fillRect(x0, trackTop, x1 - x0, 2);
    }
    for (const c of cutParts(m.edits.segments, m.frameCount)) {
      const x0 = this.x(c.start, w);
      const x1 = this.x(c.end, w);
      if (x1 < 0 || x0 > w) continue;
      g.save();
      g.beginPath();
      g.rect(x0, trackTop, x1 - x0, trackH);
      g.clip();
      g.fillStyle = C.cut;
      g.fillRect(x0, trackTop, x1 - x0, trackH);
      g.strokeStyle = C.hatch;
      g.lineWidth = 1;
      g.beginPath();
      for (let x = x0 - trackH; x < x1; x += 8) {
        g.moveTo(x, trackTop + trackH);
        g.lineTo(x + trackH, trackTop);
      }
      g.stroke();
      if (x1 - x0 > 40) {
        g.fillStyle = C.cutLabel;
        g.fillText("Cut", Math.max(x0, 0) + 6, trackTop + 12);
      }
      g.restore();
    }

    // Where fixes act (hold + fade around each keyframe).
    const reach = (m.edits.holdSeconds + m.edits.fadeSeconds) * fps;
    g.fillStyle = C.fixBand;
    for (const k of m.edits.keyframes) {
      const x0 = this.x(k.frame - reach, w);
      const x1 = this.x(k.frame + reach, w);
      if (x1 >= 0 && x0 <= w) g.fillRect(x0, trackTop + 2, x1 - x0, trackH - 2);
    }

    // Camera left/right movement (yaw: left of the pitch at the top).
    const [ymin, ymax] = m.yawRange;
    const n = Math.floor(m.finalPath.length / 3);
    if (n > 0 && ymax > ymin) {
      g.strokeStyle = C.curve;
      g.lineWidth = 1.5;
      g.beginPath();
      const pad = 6;
      for (let px = 0; px <= w; px += 2) {
        const f = Math.min(n - 1, Math.max(0, Math.round(this.view0 + (px / w) * (this.view1 - this.view0))));
        const yaw = m.finalPath[f * 3];
        const y = trackTop + pad + ((ymax - yaw) / (ymax - ymin)) * (trackH - 2 * pad);
        if (px === 0) g.moveTo(px, y);
        else g.lineTo(px, y);
      }
      g.stroke();
    }

    // Text boxes: a bar for each, on the lane below the track.
    g.fillStyle = C.textLane;
    g.fillRect(0, trackTop + trackH, w, TEXT);
    const bars = this.textBars(m.edits.overlays, h);
    for (const o of m.edits.overlays) {
      const x0 = this.x(o.start, w);
      const x1 = Math.max(x0 + 3, this.x(o.end, w));
      if (x1 < 0 || x0 > w) continue;
      const top = bars.top(bars.rows.get(o.id) ?? 0);
      const sel = o.id === m.selectedText;
      g.fillStyle = sel ? C.textSelected : C.text;
      g.globalAlpha = o.text.trim() ? 1 : 0.4;
      g.fillRect(x0, top, x1 - x0, bars.barH);
      g.globalAlpha = 1;
      if (sel) {
        g.strokeStyle = "#fff";
        g.lineWidth = 1.5;
        g.strokeRect(x0 - 0.75, top - 0.75, x1 - x0 + 1.5, bars.barH + 1.5);
      }
    }

    // Fix markers.
    const my = h - MARKERS / 2;
    for (const k of m.edits.keyframes) {
      const x = this.x(k.frame, w);
      if (x < -8 || x > w + 8) continue;
      const sel = k.frame === m.selected;
      g.fillStyle = C.fix;
      g.globalAlpha = 0.55;
      g.fillRect(Math.round(x), trackTop, 1, trackH);
      g.globalAlpha = 1;
      const r = sel ? 7 : 5;
      g.beginPath();
      g.moveTo(x, my - r);
      g.lineTo(x + r, my);
      g.lineTo(x, my + r);
      g.lineTo(x - r, my);
      g.closePath();
      g.fill();
      if (sel) {
        g.strokeStyle = "#fff";
        g.lineWidth = 2;
        g.stroke();
      }
    }

    // A cut being marked.
    if (m.cutStart !== null) {
      const x0 = this.x(m.cutStart, w);
      const x1 = this.x(m.frame, w);
      g.fillStyle = "rgba(251, 146, 60, 0.18)";
      g.fillRect(Math.min(x0, x1), trackTop, Math.abs(x1 - x0), trackH);
      g.fillStyle = C.pending;
      g.fillRect(Math.round(x0) - 1, trackTop, 2, trackH);
    }

    // Which part of the match is shown, when zoomed in.
    if (this.zoomedIn) {
      g.fillStyle = "rgba(255, 255, 255, 0.07)";
      g.fillRect(0, h - 3, w, 3);
      g.fillStyle = "rgba(255, 255, 255, 0.45)";
      g.fillRect((this.view0 / m.frameCount) * w, h - 3, Math.max(4, ((this.view1 - this.view0) / m.frameCount) * w), 3);
    }

    // Playhead.
    const px = Math.round(this.x(m.frame, w));
    g.fillStyle = C.playhead;
    g.fillRect(px - 1, 4, 2, h - 4);
    g.beginPath();
    g.moveTo(px - 6, 2);
    g.lineTo(px + 6, 2);
    g.lineTo(px, 10);
    g.closePath();
    g.fill();

    this.canvas.setAttribute("aria-valuemax", String(m.frameCount - 1));
    this.canvas.setAttribute("aria-valuenow", String(m.frame));
    this.canvas.setAttribute("aria-valuetext", formatFrameTime(m.frame, m.fps));
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.canvas.remove();
  }
}
