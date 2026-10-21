// "Which iPhone?" and "Which lens?": the two simple choices that pick the lens
// profile (docs/veoclone/DESIGN.md 4.6), and changing them after processing.
import { api, type LensOption, type ProjectMeta } from "../api";
import { confirmDialog, describeError, toast } from "./common";
import { h } from "./dom";

export const DEFAULT_LENS = "generic:ultra";
const NOT_SURE = "Not sure";

const LENSES: { lens: LensOption["lens"]; name: string; text: string }[] = [
  { lens: "ultra", name: "Ultra wide (0.5×)", text: "Recommended. Together the two phones see the whole pitch." },
  { lens: "main", name: "Normal (1×)", text: "Only if the phones were not switched to 0.5×." },
];

let cached: Promise<LensOption[]> | null = null;

/** The choices from VeoClone (asked once, and again after a failure). */
export function lensOptions(): Promise<LensOption[]> {
  if (!cached) {
    const p = api.lenses();
    cached = p;
    p.catch(() => {
      if (cached === p) cached = null;
    });
  }
  return cached;
}

/** The option the picker shows for a lensId (unknown or none: Not sure, Ultra wide). */
export function initialLens(options: LensOption[], value: string | null): LensOption | undefined {
  return options.find((o) => o.id === value) ?? options.find((o) => o.id === DEFAULT_LENS) ?? options[0];
}

/** Stand-in while the list can't be loaded; VeoClone then uses a typical iPhone lens. */
export function lensUnavailable(text = "Not sure"): HTMLElement {
  return h("select", { class: "input", id: "lens-model", disabled: true, "aria-label": "Which iPhone?" }, h("option", null, text));
}

/** The two choices. `onChange` gets the chosen option's id. */
export function lensPicker(options: LensOption[], value: string | null, onChange: (id: string) => void, name = "lens"): HTMLElement {
  let current = initialLens(options, value);
  if (!current) return lensUnavailable();
  const models = [...new Set(options.map((o) => o.model))].sort((a, b) => Number(b === NOT_SURE) - Number(a === NOT_SURE));
  const note = h("p", { class: "muted small lens-note", "aria-live": "polite" });
  const showNote = () => (note.textContent = current!.note ?? (current!.model === NOT_SURE ? "VeoClone uses a typical recent iPhone." : ""));
  const pick = (model: string, lens: LensOption["lens"]) => {
    current = options.find((o) => o.model === model && o.lens === lens) ?? options.find((o) => o.model === model) ?? current!;
    for (const r of radios) r.checked = r.value === current.lens;
    showNote();
    onChange(current.id);
  };
  const select = h(
    "select",
    { class: "input", id: `${name}-model`, onChange: () => pick(select.value, current!.lens) },
    models.map((m) => h("option", { value: m }, m)),
  );
  select.value = current.model;
  const radios = LENSES.map((l) =>
    h("input", { type: "radio", name: `${name}-lens`, value: l.lens, checked: l.lens === current!.lens, onChange: () => pick(current!.model, l.lens) }),
  );
  showNote();
  return h(
    "div",
    { class: "lens-picker" },
    h("label", { class: "field-label-small", for: `${name}-model` }, "Which iPhone?"),
    select,
    h("p", { class: "field-label-small", id: `${name}-lens-label` }, "Which lens?"),
    h(
      "div",
      { class: "choice-grid", role: "radiogroup", "aria-labelledby": `${name}-lens-label` },
      LENSES.map((l, i) => h("label", { class: "choice" }, radios[i], h("span", { class: "choice-body" }, h("strong", null, l.name), h("span", { class: "muted small" }, l.text)))),
    ),
    note,
  );
}

/**
 * "Change phone or lens" for a processed match: pick, confirm, then process
 * the match again with it. Resolves true once processing has started.
 */
export async function changeLens(p: ProjectMeta): Promise<boolean> {
  let options: LensOption[];
  try {
    options = await lensOptions();
  } catch (e) {
    toast(describeError(e).message, "error", 6000);
    return false;
  }
  let chosen = initialLens(options, p.lensId)?.id ?? DEFAULT_LENS;
  const ok = await confirmDialog({
    title: "Change phone or lens",
    text: [
      h("p", null, "If the picture looks bent, or the two halves don't join up, tell VeoClone which iPhone and which lens filmed this match."),
      lensPicker(options, p.lensId, (id) => (chosen = id), "change-lens"),
      h(
        "p",
        { class: "small" },
        "VeoClone then does all the processing again: it lines up the two videos and runs the AI again. This takes about as long as the first time, and the editor can't be used until it has finished. Your trims and camera fixes are kept; check them afterwards.",
      ),
    ],
    confirm: "Process again",
    wide: true,
  });
  if (!ok) return false;
  if (chosen === p.lensId) {
    toast("This match already uses that phone and lens. Pick a different one to process it again.", "info", 6000);
    return false;
  }
  try {
    await api.updateProject(p.id, { lensId: chosen });
    await api.process(p.id);
    return true;
  } catch (e) {
    toast(describeError(e).message, "error", 6000);
    return false;
  }
}
