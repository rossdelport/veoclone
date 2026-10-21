// Small shared pieces: buttons, progress bars, error boxes, toasts, dialogs.
import { ApiError } from "../api";
import { h, icon, type Child } from "./dom";
import { I } from "./icons";

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function button(
  label: Child,
  onClick: (e: MouseEvent) => void,
  opts: { variant?: Variant; icon?: string; title?: string; big?: boolean; disabled?: boolean; class?: string } = {},
): HTMLButtonElement {
  const cls = ["btn", `btn-${opts.variant ?? "secondary"}`, opts.big ? "btn-big" : "", opts.class ?? ""];
  return h(
    "button",
    {
      type: "button",
      class: cls.filter(Boolean).join(" "),
      title: opts.title,
      disabled: opts.disabled,
      onClick,
    },
    opts.icon ? icon(opts.icon, opts.big ? 22 : 18) : null,
    label === "" ? null : h("span", null, label),
  );
}

/** Square icon-only button with an accessible label. */
export function iconButton(iconPaths: string, label: string, onClick: (e: MouseEvent) => void, cls = ""): HTMLButtonElement {
  return h(
    "button",
    { type: "button", class: `btn btn-icon ${cls}`.trim(), title: label, "aria-label": label, onClick },
    icon(iconPaths, 20),
  );
}

export function progressBar(fraction: number, label: string): HTMLDivElement {
  const bar = h("div", {
    class: "progress",
    role: "progressbar",
    "aria-label": label,
    "aria-valuemin": "0",
    "aria-valuemax": "100",
  });
  bar.append(h("div", { class: "progress-fill" }));
  setProgress(bar, fraction);
  return bar;
}

export function setProgress(bar: HTMLElement, fraction: number): void {
  const pct = Math.round(Math.min(Math.max(Number.isFinite(fraction) ? fraction : 0, 0), 1) * 100);
  bar.setAttribute("aria-valuenow", String(pct));
  (bar.firstElementChild as HTMLElement).style.width = `${pct}%`;
}

/** Technical text tucked behind a "Show details" toggle. */
export function details(detail: string | undefined): Child {
  if (!detail) return null;
  return h("details", { class: "details" }, h("summary", null, "Show details"), h("pre", null, detail));
}

/** A friendly error message with optional technical details and actions. */
export function errorBox(message: string, detail?: string, ...actions: Child[]): HTMLDivElement {
  return h(
    "div",
    { class: "notice notice-error", role: "alert" },
    icon(I.alert, 22),
    h("div", { class: "notice-body" }, h("p", { class: "notice-title" }, message), details(detail), actions.length ? h("div", { class: "notice-actions" }, actions) : null),
  );
}

export function notice(kind: "warning" | "info" | "success", title: Child, ...body: Child[]): HTMLDivElement {
  return h(
    "div",
    { class: `notice notice-${kind}` },
    icon(kind === "success" ? I.check : kind === "info" ? I.info : I.alert, 22),
    h("div", { class: "notice-body" }, h("p", { class: "notice-title" }, title), body),
  );
}

/** Message and detail of anything thrown. */
export function describeError(e: unknown): { message: string; detail?: string } {
  if (e instanceof ApiError) return { message: e.message, detail: e.detail };
  if (e instanceof Error) return { message: "Something unexpected went wrong.", detail: `${e.message}\n${e.stack ?? ""}` };
  return { message: "Something unexpected went wrong.", detail: String(e) };
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export function toast(message: string, kind: "info" | "error" | "success" = "info", ms = 4000): void {
  let host = document.getElementById("toasts");
  if (!host) {
    host = h("div", { id: "toasts", "aria-live": "polite" });
    document.body.append(host);
  }
  const el = h("div", { class: `toast toast-${kind}`, role: kind === "error" ? "alert" : "status" }, message);
  host.append(el);
  setTimeout(() => {
    el.classList.add("toast-out");
    setTimeout(() => el.remove(), 300);
  }, ms);
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

/** A modal yes/no question. Resolves true when confirmed. `dismiss` labels the "no" button. */
export function confirmDialog(opts: { title: string; text: Child; confirm: string; dismiss?: string; danger?: boolean; wide?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = h("dialog", { class: opts.wide ? "dialog dialog-wide" : "dialog", "aria-label": opts.title });
    const close = (ok: boolean) => {
      dialog.close();
      dialog.remove();
      resolve(ok);
    };
    dialog.append(
      h("h2", null, opts.title),
      h("div", { class: "dialog-text" }, opts.text),
      h(
        "div",
        { class: "dialog-actions" },
        button(opts.dismiss ?? "Cancel", () => close(false), { variant: "ghost" }),
        button(opts.confirm, () => close(true), { variant: opts.danger ? "danger" : "primary" }),
      ),
    );
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      close(false);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}
