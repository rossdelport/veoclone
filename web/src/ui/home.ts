// Home: the list of matches.
import { api, isBusy, type ProjectMeta } from "../api";
import { button, confirmDialog, describeError, errorBox, progressBar, toast } from "./common";
import { formatBytes, formatDate, h, icon, setChildren } from "./dom";
import { onHelperState } from "./health";
import { I } from "./icons";
import type { Page, PageContext } from "./page";

/** Plain-words status of a match and a colour class. */
export function statusOf(p: ProjectMeta): { text: string; tone: "good" | "busy" | "warn" | "bad" | "muted"; progress?: number } {
  const exporting = p.exports.find((e) => e.status === "running" || e.status === "queued");
  if (p.status === "processing" && p.job) {
    const overall = (p.job.stepIndex + p.job.progress) / Math.max(1, p.job.stepCount);
    return { text: `Processing ${Math.round(overall * 100)}%`, tone: "busy", progress: overall };
  }
  if (p.status === "queued") return { text: "Waiting to start", tone: "busy", progress: 0 };
  if (exporting) return { text: `Making video ${Math.round(exporting.progress * 100)}%`, tone: "busy", progress: exporting.progress };
  switch (p.status) {
    case "ready":
      return { text: "Ready to edit", tone: "good" };
    case "failed":
      return { text: "Something went wrong", tone: "bad" };
    case "cancelled":
      return { text: "Stopped", tone: "muted" };
    case "uploaded":
      return { text: "Ready to process", tone: "warn" };
    default:
      return { text: "Videos missing", tone: "warn" };
  }
}

export function openHref(p: ProjectMeta): string {
  return p.status === "ready" ? `#/edit/${p.id}` : `#/project/${p.id}`;
}

export function homePage(ctx: PageContext): Page {
  ctx.setTitle("Your matches");
  const list = h("div", { class: "match-list", "aria-live": "polite" });
  ctx.root.append(
    h(
      "div",
      { class: "page page-home" },
      h(
        "div",
        { class: "page-head" },
        h("div", null, h("h1", null, "Your matches"), h("p", { class: "muted" }, "Two phone videos in, one follow-the-ball video out.")),
        button("New match", () => (location.hash = "#/new"), { variant: "primary", icon: I.plus, big: true }),
      ),
      list,
    ),
  );
  setChildren(list, h("div", { class: "skeleton-card" }), h("div", { class: "skeleton-card" }));

  let timer = 0;
  let disposed = false;
  let online = false;

  async function load() {
    clearTimeout(timer);
    if (!online) return;
    try {
      const projects = await api.listProjects();
      if (disposed) return;
      render(projects);
      timer = window.setTimeout(load, projects.some(isBusy) ? 1500 : 10_000);
    } catch (e) {
      if (disposed) return;
      const { message, detail } = describeError(e);
      setChildren(list, errorBox(message, detail, button("Try again", load)));
      timer = window.setTimeout(load, 5000);
    }
  }

  function render(projects: ProjectMeta[]) {
    if (projects.length === 0) {
      setChildren(
        list,
        h(
          "div",
          { class: "empty" },
          h("div", { class: "empty-art" }, icon(I.film, 40)),
          h("h2", null, "No matches yet"),
          h("p", { class: "muted" }, "Film a match with two phones side by side, then press New match to turn the two videos into one."),
          button("New match", () => (location.hash = "#/new"), { variant: "primary", icon: I.plus, big: true }),
        ),
      );
      return;
    }
    setChildren(list, projects.map(card));
  }

  function card(p: ProjectMeta): HTMLElement {
    const s = statusOf(p);
    const files = [p.files.left, p.files.right].filter(Boolean).length;
    const done = p.exports.filter((e) => e.status === "done").length;
    const facts = [formatDate(p.createdAt), files === 2 ? "2 videos" : `${files} of 2 videos`, formatBytes(p.diskBytes)];
    if (done) facts.push(`${done} finished video${done === 1 ? "" : "s"}`);
    const open = {
      ready: "Open editor",
      processing: "See progress",
      queued: "See progress",
      new: "Add videos",
      uploaded: "Continue",
      failed: "See what happened",
      cancelled: "Continue",
    }[p.status];
    return h(
      "article",
      { class: "match-card", "data-testid": "match-card" },
      h("a", { class: "match-thumb", href: openHref(p), "aria-hidden": "true", tabIndex: -1 }, h("div", { class: "pitch-art" })),
      h(
        "div",
        { class: "match-info" },
        h("h2", null, h("a", { href: openHref(p) }, p.name)),
        h("p", { class: "muted small" }, facts.join(" · ")),
        h("div", { class: "match-status" }, h("span", { class: `badge badge-${s.tone}` }, s.text)),
        s.progress !== undefined ? progressBar(s.progress, `${p.name}: ${s.text}`) : null,
      ),
      h(
        "div",
        { class: "match-actions" },
        h("a", { class: `btn ${p.status === "ready" ? "btn-primary" : "btn-secondary"}`, href: openHref(p) }, h("span", null, open)),
        h(
          "button",
          { type: "button", class: "btn btn-icon btn-ghost", title: `Delete ${p.name}`, "aria-label": `Delete ${p.name}`, onClick: () => remove(p) },
          icon(I.trash, 20),
        ),
      ),
    );
  }

  async function remove(p: ProjectMeta) {
    const ok = await confirmDialog({
      title: `Delete "${p.name}"?`,
      text: "This removes the match and its videos from VeoClone's folder on your PC, including any finished videos. Your original videos on the phones are not touched.",
      confirm: "Delete match",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteProject(p.id);
      toast(`"${p.name}" was deleted.`, "success");
    } catch (e) {
      toast(describeError(e).message, "error", 6000);
    }
    void load();
  }

  const unsubscribe = onHelperState((s) => {
    const wasOnline = online;
    online = s.kind === "online";
    if (online && !wasOnline) void load();
    if (s.kind === "offline") {
      clearTimeout(timer);
      setChildren(
        list,
        h("div", { class: "empty empty-quiet" }, h("h2", null, "Your matches will show here"), h("p", { class: "muted" }, "Matches are kept on your PC. Start VeoClone to see them.")),
      );
    }
  });

  return {
    dispose() {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
    },
  };
}
