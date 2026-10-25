// VeoClone updating itself (DESIGN.md 4.11): the "VeoClone on this PC" card
// on the home page (update status, Install now, the settings) and the words
// the app bar uses. Kept out of the way: only installing (a few seconds)
// shows on every page, see health.ts.
import { api, type Health, type HelperSettings, type UpdateStatus } from "../api";
import { button, describeError, details, progressBar, toast } from "./common";
import { h, icon, setChildren } from "./dom";
import { checkHelper, onHelperState } from "./health";
import { I } from "./icons";

export const DOWNLOAD_ZIP = "https://github.com/rossdelport/veoclone/releases/download/helper-latest/VeoClone-windows.zip";

function day(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** "version of 25 Oct 2026 (1a2b3c4)", "development build", or an old helper's "version 0.1.0". */
export function versionText(health: Health): string {
  const v = health.version;
  if (typeof v === "string") return `version ${v}`;
  if (!v.date) return "development build";
  return `version of ${day(v.date)} (${v.sha.slice(0, 7)})`;
}

/** The build's commit, when the helper says (not for development builds). */
export function buildSha(health: Health | null): string | null {
  const v = health?.version;
  return v && typeof v !== "string" && v.date ? v.sha : null;
}

/** One line in plain words about updates. */
export function updateText(u: UpdateStatus): string {
  switch (u.state) {
    case "up-to-date":
      return "VeoClone is up to date.";
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return `Downloading an update for VeoClone… ${Math.round((u.progress ?? 0) * 100)}%`;
    case "ready":
      return u.message ?? (u.auto ? "Update ready — it installs when nothing is processing." : "Update ready. Click Install now to restart VeoClone with it.");
    case "installing":
      return "Updating VeoClone… it will restart in a moment.";
    case "failed":
      return u.message ?? "VeoClone couldn't update itself. It will try again later.";
    case "disabled":
      return u.message ?? (u.auto ? "VeoClone doesn't update itself." : "Automatic updates are off.");
  }
}

/** The "VeoClone on this PC" card for the home page. Call dispose() when the page goes. */
export function updatesCard(): { el: HTMLElement; dispose(): void } {
  const status = h("div", { class: "update-status", "aria-live": "polite" });
  const toggles = h("div", { class: "update-toggles" });
  const el = h(
    "section",
    { class: "card updates-card", "data-testid": "veoclone-card", "aria-label": "VeoClone on this PC" },
    h("h2", null, "VeoClone on this PC"),
    status,
    toggles,
  );
  el.hidden = true;
  let settings: HelperSettings | null = null;
  let loading = false;
  let busy = false;
  let lastKey = "";
  let health: Health | null = null;

  async function loadSettings() {
    if (loading) return;
    loading = true;
    try {
      settings = await api.settings();
    } catch {
      settings = null;
    }
    loading = false;
    renderToggles();
  }

  async function change(body: Partial<HelperSettings>, done: string) {
    busy = true;
    renderToggles();
    try {
      settings = await api.changeSettings(body);
      toast(done, "success");
    } catch (e) {
      toast(describeError(e).message, "error", 6000);
    }
    busy = false;
    renderToggles();
    void checkHelper();
  }

  function renderToggles() {
    if (!settings || !health?.update) {
      toggles.replaceChildren();
      return;
    }
    const s = settings;
    const auto = h("input", {
      type: "checkbox",
      checked: s.autoUpdate,
      disabled: busy || !health.update.canUpdate,
      onChange: () =>
        void change({ autoUpdate: auto.checked }, auto.checked ? "VeoClone will update itself." : "Automatic updates are off. Use Check for updates to update by hand."),
    });
    const items: HTMLElement[] = [h("label", { class: "check" }, auto, "Update VeoClone automatically")];
    if (s.startWithWindows !== null) {
      const startup = h("input", {
        type: "checkbox",
        checked: s.startWithWindows,
        disabled: busy,
        onChange: () =>
          void change(
            { startWithWindows: startup.checked },
            startup.checked ? "VeoClone will start when Windows starts, in a minimised window." : "VeoClone will no longer start with Windows.",
          ),
      });
      items.push(
        h("label", { class: "check" }, startup, "Start VeoClone when Windows starts"),
        h("p", { class: "muted small toggle-note" }, "It then starts in a minimised window without opening the browser, ready whenever you open the editor."),
      );
    }
    setChildren(toggles, items);
  }

  async function act(what: () => Promise<unknown>) {
    try {
      await what();
    } catch (e) {
      toast(describeError(e).message, "error", 6000);
    }
    void checkHelper();
  }

  function renderStatus(hl: Health) {
    const u = hl.update;
    const version = h("p", { class: "muted small" }, `This is VeoClone ${versionText(hl)}.`);
    if (!u) {
      // A VeoClone from before it could update itself.
      setChildren(
        status,
        h(
          "div",
          { class: "update-line" },
          icon(I.info, 20),
          h(
            "p",
            null,
            "This copy of VeoClone doesn't update itself yet. Download the newest VeoClone once (your matches are kept): from then on it keeps itself up to date. ",
            h("a", { href: DOWNLOAD_ZIP, target: "_blank", rel: "noopener" }, "Download VeoClone"),
          ),
        ),
        version,
      );
      return;
    }
    const tone = u.state === "failed" ? "bad" : u.state === "up-to-date" ? "good" : u.state === "disabled" ? "muted" : "busy";
    const actions: HTMLElement[] = [];
    if (u.state === "ready") actions.push(button("Install now", () => void act(api.installUpdate), { variant: "primary", icon: I.refresh }));
    if (u.canUpdate && (u.state === "up-to-date" || u.state === "failed" || u.state === "disabled"))
      actions.push(button(u.state === "failed" ? "Try again" : "Check for updates", () => void act(api.checkForUpdate), { variant: "ghost", icon: I.refresh }));
    setChildren(
      status,
      h(
        "div",
        { class: `update-line update-${tone}`, "data-testid": "update-status", "data-state": u.state },
        icon(u.state === "failed" ? I.alert : u.state === "up-to-date" ? I.check : I.info, 20),
        h("p", null, updateText(u)),
        actions.length ? h("div", { class: "update-actions" }, actions) : null,
      ),
      u.state === "downloading" ? progressBar(u.progress ?? 0, "Downloading the update") : null,
      u.state === "failed" ? details(u.detail) : null,
      version,
    );
  }

  const unsubscribe = onHelperState((s) => {
    if (s.kind !== "online") return; // keep showing the last state while it restarts
    health = s.health;
    el.hidden = false;
    const key = JSON.stringify([s.health.version, s.health.update]);
    if (key === lastKey) return;
    lastKey = key;
    renderStatus(s.health);
    if (s.health.update && !settings) void loadSettings();
    else renderToggles();
  });

  return {
    el,
    dispose() {
      unsubscribe();
    },
  };
}
