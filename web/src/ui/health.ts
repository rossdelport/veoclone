// Is the helper running? Polls /api/health and renders the status pill and
// the "VeoClone isn't running" banner shown on every page.
import { api, helperBase, DEFAULT_HELPER, type Health } from "../api";
import { button } from "./common";
import { formatBytes, h, icon, setChildren } from "./dom";
import { I } from "./icons";

export type HelperState = { kind: "checking" } | { kind: "online"; health: Health } | { kind: "offline" };

const DOWNLOAD_URL = "https://github.com/rossdelport/veoclone/releases";

let state: HelperState = { kind: "checking" };
const listeners = new Set<(s: HelperState) => void>();
let timer = 0;

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
    next = { kind: "offline" };
  }
  const changed = next.kind !== state.kind || JSON.stringify(next) !== JSON.stringify(state);
  state = next;
  if (changed) for (const fn of listeners) fn(state);
  timer = window.setTimeout(checkHelper, state.kind === "online" ? 10_000 : 3000);
}

/** Small "Connected" pill for the app bar. */
export function renderPill(host: HTMLElement, s: HelperState): void {
  if (s.kind === "checking") {
    setChildren(host, h("span", { class: "pill pill-muted" }, h("span", { class: "dot" }), "Looking for VeoClone…"));
    return;
  }
  if (s.kind === "offline") {
    setChildren(host, h("span", { class: "pill pill-bad" }, h("span", { class: "dot" }), "VeoClone not running"));
    return;
  }
  const { gpu, ai } = s.health;
  const aiText = ai.available
    ? ai.provider === "CPU"
      ? "AI ready (slower: no graphics card)"
      : "AI ready on the graphics card"
    : ai.provider === "checking"
      ? "AI: checking…"
      : "AI not available";
  setChildren(
    host,
    h(
      "span",
      {
        class: `pill ${ai.available || ai.provider === "checking" ? "pill-good" : "pill-warn"}`,
        title: `Connected to VeoClone ${s.health.version}\nGraphics card: ${gpu.name || "checking…"} (${gpu.backend})\n${aiText} (${ai.provider})\nFree disk space: ${formatBytes(s.health.freeDiskBytes)}`,
      },
      h("span", { class: "dot" }),
      h("span", { class: "pill-main" }, "Connected"),
      h("span", { class: "pill-extra" }, ` · ${gpu.name || "checking graphics card…"} · ${aiText}`),
    ),
  );
}

/** Big banner with instructions while the helper is not running (empty otherwise). */
export function renderBanner(host: HTMLElement, s: HelperState): void {
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
          h("li", null, "If Chrome asks to allow access to devices on your network, click ", h("strong", null, "Allow"), "."),
        ),
        h("p", { class: "muted small" }, "This page will connect by itself as soon as VeoClone is running.", custom ? ` (Looking at ${helperBase})` : ""),
      ),
      button("Check again", () => void checkHelper(), { icon: I.refresh }),
    ),
  );
}
