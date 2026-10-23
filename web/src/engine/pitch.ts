// "Mark the pitch": the outline the user clicks on the whole-pitch overview,
// turned into the per-camera polygons Reco's field ROI filter uses
// (match.json `field_roi`: normalised [x, y] image coordinates of each
// camera, y = 0 at the top; reco-autocam roi_filter.rs drops a detection
// whose centre, or a person's feet, falls outside its camera's polygon).
//
// The outline is stored as aims (yaw/pitch of the directions the user
// clicked, rigtilt.ts), so it does not move when the straightening changes.
import { overviewRay, sampleRay, type Rig } from "./projection";
import { aimOfRender, renderOfAim, type YawPitch } from "./rigtilt";

export type Point2 = [number, number];

/** What PUT /api/projects/:id/pitch takes. */
export interface PitchPolygons {
  /** The outline as aims: [yaw, pitch] radians. */
  points: Point2[];
  /** Per camera: normalised image polygon (convex), or [] when that camera sees none of the pitch. */
  left: Point2[];
  right: Point2[];
}

/** Even-odd point-in-polygon test (the same rule as Reco's point_in_polygon). */
export function pointInPolygon(p: Point2, poly: Point2[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Convex hull (Andrew's monotone chain), counter-clockwise, no repeated or collinear points. */
export function convexHull(points: Point2[]): Point2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Point2, a: Point2, b: Point2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** The aim of an overview point (render yaw/pitch for this rig's straightening). */
export function aimOfOverviewPoint(p: YawPitch, rig: Rig): YawPitch {
  return aimOfRender(p, rig, rig.tilt);
}

/** The overview point (render yaw/pitch) that shows an aim. */
export function overviewPointOfAim(a: YawPitch, rig: Rig): YawPitch {
  return renderOfAim(a, rig, rig.tilt);
}

/** About this many sample directions inside the outline (plus its edges). */
const GRID = 120;
const EDGE_STEPS = 200;
/** Image coordinates are saved with this many decimals (well under a pixel at 4K). */
const DECIMALS = 5;

/**
 * The per-camera polygons for an outline clicked on the overview (`outline`:
 * overview points, i.e. render yaw/pitch for `rig`'s straightening, in the
 * order clicked). Samples a fine grid of directions inside the outline and
 * along its edges, finds where each lands in each camera (the renderer's own
 * maths, sampleRay) and keeps the convex hull per camera. A camera that sees
 * none of the outline gets [].
 */
export function pitchPolygons(outline: YawPitch[], rig: Rig): PitchPolygons {
  const poly: Point2[] = outline.map((p) => [p.yaw, p.pitch]);
  const seen: { left: Point2[]; right: Point2[] } = { left: [], right: [] };
  const add = (yaw: number, pitch: number) => {
    const s = sampleRay(overviewRay(yaw, pitch, rig), rig);
    if (s.left) seen.left.push([s.left.u, s.left.v]);
    if (s.right) seen.right.push([s.right.u, s.right.v]);
  };
  if (poly.length >= 3) {
    // Edges first, so the hull reaches the outline itself.
    for (let i = 0; i < poly.length; i++) {
      const [a, b] = [poly[i], poly[(i + 1) % poly.length]];
      for (let k = 0; k < EDGE_STEPS; k++) {
        const t = k / EDGE_STEPS;
        add(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
      }
    }
    const ys = poly.map((p) => p[0]);
    const ps = poly.map((p) => p[1]);
    const [y0, y1, p0, p1] = [Math.min(...ys), Math.max(...ys), Math.min(...ps), Math.max(...ps)];
    for (let j = 0; j <= GRID; j++) {
      for (let i = 0; i <= GRID; i++) {
        const q: Point2 = [y0 + ((y1 - y0) * i) / GRID, p0 + ((p1 - p0) * j) / GRID];
        if (pointInPolygon(q, poly)) add(q[0], q[1]);
      }
    }
  }
  const round = (v: number) => Number(v.toFixed(DECIMALS));
  const hull = (pts: Point2[]): Point2[] => {
    const h = convexHull(pts).map(([x, y]) => [round(x), round(y)] as Point2);
    return h.length >= 3 ? h : [];
  };
  return {
    points: outline.map((p) => {
      const a = aimOfOverviewPoint(p, rig);
      return [round(a.yaw), round(a.pitch)];
    }),
    left: hull(seen.left),
    right: hull(seen.right),
  };
}
