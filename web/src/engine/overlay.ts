// Text overlays (DESIGN.md 5.4): the one drawing function used by both the
// editor's preview and the export, the defaults for new text boxes, and
// when each one shows in the finished video once the cut parts are gone.
import { frameToTime } from "./frames";
import type { Fps, Overlay, OverlayKind, OverlayPosition, OverlaySize, Segment } from "./types";

export const MAX_OVERLAYS = 50;
export const MAX_OVERLAY_TEXT = 200;
export const OVERLAY_KINDS: OverlayKind[] = ["title", "player", "text"];
export const OVERLAY_POSITIONS: OverlayPosition[] = [
  "top-left",
  "top-center",
  "top-right",
  "center",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];
export const OVERLAY_SIZES: OverlaySize[] = ["small", "medium", "large"];

/** Height of one line of text, as a fraction of the picture height. */
const LINE_HEIGHT: Record<OverlaySize, number> = { small: 0.035, medium: 0.05, large: 0.07 };
/** Gap between the box and the edges of the picture, as a fraction of its height. */
const MARGIN = 0.03;
/**
 * Text is laid out in a picture this high and then scaled, so it wraps the
 * same way in the small preview and in a 4K export.
 */
const REF_HEIGHT = 1080;
const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const BOX_COLOR = "rgba(8, 12, 18, 0.72)";
const TEXT_COLOR = "#ffffff";

export interface OverlayLayout {
  /** CSS font of the text. */
  font: string;
  lines: string[];
  lineHeight: number;
  box: { x: number; y: number; width: number; height: number; radius: number };
  align: "left" | "center" | "right";
  /** Lines are drawn at (textX, firstLineY + i * lineHeight) with textBaseline "middle". */
  textX: number;
  firstLineY: number;
}

/** Split text into lines no wider than `maxWidth` (line breaks kept, long words split). */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  for (const para of text.replace(/\r\n?/g, "\n").trim().split("\n")) {
    let line = "";
    for (const word of para.trim().split(/\s+/)) {
      const joined = line ? `${line} ${word}` : word;
      if (measure(joined) <= maxWidth) {
        line = joined;
        continue;
      }
      if (line) lines.push(line);
      // A word too long for a whole line is split between letters.
      let rest = Array.from(word);
      while (rest.length > 1 && measure(rest.join("")) > maxWidth) {
        let cut = rest.length - 1;
        while (cut > 1 && measure(rest.slice(0, cut).join("")) > maxWidth) cut--;
        lines.push(rest.slice(0, cut).join(""));
        rest = rest.slice(cut);
      }
      line = rest.join("");
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Where the box and its lines go in a picture of `width` x `height`, or null
 * when there is nothing to draw. `measure(text, font)` is a line's width.
 */
export function layoutOverlay(
  o: Pick<Overlay, "text" | "position" | "size">,
  width: number,
  height: number,
  measure: (text: string, font: string) => number,
): OverlayLayout | null {
  if (!(width > 0) || !(height > 0) || !o.text.trim()) return null;
  const lineHeight = (LINE_HEIGHT[o.size] ?? LINE_HEIGHT.medium) * height;
  const fontPx = lineHeight * 0.78;
  const font = `700 ${fontPx.toFixed(2)}px ${FONT_FAMILY}`;
  const padX = fontPx * 0.6;
  const padY = fontPx * 0.3;
  const margin = MARGIN * height;
  const maxWidth = Math.max(fontPx, width - 2 * margin - 2 * padX);
  const maxLines = Math.max(1, Math.floor((height - 2 * margin - 2 * padY) / lineHeight));
  const lines = wrapText(o.text, maxWidth, (s) => measure(s, font)).slice(0, maxLines);
  const boxW = Math.max(...lines.map((l) => measure(l, font))) + 2 * padX;
  const boxH = lines.length * lineHeight + 2 * padY;
  const [vertical, horizontal] = o.position === "center" ? ["center", "center"] : o.position.split("-");
  const x = horizontal === "left" ? margin : horizontal === "right" ? width - margin - boxW : (width - boxW) / 2;
  const y = vertical === "top" ? margin : vertical === "bottom" ? height - margin - boxH : (height - boxH) / 2;
  const align = horizontal === "left" ? "left" : horizontal === "right" ? "right" : "center";
  return {
    font,
    lines,
    lineHeight,
    box: { x, y, width: boxW, height: boxH, radius: fontPx * 0.32 },
    align,
    textX: align === "left" ? x + padX : align === "right" ? x + boxW - padX : x + boxW / 2,
    firstLineY: y + padY + lineHeight / 2,
  };
}

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Draw a text box on a picture of `width` x `height` (in the context's
 * units): white bold text on a rounded, see-through dark box. The editor's
 * preview and the export both use this, so they look the same.
 */
export function drawOverlay(ctx: Context2D, o: Pick<Overlay, "text" | "position" | "size">, width: number, height: number): void {
  if (!(width > 0) || !(height > 0)) return;
  const k = height / REF_HEIGHT;
  const layout = layoutOverlay(o, width / k, REF_HEIGHT, (text, font) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  });
  if (!layout) return;
  const { x, y, width: w, height: h, radius: r } = layout.box;
  ctx.save();
  ctx.scale(k, k);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = BOX_COLOR;
  ctx.fill();
  ctx.font = layout.font;
  ctx.fillStyle = TEXT_COLOR;
  ctx.textAlign = layout.align;
  ctx.textBaseline = "middle";
  layout.lines.forEach((line, i) => ctx.fillText(line, layout.textX, layout.firstLineY + i * layout.lineHeight));
  ctx.restore();
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sat 25 Oct 2026". */
export function formatOverlayDate(d: Date): string {
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** A new text box added with the playhead at `frame` (DESIGN.md 5.4 defaults). */
export function newOverlay(kind: OverlayKind, id: string, frame: number, frameCount: number, fps: Fps, today = new Date()): Overlay {
  const n = Math.max(1, Math.floor(frameCount));
  if (kind === "title") {
    return { id, kind, text: `Home team vs Away team\n${formatOverlayDate(today)}`, position: "top-center", size: "medium", start: 0, end: n };
  }
  const start = Math.min(Math.max(Math.round(frame), 0), n - 1);
  const end = Math.min(n, start + Math.max(1, Math.round((5 * fps.num) / fps.den)));
  return kind === "player"
    ? { id, kind, text: "#10 Player name", position: "bottom-left", size: "medium", start, end }
    : { id, kind, text: "Your text", position: "bottom-center", size: "medium", start, end };
}

/**
 * When an overlay shows in the exported video, as [start, end) in seconds:
 * its frames mapped through the kept segments, which are joined in order.
 * Pieces on both sides of a cut meet in the output, so they become one
 * range; an overlay entirely inside a cut has none.
 */
export function overlayOutputRanges(o: Pick<Overlay, "start" | "end">, segments: Segment[], fps: Fps): [number, number][] {
  const frames: [number, number][] = [];
  let at = 0; // output frame where this segment starts
  for (const s of segments) {
    const lo = Math.max(o.start, s.start);
    const hi = Math.min(o.end, s.end);
    if (hi > lo) {
      const a = at + lo - s.start;
      const b = at + hi - s.start;
      const last = frames[frames.length - 1];
      if (last && last[1] === a) last[1] = b;
      else frames.push([a, b]);
    }
    at += Math.max(0, s.end - s.start);
  }
  return frames.map(([a, b]) => [frameToTime(a, fps), frameToTime(b, fps)]);
}
