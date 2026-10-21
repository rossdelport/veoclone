// New match: name, iPhone model, camera style, the two videos, filming tips.
import { api, ApiError, uploadFile, type Lens, type ProjectMeta, type Side, type Style, type Upload } from "../api";
import { button, describeError, errorBox, toast } from "./common";
import { formatBytes, h, icon, setChildren } from "./dom";
import { assignFiles, dropZone, type DropZone } from "./dropzone";
import { currentHealth, onHelperState } from "./health";
import { I } from "./icons";
import type { Page, PageContext } from "./page";

export const STYLES: { id: Style; name: string; text: string }[] = [
  { id: "broadcast", name: "Broadcast", text: "Calm, TV-style camera that follows the play. Best for most matches." },
  { id: "action", name: "Action", text: "Follows the ball more closely and zooms in tighter on the action." },
  { id: "frame_all", name: "Wide", text: "Keeps all the players in the picture. Wider and steadier." },
];

/** Style picker: three big radio cards. */
export function stylePicker(value: Style, onChange: (s: Style) => void, name = "style"): HTMLElement {
  return h(
    "div",
    { class: "choice-grid", role: "radiogroup", "aria-label": "Camera style" },
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

/** "Which iPhone filmed this?" select, grouped by phone model. */
export function lensSelect(lenses: Lens[], value: string | null, onChange: (id: string | null) => void): HTMLSelectElement {
  const groups = new Map<string, Lens[]>();
  for (const l of lenses) {
    const model = l.label.split(" · ")[0];
    if (!groups.has(model)) groups.set(model, []);
    groups.get(model)!.push(l);
  }
  const select = h(
    "select",
    { class: "input", id: "lens", onChange: () => onChange(select.value || null) },
    h("option", { value: "" }, "Not sure (automatic)"),
    [...groups].map(([model, items]) =>
      h(
        "optgroup",
        { label: model },
        items.map((l) => h("option", { value: l.id }, l.label.split(" · ").slice(1).join(" · ") || l.label)),
      ),
    ),
  );
  select.value = value ?? "";
  return select;
}

export function filmingTips(): HTMLElement {
  const tips: [string, string][] = [
    ["Side by side, up high", "Put both phones next to each other on a tripod or fence, as high as you can, near the halfway line. Point one at each half of the pitch so the views overlap a little in the middle."],
    ["Use the 0.5× lens", "Choose the 0.5× (ultra wide) lens on both phones so together they see the whole pitch."],
    ["Landscape, 4K at 30 fps", "Hold the phones sideways. In Settings › Camera › Record Video choose 4K at 30 fps."],
    ["Turn HDR Video off", "In Settings › Camera › Record Video, switch off HDR Video, or the colours look washed out."],
    ["Start both together", "Press record on both phones within a few seconds of each other. VeoClone lines them up using the sound."],
    ["Keep them still", "Don't touch or move the phones while recording. Plug in power banks for a full match."],
    ["One video per phone", "If you stopped recording at half-time, make two matches: one for each half."],
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

/**
 * Upload the zones that have a new file, one after the other. Returns the
 * last ProjectMeta, or throws ApiError. `onUpload` receives the abortable
 * upload so the page can stop it.
 */
export async function sendVideos(
  id: string,
  zones: Record<Side, DropZone>,
  onUpload: (u: Upload | null) => void,
): Promise<ProjectMeta | null> {
  let meta: ProjectMeta | null = null;
  for (const side of ["left", "right"] as Side[]) {
    const file = zones[side].file;
    if (!file) continue;
    const up = uploadFile(id, side, file, (p) => zones[side].setUploading(p));
    onUpload(up);
    try {
      meta = await up.promise;
    } finally {
      onUpload(null);
      zones[side].setUploading(null);
    }
    zones[side].setUploaded();
  }
  return meta;
}

function defaultName(): string {
  return `Match ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}

export function newMatchPage(ctx: PageContext): Page {
  ctx.setTitle("New match");
  let style: Style = "broadcast";
  let lensId: string | null = null;
  let upload: Upload | null = null;
  let busy = false;
  let projectId: string | null = null;

  const nameInput = h("input", { class: "input input-big", id: "match-name", value: defaultName(), maxLength: 200, autocomplete: "off" });
  const lensHost = h("div", { class: "lens-host" }, h("select", { class: "input", disabled: true, "aria-label": "Which iPhone filmed this?" }, h("option", null, "Loading the list…")));
  const status = h("div", { class: "start-status", "aria-live": "polite" });
  const space = h("p", { class: "muted small space-info" });

  const zones = {} as Record<Side, DropZone>;
  const onFiles = (side: Side) => (files: File[]) => assignFiles(files, side, zones, (m) => toast(m, "error"));
  zones.left = dropZone({ side: "left", onFiles: onFiles("left"), onChange: update });
  zones.right = dropZone({ side: "right", onFiles: onFiles("right"), onChange: update });

  const swap = button("Swap left and right", () => {
    const l = zones.left.file;
    zones.left.setFile(zones.right.file);
    zones.right.setFile(l);
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
            h("label", { class: "field-label", for: "lens" }, "Which iPhone filmed this?"),
            h("p", { class: "muted small" }, "Pick your model and the lens you used (0.5× is called Ultra Wide). If yours isn't listed, pick the closest older model, or leave it on automatic."),
            lensHost,
          ),
          h(
            "section",
            { class: "card form-section" },
            h("h2", null, "Camera style"),
            h("p", { class: "muted small" }, "How the AI camera should move. You can fine-tune everything in the editor afterwards."),
            stylePicker(style, (s) => (style = s)),
          ),
          h("div", { class: "start-row" }, start, stop, status),
        ),
        filmingTips(),
      ),
    ),
  );

  function update() {
    const both = !!zones.left.file && !!zones.right.file;
    const health = currentHealth();
    start.disabled = busy || !both || !health;
    swap.hidden = !zones.left.file && !zones.right.file;
    swap.disabled = busy;
    const need = (zones.left.file?.size ?? 0) + (zones.right.file?.size ?? 0);
    if (need && health) {
      const needed = need * 1.15 + 500e6;
      space.textContent = `Space needed on your PC: about ${formatBytes(needed)} (you have ${formatBytes(health.freeDiskBytes)} free).`;
      space.classList.toggle("text-bad", health.freeDiskBytes > 0 && health.freeDiskBytes < needed);
    } else space.textContent = "";
    const same = both && zones.left.file!.name === zones.right.file!.name && zones.left.file!.size === zones.right.file!.size;
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
      const lenses = await api.lenses();
      setChildren(lensHost, lensSelect(lenses, lensId, (id) => (lensId = id)));
    } catch {
      setChildren(lensHost, h("select", { class: "input", id: "lens", disabled: true }, h("option", null, "Not sure (automatic)")));
    }
  }

  function setBusy(b: boolean) {
    busy = b;
    nameInput.disabled = b;
    zones.left.setDisabled(b);
    zones.right.setDisabled(b);
    stop.hidden = !b;
    for (const el of ctx.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".choice input, #lens")) el.disabled = b;
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
      if (!projectId) projectId = (await api.createProject({ name, lensId, style })).id;
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

  async function abort() {
    upload?.abort();
    if (projectId) {
      const id = projectId;
      projectId = null;
      await api.deleteProject(id).catch(() => undefined);
    }
  }

  void loadLenses();
  const unsubscribe = onHelperState(() => update());
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
