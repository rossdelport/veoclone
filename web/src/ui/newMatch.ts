// New match: name, iPhone model, camera style, the two videos, filming tips.
import { api, ApiError, uploadFile, type AiAccuracy, type FileInfo, type ProjectMeta, type Side, type Style, type Upload } from "../api";
import { button, describeError, errorBox, notice, toast } from "./common";
import { formatBytes, h, icon, setChildren } from "./dom";
import { assignFiles, dropZone, type DropZone } from "./dropzone";
import { currentHealth, onHelperState } from "./health";
import { I } from "./icons";
import { DEFAULT_LENS, initialLens, lensOptions, lensUnavailable, phonesPicker } from "./lens";
import type { Page, PageContext } from "./page";

export const STYLES: { id: Style; name: string; text: string }[] = [
  { id: "broadcast", name: "Broadcast", text: "Calm, TV-style camera that follows the play. Best for most matches." },
  { id: "action", name: "Action", text: "Follows the ball more closely and zooms in tighter on the action." },
  { id: "frame_all", name: "Wide", text: "Keeps all the players in the picture. Wider and steadier." },
  { id: "ball", name: "Follow the ball", text: "Keeps the ball in the middle, at a fixed zoom. Try it when the camera wanders off to people next to the pitch." },
];

/** Style picker: four big radio cards. */
export function stylePicker(value: Style, onChange: (s: Style) => void, name = "style"): HTMLElement {
  return h(
    "div",
    { class: "choice-grid choice-grid-4", role: "radiogroup", "aria-label": "Camera style" },
    STYLES.map((s) =>
      h(
        "label",
        { class: "choice" },
        h("input", { type: "radio", name, value: s.id, checked: s.id === value, onChange: () => onChange(s.id) }),
        h("span", { class: "choice-body" }, h("strong", null, s.name), h("span", { class: "muted small" }, s.text)),
      ),
    ),
  );
}

export const ACCURACY: { id: AiAccuracy; name: string; text: string }[] = [
  {
    id: "best",
    name: "Best – check every frame (slower)",
    text: "The AI looks at every frame, so the camera reacts sooner and loses the ball less often. The AI step takes longer: up to 3 times as long.",
  },
  {
    id: "faster",
    name: "Faster – every 3rd frame",
    text: "The AI looks at every 3rd frame. Quicker, but the camera can react a little late to fast play.",
  },
];

/** "AI accuracy": every frame (default) or every 3rd frame. */
export function accuracyPicker(value: AiAccuracy | undefined, onChange: (a: AiAccuracy) => void, name = "accuracy"): HTMLElement {
  const current = value ?? "best";
  return h(
    "div",
    { class: "choice-grid", role: "radiogroup", "aria-label": "AI accuracy" },
    ACCURACY.map((a) =>
      h(
        "label",
        { class: "choice" },
        h("input", { type: "radio", name, value: a.id, checked: a.id === current, onChange: () => onChange(a.id) }),
        h("span", { class: "choice-body" }, h("strong", null, a.name), h("span", { class: "muted small" }, a.text)),
      ),
    ),
  );
}

export function filmingTips(): HTMLElement {
  const tips: [string, string][] = [
    ["Side by side, up high", "Put both phones next to each other on a tripod or fence, as high as you can, near the halfway line. Point one at each half of the pitch so the views overlap a little in the middle."],
    ["Two phones, same settings", "Two identical phones work best, but different iPhones are fine. Give both phones the settings below. If their videos still differ, VeoClone makes a matching copy first, which takes longer."],
    ["Use the 0.5× lens", "Choose the 0.5× (ultra wide) lens on both phones so together they see the whole pitch."],
    ["Landscape, 4K at 30 fps", "Hold the phones sideways. In Settings › Camera › Record Video choose 4K at 30 fps."],
    ["Turn HDR Video off", "In Settings › Camera › Record Video, switch off HDR Video, or the colours look washed out."],
    ["Turn Auto FPS off", "In Settings › Camera › Record Video, switch off Auto FPS (called Auto Low Light FPS on older iPhones). Otherwise the phones slow down in dim light or under floodlights, and the two halves drift out of step."],
    ["Start both together", "Press record on both phones within a few seconds of each other. VeoClone lines them up using the sound."],
    ["Keep them still", "Don't touch or move the phones while recording. Plug in power banks for a full match."],
    ["One recording per phone", "If you stopped recording at half-time, make two matches: one for each half."],
    [
      "Filming with GoPros?",
      "Use two identical GoPros, both set to 4K, 30 fps, 16:9, Lens: Wide, HyperSmooth: Off and Horizon Levelling: Off. Set Anti-Flicker to 50 Hz in the UK, Europe and Australia (60 Hz in North America). A GoPro saves a long recording as several files (GX010123.MP4, GX020123.MP4…): drop all the files from one camera into its box.",
    ],
  ];
  return h(
    "aside",
    { class: "tips card", "aria-label": "Filming tips" },
    h("h2", null, icon(I.info, 20), "Filming tips"),
    h(
      "ol",
      { class: "tip-list" },
      tips.map(([t, d]) => h("li", null, h("strong", null, t), h("span", { class: "muted" }, d))),
    ),
  );
}

/** VeoClone already has this file as part `index` (from 1) of a video in `count` parts. */
function partOnHelper(info: FileInfo | undefined, index: number, count: number, file: File): boolean {
  const part = info?.parts?.length === count ? info.parts[index - 1] : null;
  return !!part && part.name === file.name && part.sizeBytes === file.size;
}

/**
 * Upload the zones' new files, one after the other (a video in several
 * files part by part). Files already sent are skipped: on Try again after
 * a failure, and parts VeoClone already has from an earlier try (`meta`,
 * the match as VeoClone last reported it). Returns the last ProjectMeta,
 * or throws ApiError. `onUpload` receives the abortable upload so the page
 * can stop it.
 */
export async function sendVideos(
  id: string,
  zones: Record<Side, DropZone>,
  onUpload: (u: Upload | null) => void,
  meta: ProjectMeta | null = null,
): Promise<ProjectMeta | null> {
  for (const side of ["left", "right"] as Side[]) {
    const zone = zones[side];
    const files = zone.files;
    for (let i = 0; i < files.length; i++) {
      if (zone.sent(i)) continue; // already sent (Try again after a failure)
      const part = files.length > 1 ? { index: i + 1, count: files.length } : undefined;
      if (part && partOnHelper(meta?.files[side], part.index, part.count, files[i])) {
        zone.setSent(i);
        continue;
      }
      const up = uploadFile(id, side, files[i], (p) => zone.setUploading(p, i), part);
      onUpload(up);
      try {
        meta = await up.promise;
      } finally {
        onUpload(null);
        zone.setUploading(null);
      }
      zone.setSent(i);
    }
  }
  return meta;
}

/** Shown before and during processing when the AI can't use the graphics card. */
export function slowAiNotice(): HTMLElement {
  return notice(
    "warning",
    "The AI will run on the main processor, so processing takes much longer.",
    h("p", { class: "small" }, "VeoClone could not use the graphics card. Update the AMD graphics driver (AMD Software: Adrenalin Edition), restart the PC, then open VeoClone again."),
  );
}

function defaultName(): string {
  return `Match ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}

export function newMatchPage(ctx: PageContext): Page {
  ctx.setTitle("New match");
  let style: Style = "broadcast";
  let aiAccuracy: AiAccuracy = "best";
  let lensId: string | null = DEFAULT_LENS;
  let rightLensId: string | null = null; // the right phone is another model
  let lensesLoaded = false;
  let upload: Upload | null = null;
  let busy = false;
  let projectId: string | null = null;
  let stopping: Promise<void> = Promise.resolve();

  const nameInput = h("input", { class: "input input-big", id: "match-name", value: defaultName(), maxLength: 200, autocomplete: "off" });
  const lensHost = h("div", { class: "lens-host" }, lensUnavailable("Loading the list…"));
  const status = h("div", { class: "start-status", "aria-live": "polite" });
  const aiNote = h("div");
  const space = h("p", { class: "muted small space-info" });

  const zones = {} as Record<Side, DropZone>;
  const onFiles = (side: Side) => (files: File[]) => assignFiles(files, side, zones, (m) => toast(m, "error"));
  zones.left = dropZone({ side: "left", onFiles: onFiles("left"), onChange: update });
  zones.right = dropZone({ side: "right", onFiles: onFiles("right"), onChange: update });

  const swap = button("Swap left and right", () => {
    const l = zones.left.files;
    zones.left.setFiles(zones.right.files);
    zones.right.setFiles(l);
  }, { variant: "ghost", class: "btn-small swap" });

  const start = button("Start", () => void go(), { variant: "primary", big: true, icon: I.sparkle });
  const stop = button("Stop", () => void abort(), { variant: "ghost" });
  stop.hidden = true;

  ctx.root.append(
    h(
      "div",
      { class: "page page-new" },
      h("a", { class: "back-link", href: "#/" }, icon(I.back, 18), "Your matches"),
      h("h1", null, "New match"),
      h(
        "div",
        { class: "new-grid" },
        h(
          "div",
          { class: "new-main" },
          h(
            "section",
            { class: "card form-section" },
            h("label", { class: "field-label", for: "match-name" }, "Name of the match"),
            nameInput,
          ),
          h(
            "section",
            { class: "card form-section" },
            h("h2", null, "The two videos"),
            h("p", { class: "muted" }, "Stand behind the phones, facing the pitch: the left phone films the left half, the right phone the right half."),
            h("div", { class: "zones" }, zones.left.el, zones.right.el),
            h("div", { class: "zones-foot" }, swap, space),
          ),
          h(
            "section",
            { class: "card form-section" },
            h("h2", null, "Which camera and lens filmed this?"),
            h("p", { class: "muted small" }, "Two identical phones work best, but different iPhones are fine: tick the box and choose each phone. Not sure which iPhone? Leave it on Not sure. Filmed with GoPros? Choose “GoPro or other action camera – detect automatically”."),
            lensHost,
          ),
          h(
            "section",
            { class: "card form-section" },
            h("h2", null, "Camera style"),
            h("p", { class: "muted small" }, "How the AI camera should move. You can fine-tune everything in the editor afterwards."),
            stylePicker(style, (s) => (style = s)),
          ),
          h(
            "section",
            { class: "card form-section" },
            h("h2", null, "AI accuracy"),
            h("p", { class: "muted small" }, "How often the AI looks at the picture to find the ball and the players."),
            accuracyPicker(aiAccuracy, (a) => (aiAccuracy = a)),
          ),
          aiNote,
          h("div", { class: "start-row" }, start, stop, status),
        ),
        filmingTips(),
      ),
    ),
  );

  function update() {
    const [left, right] = [zones.left.files, zones.right.files];
    const both = left.length > 0 && right.length > 0;
    const health = currentHealth();
    start.disabled = busy || !both || !health;
    swap.hidden = !left.length && !right.length;
    swap.disabled = busy;
    const need = [...left, ...right].reduce((a, f) => a + f.size, 0);
    if (need && health) {
      const needed = need * 1.15 + 500e6;
      space.textContent = `Space needed on your PC: about ${formatBytes(needed)} (you have ${formatBytes(health.freeDiskBytes)} free).`;
      space.classList.toggle("text-bad", health.freeDiskBytes > 0 && health.freeDiskBytes < needed);
    } else space.textContent = "";
    setChildren(aiNote, health?.ai.provider === "CPU" ? slowAiNotice() : null);
    const key = (files: File[]) => files.map((f) => `${f.name}/${f.size}`).join("|");
    const same = both && key(left) === key(right);
    if (!busy) {
      setChildren(
        status,
        same ? h("p", { class: "text-warn small" }, "These look like the same video twice. Choose one video from each phone.") : null,
        !health ? h("p", { class: "muted small" }, "Start VeoClone on your PC first (see above).") : null,
        health && !both ? h("p", { class: "muted small" }, "Add both videos to start.") : null,
      );
    }
  }

  async function loadLenses() {
    try {
      const options = await lensOptions();
      lensId = initialLens(options, lensId)?.id ?? null;
      lensesLoaded = true;
      setChildren(
        lensHost,
        phonesPicker(options, { lensId, rightLensId }, (lenses) => {
          lensId = lenses.lensId;
          rightLensId = lenses.rightLensId;
        }),
      );
      if (busy) setBusy(true);
    } catch {
      setChildren(lensHost, lensUnavailable());
    }
  }

  function setBusy(b: boolean) {
    busy = b;
    nameInput.disabled = b;
    zones.left.setDisabled(b);
    zones.right.setDisabled(b);
    stop.hidden = !b;
    for (const el of ctx.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".choice input, .lens-host input, .lens-host select")) {
      el.disabled = b || (!lensesLoaded && el.closest(".lens-host") !== null);
    }
    update();
  }

  async function go() {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      toast("Please give the match a name.", "error");
      return;
    }
    setBusy(true);
    setChildren(status, h("p", { class: "small" }, "Sending your videos to VeoClone. Keep this page open."));
    try {
      await stopping; // a Stop that is still tidying up
      if (projectId) await api.updateProject(projectId, { name, lensId, rightLensId, style, aiAccuracy });
      else projectId = (await api.createProject({ name, lensId, rightLensId, style, aiAccuracy })).id;
      await sendVideos(projectId, zones, (u) => (upload = u));
      await api.process(projectId);
      busy = false;
      location.hash = `#/project/${projectId}`;
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.status === 499) {
        setChildren(status, h("p", { class: "muted small" }, "Stopped. Press Start to try again."));
        return;
      }
      const { message, detail } = describeError(e);
      setChildren(status, errorBox(message, detail, button("Try again", () => void go(), { variant: "primary" })));
    }
  }

  /** Stop sending and remove the half-made match (VeoClone refuses while it still sees the upload). */
  function abort(): Promise<void> {
    const u = upload;
    u?.abort();
    stopping = (async () => {
      await u?.promise.catch(() => undefined);
      const id = projectId;
      for (let i = 0; id && i < 10; i++) {
        try {
          await api.deleteProject(id);
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            await new Promise((r) => setTimeout(r, 300));
            continue;
          }
          if (!(e instanceof ApiError && e.status === 404)) return; // keep it: the next Start uses it
        }
        if (projectId === id) projectId = null;
        return;
      }
    })();
    return stopping;
  }

  // The list comes from VeoClone, so (again) as soon as it is running.
  const unsubscribe = onHelperState((s) => {
    update();
    if (s.kind === "online" && !lensesLoaded) void loadLenses();
  });
  update();
  nameInput.addEventListener("focus", () => nameInput.select(), { once: true });

  return {
    dispose() {
      unsubscribe();
      if (busy) void abort();
    },
    leaveWarning: () =>
      busy ? "Your videos are still being sent to VeoClone. If you leave now, the match will not be created." : null,
  };
}
