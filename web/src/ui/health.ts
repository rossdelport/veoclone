// Is the helper running? Polls /api/health and renders the status pill and
// the "VeoClone isn't running" banner shown on every page.
import { api, helperBase, DEFAULT_HELPER, type Health } from "../api";
import { button, toast } from "./common";
import { formatBytes, h, icon, setChildren } from "./dom";
import { I } from "./icons";
import { buildSha, updateText, versionText } from "./updates";

/** offline with `restarting`: VeoClone went away while installing an update and comes back by itself. */
export type HelperState = { kind: "checking" } | { kind: "online"; health: Health } | { kind: "offline"; restarting?: boolean };

/** How long after an update starts installing a missing VeoClone counts as restarting. */
const RESTART_GRACE_MS = 120_000;

const DOWNLOAD_URL = "https://github.com/rossdelport/veoclone/releases";

let state: HelperState = { kind: "checking" };
const listeners = new Set<(s: HelperState) => void>();
let timer = 0;
/** When VeoClone last said it was installing an update. */
let installingAt = 0;
/** The build seen last, to notice that VeoClone updated itself. */
let lastBuild: string | null = null;

export function helperState(): HelperState {
  return state;
}

export function currentHealth(): Health | null {
  return state.kind === "online" ? state.health : null;
}

/** Subscribe to changes; called once right away. Returns unsubscribe. */
export function onHelperState(fn: (s: HelperState) => void): () => void {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

export async function checkHelper(): Promise<void> {
  clearTimeout(timer);
  let next: HelperState;
  try {
    next = { kind: "online", health: await api.health() };
  } catch {
    next = Date.now() - installingAt < RESTART_GRACE_MS ? { kind: "offline", restarting: true } : { kind: "offline" };
  }
  if (next.kind === "online") {
    const update = next.health.update?.state;
    if (update === "installing") installingAt = Date.now();
    else installingAt = 0;
    const build = buildSha(next.health);
    if (build && lastBuild && build !== lastBuild) toast("VeoClone updated itself to the newest version.", "success", 8000);
    if (build) lastBuild = build;
  }
  const changed = next.kind !== state.kind || JSON.stringify(next) !== JSON.stringify(state);
  state = next;
  if (changed) for (const fn of listeners) fn(state);
  // Ask more often while an update is on its way, so "Updating…" shows.
  const updating = state.kind === "online" && ["checking", "downloading", "ready", "installing"].includes(state.health.update?.state ?? "");
  timer = window.setTimeout(checkHelper, state.kind !== "online" ? 3000 : updating ? 2000 : 10_000);
}

/** Small "Connected" pill for the app bar. */
export function renderPill(host: HTMLElement, s: HelperState): void {
  if (s.kind === "checking") {
    setChildren(host, h("span", { class: "pill pill-muted" }, h("span", { class: "dot" }), "Looking for VeoClone…"));
    return;
  }
  if (s.kind === "offline") {
    setChildren(
      host,
      s.restarting
        ? h("span", { class: "pill pill-muted" }, h("span", { class: "dot" }), "Restarting VeoClone…")
        : h("span", { class: "pill pill-bad" }, h("span", { class: "dot" }), "VeoClone not running"),
    );
    return;
  }
  const { gpu, ai } = s.health;
  const slow = ai.available && ai.provider === "CPU";
  const aiText = slow
    ? "AI on the main processor (slow)"
    : ai.available
      ? "AI ready on the graphics card"
      : ai.provider === "checking"
        ? "AI: checking…"
        : "AI not available";
  const where = helperBase !== DEFAULT_HELPER && helperBase !== location.origin ? `\nVeoClone address: ${helperBase}` : "";
  setChildren(
    host,
    h(
      "span",
      {
        class: `pill ${!slow && (ai.available || ai.provider === "checking") ? "pill-good" : "pill-warn"}`,
        title: `Connected to VeoClone ${versionText(s.health)}${s.health.update ? `\n${updateText(s.health.update)}` : ""}\nGraphics card: ${gpu.name || "checking…"}\n${aiText}\nFree disk space: ${formatBytes(s.health.freeDiskBytes)}${where}`,
      },
      h("span", { class: "dot" }),
      h("span", { class: "pill-main" }, "Connected"),
      // The important part first: the pill is cut short on small screens.
      h("span", { class: "pill-extra" }, slow ? ` · ${aiText} · ${gpu.name}` : ` · ${gpu.name || "checking graphics card…"} · ${aiText}`),
    ),
  );
}

/** Big banner with instructions while the helper is not running (empty otherwise). */
export function renderBanner(host: HTMLElement, s: HelperState): void {
  // An update restarts VeoClone: say so for those few seconds, on every page.
  if ((s.kind === "online" && s.health.update?.state === "installing") || (s.kind === "offline" && s.restarting)) {
    setChildren(
      host,
      h(
        "div",
        { class: "banner banner-info", role: "status", "data-testid": "update-banner" },
        icon(I.refresh, 22),
        h(
          "div",
          { class: "banner-body" },
          h("strong", null, s.kind === "online" ? "Updating VeoClone… it will restart in a moment." : "VeoClone is restarting after an update…"),
          " This page connects again by itself. Your matches and edits are safe.",
        ),
      ),
    );
    return;
  }
  if (s.kind !== "offline") {
    const h2 = s.kind === "online" ? s.health : null;
    if (h2 && !h2.ffmpeg) {
      setChildren(
        host,
        h(
          "div",
          { class: "banner banner-warn", role: "alert" },
          icon(I.alert, 22),
          h("div", null, h("strong", null, "Part of VeoClone is missing. "), "Please download VeoClone again and replace your copy. ", h("a", { href: DOWNLOAD_URL, target: "_blank", rel: "noopener" }, "Download VeoClone")),
        ),
      );
    } else {
      host.replaceChildren();
    }
    return;
  }
  const custom = helperBase !== DEFAULT_HELPER && helperBase !== location.origin;
  setChildren(
    host,
    h(
      "div",
      { class: "banner banner-bad", role: "alert", "data-testid": "helper-offline" },
      icon(I.cpu, 28),
      h(
        "div",
        { class: "banner-body" },
        h("h2", null, "VeoClone isn't running on this PC"),
        h(
          "ol",
          null,
          h("li", null, h("strong", null, "Open VeoClone.exe"), " on your PC (double-click it in the VeoClone folder) and keep its window open."),
          h("li", null, "Don't have it yet? ", h("a", { href: DOWNLOAD_URL, target: "_blank", rel: "noopener" }, "Download VeoClone"), ", unzip it, then open VeoClone.exe."),
          h(
            "li",
            null,
            "If the browser asks to let this page use apps and devices on your network, click ",
            h("strong", null, "Allow"),
            ". Clicked Block by mistake? Click the icon left of the web address, allow it again, then reload this page.",
          ),
          // The online editor needs that permission; the one VeoClone opens itself doesn't.
          location.origin !== DEFAULT_HELPER
            ? h("li", null, "Is the black VeoClone window already open? Use the editor that comes with it: ", h("a", { href: `${DEFAULT_HELPER}/` }, `${DEFAULT_HELPER}/`), ".")
            : null,
        ),
        h("p", { class: "muted small" }, "This page will connect by itself as soon as VeoClone is running.", custom ? ` (Looking at ${helperBase})` : ""),
      ),
      button("Check again", () => void checkHelper(), { icon: I.refresh }),
    ),
  );
}
