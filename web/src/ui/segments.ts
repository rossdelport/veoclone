// Keep-range (trim) editing. Segments are sorted, non-overlapping keep-ranges
// in synced frames with an exclusive end. Every function returns a new list,
// or null when the change would leave nothing to keep.
import type { Segment } from "../engine";

function tidy(segs: Segment[]): Segment[] {
  const sorted = segs.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

const orNull = (segs: Segment[]): Segment[] | null => (segs.length ? segs : null);

/** The video starts at frame f: drop everything before it (or extend the first part back to f). */
export function setStart(segs: Segment[], f: number): Segment[] | null {
  if (!segs.length) return null;
  if (f < segs[0].start) return tidy([{ start: f, end: segs[0].end }, ...segs.slice(1)]);
  return orNull(tidy(segs.map((s) => ({ start: Math.max(s.start, f), end: s.end }))));
}

/** The video ends after frame f: drop everything after it (or extend the last part to f). */
export function setEnd(segs: Segment[], f: number): Segment[] | null {
  if (!segs.length) return null;
  const end = f + 1;
  const last = segs[segs.length - 1];
  if (end > last.end) return tidy([...segs.slice(0, -1), { start: last.start, end }]);
  return orNull(tidy(segs.map((s) => ({ start: s.start, end: Math.min(s.end, end) }))));
}

/** Remove frames [a, b) (either order). */
export function cutOut(segs: Segment[], a: number, b: number): Segment[] | null {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (hi <= lo) return segs.map((s) => ({ ...s }));
  const out: Segment[] = [];
  for (const s of segs) {
    if (s.end <= lo || s.start >= hi) out.push({ ...s });
    else {
      if (s.start < lo) out.push({ start: s.start, end: lo });
      if (s.end > hi) out.push({ start: hi, end: s.end });
    }
  }
  return orNull(tidy(out));
}

/** Keep frames [a, b) again. */
export function keep(segs: Segment[], a: number, b: number): Segment[] {
  return tidy([...segs.map((s) => ({ ...s })), { start: Math.min(a, b), end: Math.max(a, b) }]);
}

/** The parts that are cut out (including before the start and after the end). */
export function cutParts(segs: Segment[], frameCount: number): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const s of segs) {
    if (s.start > at) out.push({ start: at, end: s.start });
    at = Math.max(at, s.end);
  }
  if (at < frameCount) out.push({ start: at, end: frameCount });
  return out;
}

export function isKept(segs: Segment[], f: number): boolean {
  return segs.some((s) => f >= s.start && f < s.end);
}

/** First kept frame at or after f, or null. */
export function nextKept(segs: Segment[], f: number): number | null {
  for (const s of segs) {
    if (f < s.end) return Math.max(f, s.start);
  }
  return null;
}
