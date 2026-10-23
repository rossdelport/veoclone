// "Mark the pitch": the user clicks round the pitch on a big whole-pitch
// overview (level, with the editor's Straighten picture values); VeoClone
// turns the outline into one polygon per camera for Reco's field ROI filter
// (engine/pitch.ts), so the AI camera ignores people outside the pitch.
import type { PitchOutline } from "../api";
import { buildRig, OverviewRenderer, overviewPointOfAim, pitchPolygons, type CalibInfo, type PitchPolygons, type YawPitch } from "../engine";
import { button } from "./common";
import { h, setChildren } from "./dom";
import { I } from "./icons";

/** Fewest corners the user must click (a pitch has four). */
export const MIN_PITCH_POINTS = 4;
const MAX_POINTS = 100;

export interface PitchToolOptions {
  calib: CalibInfo;
  /** The editor's straightening (radians), so the picture is level. */
  rigTilt: { tilt: number; roll: number };
  /** The preview video, showing the frame to mark on. */
  video: HTMLVideoElement;
  /** The saved outline, to start from. */
  existing: PitchOutline | null;
}

/**
 * Open the "Mark the pitch" dialog. Resolves with the outline to save,
 * "remove" when the user removes the saved one, or null when closed
 * without a change.
 */
export function markPitchDialog(opts: PitchToolOptions): Promise<PitchPolygons | "remove" | null> {
  return new Promise((resolve) => {
    const rig = buildRig(opts.calib, opts.rigTilt);
    // Overview points (render yaw/pitch for this straightening), in click order.
    let points: YawPitch[] = (opts.existing?.points ?? []).map(([yaw, pitch]) => overviewPointOfAim({ yaw, pitch }, rig));

    const canvas = h("canvas", { class: "overview-canvas" });
    const overlay = h("canvas", {
      class: "overview-overlay",
      "data-testid": "pitch-canvas",
      "aria-label": "The whole pitch. Click the corners of the pitch, going round it.",
    });
    const box = h("div", { class: "overview-box pitch-box" }, canvas, overlay);
    const status = h("p", { class: "small pitch-status", "aria-live": "polite" });
    const problem = h("div", { class: "pitch-problem" });
    const undo = button("Undo last point", () => change(points.slice(0, -1)), { icon: I.undo, class: "btn-small" });
    const restart = button("Start again", () => change([]), { variant: "ghost", class: "btn-small" });
    const remove = opts.existing
      ? button("Remove the outline", () => close("remove"), { variant: "ghost", class: "btn-small pitch-remove" })
      : null;
    const save = button("Save the outline", () => finish(), { variant: "primary" });

    const dialog = h(
      "dialog",
      { class: "dialog dialog-pitch", "aria-label": "Mark the pitch" },
      h("h2", null, "Mark the pitch"),
      h(
        "p",
        { class: "dialog-text pitch-help" },
        "Click the corners of the pitch, going round it. Where an edge of the grass looks curved, click a few more points along it so the outline follows it. Leave out the benches, the spectators and any pitch next door: the AI camera then ignores everyone outside the outline.",
      ),
      box,
      h("div", { class: "pitch-row" }, status, h("div", { class: "row" }, undo, restart, remove)),
      problem,
      h("div", { class: "dialog-actions" }, button("Cancel", () => close(null), { variant: "ghost" }), save),
    );

    let renderer: OverviewRenderer | null = null;
    const resize = new ResizeObserver(() => draw());
    const close = (result: PitchPolygons | "remove" | null) => {
      resize.disconnect();
      renderer?.dispose();
      // Free the WebGL context now rather than when the browser gets round to it.
      canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
      dialog.close();
      dialog.remove();
      resolve(result);
    };

    function change(next: YawPitch[]) {
      points = next.slice(0, MAX_POINTS);
      setChildren(problem);
      update();
      draw();
    }

    function update() {
      const n = points.length;
      status.textContent =
        n === 0
          ? "Click the first corner of the pitch."
          : n < MIN_PITCH_POINTS
            ? `${n} of at least ${MIN_PITCH_POINTS} points. Keep going round the pitch.`
            : `${n} points. Add more along curved edges, or save.`;
      undo.disabled = n === 0;
      restart.disabled = n === 0;
      save.disabled = n < MIN_PITCH_POINTS;
    }

    function draw() {
      if (!renderer) return;
      renderer.render();
      const dpr = window.devicePixelRatio || 1;
      const w = overlay.clientWidth;
      const hh = overlay.clientHeight;
      overlay.width = Math.round(w * dpr);
      overlay.height = Math.round(hh * dpr);
      const g = overlay.getContext("2d");
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, hh);
      const pts = points.map((p) => renderer!.yawPitchToCanvas(p.yaw, p.pitch));
      if (pts.length >= 3) {
        // Dim what the AI will ignore.
        const outline = new Path2D();
        pts.forEach((p, i) => (i ? outline.lineTo(p.x, p.y) : outline.moveTo(p.x, p.y)));
        outline.closePath();
        const dim = new Path2D();
        dim.rect(0, 0, w, hh);
        dim.addPath(outline);
        g.fillStyle = "rgba(4, 7, 11, 0.55)";
        g.fill(dim, "evenodd");
      }
      if (pts.length >= 2) {
        g.strokeStyle = "#34d399";
        g.lineWidth = 2;
        g.beginPath();
        pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        if (pts.length >= 3) g.closePath();
        g.stroke();
      }
      pts.forEach((p, i) => {
        g.fillStyle = i === 0 ? "#fbbf24" : "#34d399";
        g.strokeStyle = "#04070b";
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(p.x, p.y, i === 0 ? 6 : 5, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      });
    }

    function finish() {
      if (points.length < MIN_PITCH_POINTS) return;
      const result = pitchPolygons(points, rig);
      if (result.left.length < 3 && result.right.length < 3) {
        setChildren(problem, h("p", { class: "small text-bad" }, "This outline is not on the picture. Click on the corners of the grass."));
        return;
      }
      close(result);
    }

    overlay.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !renderer) return;
      const r = overlay.getBoundingClientRect();
      if (points.length >= MAX_POINTS) return;
      change([...points, renderer.canvasToYawPitch(e.clientX - r.left, e.clientY - r.top)]);
    });
    dialog.addEventListener("keydown", (e) => {
      if ((e.key === "Backspace" || e.key === "Delete" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z")) && points.length) {
        e.preventDefault();
        change(points.slice(0, -1));
      }
    });
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      close(null);
    });

    document.body.append(dialog);
    dialog.showModal();
    try {
      renderer = new OverviewRenderer(canvas, opts.calib, opts.rigTilt);
      const ex = renderer.extent;
      box.style.aspectRatio = String(Math.min(4, Math.max(1.5, (ex.yawMax - ex.yawMin) / (ex.pitchMax - ex.pitchMin))));
      renderer.updateVideoFrame(opts.video);
    } catch (e) {
      setChildren(problem, h("p", { class: "small text-bad" }, e instanceof Error ? e.message : String(e)));
    }
    resize.observe(box);
    update();
    draw();
  });
}
