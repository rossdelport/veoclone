// Tiny DOM helpers: h() builds elements, plus formatting shared by the pages.

export type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown>;

/**
 * h("button", { class: "btn", onClick: fn, "aria-label": "Play" }, "Play")
 * Props starting with "on" become event listeners; `class` and `style`
 * (string) set className / cssText; aria-/data- and unknown names become
 * attributes; anything else is assigned as a property (value, checked…).
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  append(el, children); // first, so a <select>'s value can pick an option
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "class") {
      el.className = String(value);
    } else if (key === "style") {
      el.style.cssText = String(value);
    } else if (key.includes("-") || !(key in el)) {
      el.setAttribute(key, value === true ? "" : String(value));
    } else {
      (el as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(parent, c);
    else parent.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Replace all children of `el`. */
export function setChildren(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

/** Inline SVG icon from icons.ts path data. */
export function icon(paths: string, size = 20): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "icon");
  svg.innerHTML = paths;
  return svg;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 100 ? 0 : 1)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

/** "about 3 minutes left" style text. */
export function formatTimeLeft(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 10) return "a few seconds left";
  if (seconds < 60) return `about ${Math.round(seconds / 5) * 5} seconds left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? "" : "s"} left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `about ${hours} hour${hours === 1 ? "" : "s"}${rest ? ` ${rest} min` : ""} left`;
}

/** "1:02:03" or "2:03" for seconds. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds + 1e-9));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, "0");
  return hh > 0 ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

/** "1 h 32 min" / "12 min" / "45 s" for a length of video. */
export function formatLength(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Calls `fn` once `ms` after the last call. `flush()` runs a pending call now. */
export function debounce(fn: () => void, ms: number): { (): void; flush(): void; cancel(): void } {
  let timer = 0;
  let pending = false;
  const run = () => {
    clearTimeout(timer);
    if (!pending) return;
    pending = false;
    fn();
  };
  const call = () => {
    pending = true;
    clearTimeout(timer);
    timer = window.setTimeout(run, ms);
  };
  call.flush = run;
  call.cancel = () => {
    pending = false;
    clearTimeout(timer);
  };
  return call;
}
