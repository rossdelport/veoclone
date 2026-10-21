import { describe, expect, it } from "vitest";
import {
  drawOverlay,
  formatOverlayDate,
  layoutOverlay,
  MAX_OVERLAYS,
  newOverlay,
  overlayOutputRanges,
  wrapText,
} from "../../src/engine/overlay";
import { defaultEdits, normalizeEdits } from "../../src/engine/path";
import type { Fps, Overlay, Segment } from "../../src/engine/types";

const FPS: Fps = { num: 30, den: 1 };
const t = (frame: number, fps = FPS) => (frame * fps.den) / fps.num;
const seg = (start: number, end: number): Segment => ({ start, end });
const span = (start: number, end: number) => ({ start, end });

/** Text width like a real font: proportional to the font size in the CSS font string. */
const px = (font: string) => Number(/([\d.]+)px/.exec(font)![1]);
const measure = (text: string, font: string) => Array.from(text).length * px(font) * 0.55;

function overlay(patch: Partial<Overlay> = {}): Overlay {
  return { id: "o1", kind: "text", text: "Your text", position: "bottom-center", size: "medium", start: 0, end: 150, ...patch };
}

describe("overlayOutputRanges", () => {
  it("maps an overlay through an untouched video", () => {
    expect(overlayOutputRanges(span(0, 600), [seg(0, 600)], FPS)).toEqual([[0, 20]]);
    expect(overlayOutputRanges(span(90, 240), [seg(0, 600)], FPS)).toEqual([[3, 8]]);
  });

  it("moves with a trimmed start and is cut at the trims", () => {
    const segs = [seg(150, 540)];
    expect(overlayOutputRanges(span(200, 350), segs, FPS)).toEqual([[t(50), t(200)]]);
    expect(overlayOutputRanges(span(100, 160), segs, FPS)).toEqual([[0, t(10)]]); // starts before the start
    expect(overlayOutputRanges(span(500, 600), segs, FPS)).toEqual([[t(350), t(390)]]); // goes past the end
    expect(overlayOutputRanges(span(0, 600), segs, FPS)).toEqual([[0, t(390)]]);
  });

  it("joins the pieces on both sides of a cut into one range", () => {
    const segs = [seg(0, 100), seg(200, 300)];
    // Frames 50..99 then 200..249 follow each other in the video: output frames 50..149.
    expect(overlayOutputRanges(span(50, 250), segs, FPS)).toEqual([[t(50), t(150)]]);
    // Across two cuts.
    expect(overlayOutputRanges(span(50, 450), [seg(0, 100), seg(200, 300), seg(400, 500)], FPS)).toEqual([[t(50), t(250)]]);
  });

  it("drops an overlay entirely inside a cut", () => {
    const segs = [seg(0, 100), seg(200, 300)];
    expect(overlayOutputRanges(span(120, 180), segs, FPS)).toEqual([]);
    expect(overlayOutputRanges(span(100, 200), segs, FPS)).toEqual([]); // exactly the cut
    expect(overlayOutputRanges(span(320, 400), segs, FPS)).toEqual([]); // after the end
    expect(overlayOutputRanges(span(0, 50), [seg(60, 100)], FPS)).toEqual([]); // before the start
    expect(overlayOutputRanges(span(0, 50), [], FPS)).toEqual([]);
  });

  it("handles overlays that start or end right at a cut", () => {
    const segs = [seg(0, 100), seg(200, 300)];
    expect(overlayOutputRanges(span(150, 200), segs, FPS)).toEqual([]); // ends where the kept part starts
    expect(overlayOutputRanges(span(100, 150), segs, FPS)).toEqual([]); // starts where the kept part ends
    expect(overlayOutputRanges(span(99, 201), segs, FPS)).toEqual([[t(99), t(101)]]); // one frame each side
    expect(overlayOutputRanges(span(200, 230), segs, FPS)).toEqual([[t(100), t(130)]]); // first frame after the cut
    expect(overlayOutputRanges(span(70, 100), segs, FPS)).toEqual([[t(70), t(100)]]); // last frame before the cut
  });

  it("uses the exact frame rate", () => {
    const ntsc = { num: 30000, den: 1001 };
    expect(overlayOutputRanges(span(0, 30), [seg(0, 600)], ntsc)).toEqual([[0, 1.001]]);
  });
});

describe("new text boxes", () => {
  it("formats the date in plain English", () => {
    expect(formatOverlayDate(new Date(2026, 9, 24))).toBe("Sat 24 Oct 2026");
    expect(formatOverlayDate(new Date(2026, 0, 1))).toBe("Thu 1 Jan 2026");
  });

  it("has a match title over the whole video", () => {
    expect(newOverlay("title", "a", 300, 600, FPS, new Date(2026, 9, 24))).toEqual({
      id: "a",
      kind: "title",
      text: "Home team vs Away team\nSat 24 Oct 2026",
      position: "top-center",
      size: "medium",
      start: 0,
      end: 600,
    });
  });

  it("shows a player name or text for 5 seconds from the playhead", () => {
    expect(newOverlay("player", "b", 100, 600, FPS)).toEqual({
      id: "b",
      kind: "player",
      text: "#10 Player name",
      position: "bottom-left",
      size: "medium",
      start: 100,
      end: 250,
    });
    expect(newOverlay("text", "c", 100, 600, { num: 25, den: 1 })).toMatchObject({ text: "Your text", position: "bottom-center", start: 100, end: 225 });
  });

  it("stays inside the video near its end", () => {
    expect(newOverlay("text", "c", 590, 600, FPS)).toMatchObject({ start: 590, end: 600 });
    expect(newOverlay("text", "c", 900, 600, FPS)).toMatchObject({ start: 599, end: 600 });
  });
});

describe("wrapText", () => {
  const ten = (s: string) => Array.from(s).length * 10;
  it("wraps at spaces", () => {
    expect(wrapText("Home team vs Away team", 100, ten)).toEqual(["Home team", "vs Away", "team"]);
    expect(wrapText("Short", 100, ten)).toEqual(["Short"]);
  });
  it("keeps line breaks and drops blank lines around the text", () => {
    expect(wrapText("A\nB", 100, ten)).toEqual(["A", "B"]);
    expect(wrapText("A\r\n\r\nB", 100, ten)).toEqual(["A", "", "B"]);
    expect(wrapText("\n  A   b \n\n", 100, ten)).toEqual(["A b"]);
  });
  it("splits words that are too long, without breaking emoji", () => {
    expect(wrapText("abcdefghijkl", 50, ten)).toEqual(["abcde", "fghij", "kl"]);
    expect(wrapText("go ⚽⚽⚽", 20, ten)).toEqual(["go", "⚽⚽", "⚽"]);
  });
});

describe("layoutOverlay", () => {
  const W = 1920;
  const H = 1080;
  const margin = 0.03 * H;

  it("has nothing to draw for empty text", () => {
    expect(layoutOverlay(overlay({ text: "" }), W, H, measure)).toBeNull();
    expect(layoutOverlay(overlay({ text: " \n " }), W, H, measure)).toBeNull();
    expect(layoutOverlay(overlay(), 0, H, measure)).toBeNull();
  });

  it("sizes lines at 3.5 / 5 / 7 % of the height", () => {
    expect(layoutOverlay(overlay({ size: "small" }), W, H, measure)!.lineHeight).toBeCloseTo(0.035 * H);
    expect(layoutOverlay(overlay({ size: "medium" }), W, H, measure)!.lineHeight).toBeCloseTo(0.05 * H);
    expect(layoutOverlay(overlay({ size: "large" }), W, H, measure)!.lineHeight).toBeCloseTo(0.07 * H);
  });

  it("puts the box in the chosen place, 3 % of the height from the edges", () => {
    const at = (position: Overlay["position"]) => layoutOverlay(overlay({ position }), W, H, measure)!;
    const tl = at("top-left");
    expect(tl.box.x).toBeCloseTo(margin);
    expect(tl.box.y).toBeCloseTo(margin);
    expect(tl.align).toBe("left");
    expect(tl.textX).toBeGreaterThan(tl.box.x);
    const br = at("bottom-right");
    expect(br.box.x + br.box.width).toBeCloseTo(W - margin);
    expect(br.box.y + br.box.height).toBeCloseTo(H - margin);
    expect(br.align).toBe("right");
    expect(br.textX).toBeLessThan(br.box.x + br.box.width);
    const tc = at("top-center");
    expect(tc.box.x + tc.box.width / 2).toBeCloseTo(W / 2);
    expect(tc.textX).toBeCloseTo(W / 2);
    const c = at("center");
    expect(c.box.y + c.box.height / 2).toBeCloseTo(H / 2);
    const bl = at("bottom-left");
    expect(bl.box.x).toBeCloseTo(margin);
    expect(bl.box.y + bl.box.height).toBeCloseTo(H - margin);
  });

  it("stacks lines inside the box", () => {
    const l = layoutOverlay(overlay({ text: "Reds vs Blues\nSat 24 Oct 2026", position: "top-left" }), W, H, measure)!;
    expect(l.lines).toEqual(["Reds vs Blues", "Sat 24 Oct 2026"]);
    const padY = (l.box.height - 2 * l.lineHeight) / 2;
    expect(padY).toBeGreaterThan(0);
    expect(l.firstLineY).toBeCloseTo(l.box.y + padY + l.lineHeight / 2);
    // As wide as the longest line plus the padding on both sides.
    const padX = l.textX - l.box.x;
    expect(padX).toBeGreaterThan(0);
    expect(l.box.width).toBeCloseTo(measure("Sat 24 Oct 2026", l.font) + 2 * padX);
  });

  it("never gets wider or taller than the picture", () => {
    const long = layoutOverlay(overlay({ text: "word ".repeat(40), size: "large" }), W, H, measure)!;
    expect(long.lines.length).toBeGreaterThan(1);
    expect(long.box.x).toBeGreaterThanOrEqual(margin - 1e-6);
    expect(long.box.width).toBeLessThanOrEqual(W - 2 * margin + 1e-6);
    const tall = layoutOverlay(overlay({ text: "x\n".repeat(100), size: "large", position: "top-left" }), W, H, measure)!;
    expect(tall.box.y + tall.box.height).toBeLessThanOrEqual(H - margin + 1e-6);
  });

  it("scales with the picture, so preview and export match", () => {
    const o = overlay({ text: "#10 Player name with a long surname", position: "bottom-right", size: "large" });
    const a = layoutOverlay(o, W, H, measure)!;
    const b = layoutOverlay(o, 2 * W, 2 * H, measure)!;
    expect(b.lines).toEqual(a.lines);
    expect(b.box.x).toBeCloseTo(2 * a.box.x);
    expect(b.box.y).toBeCloseTo(2 * a.box.y);
    expect(b.box.width).toBeCloseTo(2 * a.box.width);
    expect(b.box.height).toBeCloseTo(2 * a.box.height);
  });
});

describe("drawOverlay", () => {
  /** A 2D context that records what is drawn. */
  function fakeContext() {
    const calls: string[] = [];
    const ctx = {
      font: "10px sans-serif",
      fillStyle: "",
      textAlign: "",
      textBaseline: "",
      measureText(s: string) {
        return { width: measure(s, this.font) };
      },
      save: () => calls.push("save"),
      restore: () => calls.push("restore"),
      scale: (x: number, y: number) => calls.push(`scale ${x.toFixed(3)} ${y.toFixed(3)}`),
      beginPath: () => calls.push("beginPath"),
      moveTo: () => undefined,
      arcTo: () => undefined,
      closePath: () => undefined,
      fill: () => calls.push("fill"),
      fillText(s: string) {
        calls.push(`text ${s} ${this.textAlign}`);
      },
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
  }

  it("draws the box, then each line, scaled to the picture", () => {
    const { ctx, calls } = fakeContext();
    drawOverlay(ctx, overlay({ text: "Reds vs Blues\nSat 24 Oct 2026", position: "top-left" }), 3840, 2160);
    expect(calls).toEqual(["save", "scale 2.000 2.000", "beginPath", "fill", "text Reds vs Blues left", "text Sat 24 Oct 2026 left", "restore"]);
  });

  it("draws nothing for empty text", () => {
    const { ctx, calls } = fakeContext();
    drawOverlay(ctx, overlay({ text: "  " }), 1920, 1080);
    drawOverlay(ctx, overlay(), 0, 0);
    expect(calls).toEqual([]);
  });
});

describe("normalizeEdits overlays", () => {
  const n = 600;
  it("defaults to none", () => {
    expect(defaultEdits(n).overlays).toEqual([]);
    expect(normalizeEdits({ overlays: "lots" }, n).overlays).toEqual([]);
  });

  it("keeps the valid ones and fixes what it can", () => {
    const out = normalizeEdits(
      {
        overlays: [
          overlay({ id: "ok" }),
          { ...overlay({ id: "clamped" }), start: -20.4, end: 9999 },
          { ...overlay({ id: "odd" }), kind: "banner", position: "middle-left", size: "huge" },
          { ...overlay({ id: "long" }), text: "x".repeat(250) },
          overlay({ id: "ok", text: "same id again" }),
          { ...overlay(), id: "" },
          { ...overlay({ id: "no-text" }), text: 42 },
          { ...overlay({ id: "nan" }), start: Number.NaN },
          overlay({ id: "empty-range", start: 50, end: 50 }),
          overlay({ id: "backwards", start: 80, end: 20 }),
          overlay({ id: "outside", start: 700, end: 800 }),
          null,
          "text",
        ],
      },
      n,
    );
    expect(out.overlays.map((o) => o.id)).toEqual(["ok", "clamped", "odd", "long"]);
    expect(out.overlays[0]).toEqual(overlay({ id: "ok" }));
    expect(out.overlays[1]).toMatchObject({ start: 0, end: n });
    expect(out.overlays[2]).toMatchObject({ kind: "text", position: "bottom-center", size: "medium" });
    expect(out.overlays[3].text).toHaveLength(200);
  });

  it("keeps at most 50", () => {
    const many = Array.from({ length: 60 }, (_, i) => overlay({ id: `o${i}` }));
    expect(normalizeEdits({ overlays: many }, n).overlays).toHaveLength(MAX_OVERLAYS);
  });
});
