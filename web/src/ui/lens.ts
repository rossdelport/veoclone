// "Which camera?" and "Which lens?": the two simple choices that pick the lens
// profile (docs/veoclone/DESIGN.md 4.6), once for both phones or once for
// each, and changing them after processing.
import { api, type LensOption, type ProjectMeta } from "../api";
import { confirmDialog, describeError, toast } from "./common";
import { h, setChildren } from "./dom";

export const DEFAULT_LENS = "generic:ultra";
const NOT_SURE = "Not sure";

const LENSES: Record<LensOption["lens"], { name: string; text: string }> = {
  ultra: { name: "Ultra wide (0.5×)", text: "Recommended. Together the two phones see the whole pitch." },
  main: { name: "Normal (1×)", text: "Only if the phones were not switched to 0.5×." },
  wide: { name: "Wide", text: "Recommended: the GoPro's Lens setting on Wide." },
  linear: { name: "Linear", text: "Only if the GoPro's Lens was set to Linear." },
  auto: { name: "Detect automatically", text: "" },
};

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
  return h("select", { class: "input", id: "lens-model", disabled: true, "aria-label": "Which camera?" }, h("option", null, text));
}

/** The two choices. `onChange` gets the chosen option's id. */
export function lensPicker(options: LensOption[], value: string | null, onChange: (id: string) => void, name = "lens"): HTMLElement {
  let current = initialLens(options, value);
  if (!current) return lensUnavailable();
  const models = [...new Set(options.map((o) => o.model))].sort((a, b) => Number(b === NOT_SURE) - Number(a === NOT_SURE));
  const note = h("p", { class: "muted small lens-note", "aria-live": "polite" });
  const showNote = () => (note.textContent = current!.note ?? (current!.model === NOT_SURE ? "VeoClone uses a typical recent iPhone." : ""));
  const lensLabel = h("p", { class: "field-label-small", id: `${name}-lens-label` }, "Which lens?");
  const lensGroup = h("div", { class: "choice-grid", role: "radiogroup", "aria-labelledby": `${name}-lens-label` });
  let radios: HTMLInputElement[] = [];
  /** The lens choices of the chosen camera (none for "detect automatically"). */
  const showLenses = () => {
    const lenses = options.filter((o) => o.model === current!.model && o.lens !== "auto").map((o) => o.lens);
    radios = lenses.map((lens) =>
      h("input", { type: "radio", name: `${name}-lens`, value: lens, checked: lens === current!.lens, onChange: () => pick(current!.model, lens) }),
    );
    setChildren(
      lensGroup,
      lenses.map((lens, i) => h("label", { class: "choice" }, radios[i], h("span", { class: "choice-body" }, h("strong", null, LENSES[lens].name), h("span", { class: "muted small" }, LENSES[lens].text)))),
    );
    lensLabel.hidden = lensGroup.hidden = lenses.length === 0;
  };
  const pick = (model: string, lens: LensOption["lens"]) => {
    const changed = model !== current!.model;
    current = options.find((o) => o.model === model && o.lens === lens) ?? options.find((o) => o.model === model) ?? current!;
    if (changed) showLenses();
    else for (const r of radios) r.checked = r.value === current.lens;
    showNote();
    onChange(current.id);
  };
  // Grouped: Not sure, then the iPhones, then the action cameras.
  const groups = [...new Set(models.map((m) => options.find((o) => o.model === m)?.group ?? ""))];
  const select = h(
    "select",
    { class: "input", id: `${name}-model`, onChange: () => pick(select.value, current!.lens) },
    groups.map((g) => {
      const items = models.filter((m) => (options.find((o) => o.model === m)?.group ?? "") === g).map((m) => h("option", { value: m }, m));
      return g ? h("optgroup", { label: g === "iPhone" ? "iPhones" : "GoPro and other action cameras" }, items) : items;
    }),
  );
  select.value = current.model;
  showLenses();
  showNote();
  return h(
    "div",
    { class: "lens-picker" },
    h("label", { class: "field-label-small", for: `${name}-model` }, "Which camera?"),
    select,
    lensLabel,
    lensGroup,
    note,
  );
}

/** The lenses of a match: one for both phones, or one for each. */
export interface PhoneLenses {
  lensId: string;
  /** null: the right phone is the same model as the left one. */
  rightLensId: string | null;
}

/**
 * The phone and lens choice for a match. Normally one choice for both
 * phones; with "The two phones are different models" ticked, one for the
 * left and one for the right phone. `onChange` gets both ids (rightLensId is
 * null while the box is not ticked).
 */
export function phonesPicker(
  options: LensOption[],
  value: { lensId: string | null; rightLensId?: string | null },
  onChange: (lenses: PhoneLenses) => void,
  name = "lens",
): HTMLElement {
  let left = initialLens(options, value.lensId)?.id ?? DEFAULT_LENS;
  let right = value.rightLensId ? (initialLens(options, value.rightLensId)?.id ?? null) : null;
  let two = right !== null;
  const emit = () => onChange({ lensId: left, rightLensId: two ? right : null });
  const leftHead = h("h3", { class: "phone-head" }, "Left phone");
  const leftPhone = h(
    "div",
    { class: "phone" },
    leftHead,
    lensPicker(options, left, (id) => {
      left = id;
      emit();
    }, name),
  );
  const rightPhone = h("div", { class: "phone", role: "group", "aria-label": "Right phone" });
  const show = () => {
    leftHead.hidden = !two;
    // Only a group of its own when there are two phones.
    if (two) {
      leftPhone.setAttribute("role", "group");
      leftPhone.setAttribute("aria-label", "Left phone");
    } else {
      leftPhone.removeAttribute("role");
      leftPhone.removeAttribute("aria-label");
    }
    rightPhone.hidden = !two;
    setChildren(rightPhone);
    if (!two) return;
    // Built afresh when shown: the earlier choice, else the same as the left phone.
    right ??= left;
    rightPhone.append(
      h("h3", { class: "phone-head" }, "Right phone"),
      lensPicker(options, right, (id) => {
        right = id;
        emit();
      }, `${name}-right`),
    );
  };
  const box = h("input", {
    type: "checkbox",
    checked: two,
    onChange: () => {
      two = box.checked;
      show();
      emit();
    },
  });
  show();
  return h(
    "div",
    { class: "phones-picker" },
    h("label", { class: "check phones-differ" }, box, "The two phones are different models"),
    leftPhone,
    rightPhone,
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
  const current: PhoneLenses = { lensId: initialLens(options, p.lensId)?.id ?? DEFAULT_LENS, rightLensId: p.rightLensId ?? null };
  let chosen = current;
  const ok = await confirmDialog({
    title: "Change phone or lens",
    text: [
      h("p", null, "If the picture looks bent, or the two halves don't join up, tell VeoClone which camera (iPhone or GoPro) and which lens filmed this match."),
      phonesPicker(options, p, (lenses) => (chosen = lenses), "change-lens"),
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
  if (chosen.lensId === p.lensId && chosen.rightLensId === current.rightLensId) {
    toast("This match already uses that phone and lens. Pick a different one to process it again.", "info", 6000);
    return false;
  }
  try {
    await api.updateProject(p.id, chosen);
    await api.process(p.id);
    return true;
  } catch (e) {
    toast(describeError(e).message, "error", 6000);
    return false;
  }
}
