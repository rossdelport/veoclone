// The editor's "Text" section (DESIGN.md 5.4): add a match title, a player
// name or any text, then change its words, place, size and when it shows.
import {
  formatFrameTime,
  MAX_OVERLAY_TEXT,
  MAX_OVERLAYS,
  newOverlay,
  type Fps,
  type Overlay,
  type OverlayKind,
  type OverlayPosition,
  type OverlaySize,
} from "../engine";
import { button, iconButton, toast } from "./common";
import { h, setChildren } from "./dom";
import type { EditStore } from "./editStore";
import { I } from "./icons";

const ADD: { kind: OverlayKind; label: string; title: string }[] = [
  { kind: "title", label: "Match title", title: "Team names and today's date at the top, for the whole video" },
  { kind: "player", label: "Player name", title: "A player's number and name for 5 seconds from the playhead" },
  { kind: "text", label: "Text", title: "Your own words for 5 seconds from the playhead" },
];

/** The 3×3 place picker; the middle row only has the centre. */
const PLACES: (OverlayPosition | null)[] = [
  "top-left",
  "top-center",
  "top-right",
  null,
  "center",
  null,
  "bottom-left",
  "bottom-center",
  "bottom-right",
];
const PLACE_NAMES: Record<OverlayPosition, string> = {
  "top-left": "Top left",
  "top-center": "Top middle",
  "top-right": "Top right",
  center: "Middle",
  "bottom-left": "Bottom left",
  "bottom-center": "Bottom middle",
  "bottom-right": "Bottom right",
};
const SIZES: { id: OverlaySize; name: string }[] = [
  { id: "small", name: "Small" },
  { id: "medium", name: "Medium" },
  { id: "large", name: "Large" },
];

/** What the panel needs from the editor. */
export interface TextPanelHost {
  frameCount: number;
  fps: Fps;
  /** The playhead. */
  playhead(): number;
  /** Stop playing and move the playhead. */
  goTo(frame: number): void;
  /** The selected text changed (the timeline shows it). */
  selectionChanged(id: string | null): void;
}

let made = 0;
const newId = () => `t${Date.now().toString(36)}${(made++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** First line of a text box, for lists. */
export const textName = (o: Overlay) => o.text.trim().split("\n")[0].trim();

export class TextPanel {
  readonly el: HTMLElement;
  /** Id of the text box being changed, or null. */
  selected: string | null = null;
  private readonly addButtons: HTMLButtonElement[];
  private readonly list = h("div", { class: "text-list" });
  private readonly form: HTMLElement;
  private readonly words: HTMLTextAreaElement;
  private readonly places = new Map<OverlayPosition, HTMLButtonElement>();
  private readonly sizes = new Map<OverlaySize, HTMLInputElement>();
  private readonly when = h("p", { class: "small", "data-testid": "text-when" });
  private readonly offNote = h("p", { class: "small text-warn" }, "Not on screen at the playhead. Press Show from here to show it now.");
  private shown = "";

  constructor(
    private readonly store: EditStore,
    private readonly host: TextPanelHost,
  ) {
    this.addButtons = ADD.map((a) => button(a.label, () => this.add(a.kind), { icon: I.plus, title: a.title, class: "btn-small" }));
    this.words = h("textarea", {
      class: "input text-words",
      rows: 3,
      maxLength: MAX_OVERLAY_TEXT,
      "aria-label": "Words to show",
      "data-testid": "text-words",
      onInput: () => this.edit((o) => (o.text = this.words.value), `words:${this.selected}`),
      onKeydown: (e: KeyboardEvent) => {
        if (e.key === "Escape") this.words.blur();
      },
    });
    const grid = h(
      "div",
      { class: "place-grid", role: "group", "aria-label": "Where on the picture" },
      PLACES.map((p) => {
        if (!p) return h("span", null);
        const b = h("button", { type: "button", class: "place", title: PLACE_NAMES[p], "aria-label": PLACE_NAMES[p], onClick: () => this.edit((o) => (o.position = p)) }, h("span", null));
        this.places.set(p, b);
        return b;
      }),
    );
    const sizes = h(
      "div",
      { class: "seg seg-small", role: "radiogroup", "aria-label": "Text size" },
      SIZES.map((s) => {
        const input = h("input", { type: "radio", name: "text-size", onChange: () => this.edit((o) => (o.size = s.id)) });
        this.sizes.set(s.id, input);
        return h("label", null, input, h("span", null, s.name));
      }),
    );
    this.form = h(
      "div",
      { class: "text-form", "data-testid": "text-form" },
      h("label", { class: "text-label" }, "Words", this.words),
      h("p", { class: "muted small" }, "Press Enter for a new line."),
      h(
        "div",
        { class: "text-places" },
        h("div", null, h("span", { class: "text-label" }, "Place"), grid),
        h("div", { class: "grow" }, h("span", { class: "text-label" }, "Size"), sizes),
      ),
      h(
        "div",
        null,
        h("span", { class: "text-label" }, "When"),
        this.when,
        this.offNote,
        h(
          "div",
          { class: "row text-times" },
          button("Show from here", () => this.showFromHere(), { icon: I.start, class: "btn-small", title: "The text appears at the playhead" }),
          button("Hide from here", () => this.hideFromHere(), { icon: I.end, class: "btn-small", title: "The text goes away at the playhead" }),
        ),
      ),
      h(
        "div",
        { class: "row text-form-end" },
        button("Delete text", () => this.selected && this.remove(this.selected), { variant: "ghost", icon: I.trash, class: "btn-small" }),
        h("span", { class: "grow" }),
        button("Done", () => this.select(null), { class: "btn-small" }),
      ),
    );
    this.el = h(
      "section",
      { class: "side-section", "data-testid": "text-section" },
      h("h2", null, "Text"),
      h("div", { class: "row text-add" }, this.addButtons),
      this.list,
      this.form,
    );
    this.render();
  }

  private current(): Overlay | undefined {
    return this.store.edits.overlays.find((o) => o.id === this.selected);
  }

  private time(frame: number): string {
    return formatFrameTime(frame, this.host.fps);
  }

  /** Change the selected text box (no camera change, so no new camera path). */
  private edit(fn: (o: Overlay) => void, merge = "") {
    const id = this.selected;
    if (!id) return;
    this.store.change(
      (e) => {
        const o = e.overlays.find((x) => x.id === id);
        if (o) fn(o);
      },
      merge,
      false,
    );
  }

  private add(kind: OverlayKind) {
    if (this.store.edits.overlays.length >= MAX_OVERLAYS) return;
    const o = newOverlay(kind, newId(), this.host.playhead(), this.host.frameCount, this.host.fps);
    this.store.change((e) => e.overlays.push(o), "", false);
    this.select(o.id, false);
    // Ready to type over the first line.
    this.words.focus();
    const firstLine = o.text.indexOf("\n");
    this.words.setSelectionRange(0, firstLine < 0 ? o.text.length : firstLine);
  }

  private remove(id: string) {
    this.store.change((e) => (e.overlays = e.overlays.filter((o) => o.id !== id)), "", false);
    if (this.selected === id) this.select(null);
    toast("Text deleted. Undo brings it back.", "info", 2500);
  }

  private showFromHere() {
    const f = this.host.playhead();
    const n = this.host.frameCount;
    this.edit((o) => {
      const length = o.end - o.start;
      o.start = f;
      if (o.end <= f) o.end = Math.min(n, f + length);
    });
    toast(`The text now shows from ${this.time(f)}.`, "success", 2500);
  }

  private hideFromHere() {
    const o = this.current();
    if (!o) return;
    const f = this.host.playhead();
    if (f <= o.start) {
      toast(`This text starts at ${this.time(o.start)}. Move the playhead to where it should go away, then press Hide from here.`, "info", 5000);
      return;
    }
    this.edit((x) => (x.end = f));
    toast(`The text now goes away at ${this.time(f)}.`, "success", 2500);
  }

  /**
   * Select a text box to change it (null: none). With `jump`, the playhead
   * moves to its start unless it is already on screen.
   */
  select(id: string | null, jump = true): void {
    this.selected = id;
    const o = this.current();
    const f = this.host.playhead();
    if (o && jump && !(f >= o.start && f < o.end)) this.host.goTo(o.start);
    this.render();
    this.host.selectionChanged(id);
  }

  /** Delete the selected text box (the Delete key). */
  deleteSelected(): void {
    if (this.selected) this.remove(this.selected);
  }

  /** Show the current edits (after any change, undo or redo). */
  render(): void {
    const overlays = this.store.edits.overlays;
    if (this.selected && !this.current()) {
      this.selected = null;
      this.host.selectionChanged(null);
    }
    const full = overlays.length >= MAX_OVERLAYS;
    this.addButtons.forEach((b, i) => {
      b.disabled = full;
      b.title = full ? `You can add up to ${MAX_OVERLAYS} texts.` : ADD[i].title;
    });
    // Rebuild the list only when it changes, so its buttons stay put under the mouse.
    const key = JSON.stringify([overlays.map((o) => [o.id, o.text, o.start, o.end]), this.selected]);
    if (key !== this.shown) {
      this.shown = key;
      setChildren(
        this.list,
        overlays.length === 0
          ? h("p", { class: "muted small empty-small" }, "Add the team names and the date, a player's name, or your own words. They show on your video.")
          : h(
              "ul",
              { class: "texts" },
              overlays.map((o) =>
                h(
                  "li",
                  { class: o.id === this.selected ? "selected" : "" },
                  h(
                    "button",
                    { type: "button", class: "text-go", "aria-pressed": String(o.id === this.selected), onClick: () => this.select(o.id) },
                    h("span", { class: "text-dot" }),
                    h("span", { class: textName(o) ? "text-name" : "text-name muted" }, textName(o) || "Empty text"),
                    h("span", { class: "muted small nowrap" }, this.range(o)),
                  ),
                  iconButton(I.trash, `Delete the text “${textName(o) || "Empty text"}”`, () => this.remove(o.id), "btn-ghost btn-small"),
                ),
              ),
            ),
      );
    }
    this.syncForm();
  }

  private range(o: Overlay): string {
    if (o.start === 0 && o.end >= this.host.frameCount) return "Whole video";
    return `${this.time(o.start)} – ${this.time(o.end)}`;
  }

  private syncForm() {
    const o = this.current();
    this.form.hidden = !o;
    if (!o) return;
    // Never touch the box while the user types in it.
    if (document.activeElement !== this.words && this.words.value !== o.text) this.words.value = o.text;
    for (const [p, b] of this.places) b.setAttribute("aria-pressed", String(o.position === p));
    for (const [s, input] of this.sizes) input.checked = o.size === s;
    this.when.textContent =
      o.start === 0 && o.end >= this.host.frameCount ? "Shows for the whole video." : `Shows from ${this.time(o.start)} to ${this.time(o.end)}.`;
    this.playheadMoved(this.host.playhead());
  }

  /** The playhead moved: say when the selected text is not on screen. */
  playheadMoved(frame: number): void {
    const o = this.current();
    this.offNote.hidden = !o || (frame >= o.start && frame < o.end);
  }
}
