// The editor's edits: undo/redo, the final camera path, autosave.
import { computeFinalPath, type CalibInfo, type Edits, type Keyframe } from "../engine";
import { debounce } from "./dom";

export type SaveState = "saved" | "pending" | "saving" | "error";

const MAX_UNDO = 200;

export class EditStore {
  edits: Edits;
  finalPath: Float32Array;
  saveState: SaveState = "saved";
  private undoStack: Edits[] = [];
  private redoStack: Edits[] = [];
  private lastMerge = { key: "", time: 0 };
  private listeners = new Set<() => void>();
  private saveListeners = new Set<(s: SaveState) => void>();
  private retryTimer = 0;
  private saving: Promise<void> | null = null;
  private dirty = false;
  private disposed = false;

  readonly recompute = debounce(() => {
    this.finalPath = computeFinalPath(this.ai, this.calib, this.edits);
    this.emit();
  }, 40);

  private readonly autosave = debounce(() => void this.save(), 1000);

  constructor(
    private readonly ai: Float32Array,
    private readonly calib: CalibInfo,
    initial: Edits,
    private readonly saveFn: (e: Edits) => Promise<void>,
  ) {
    this.edits = initial;
    this.finalPath = computeFinalPath(ai, calib, initial);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onSave(fn: (s: SaveState) => void): () => void {
    this.saveListeners.add(fn);
    fn(this.saveState);
    return () => this.saveListeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private setSaveState(s: SaveState) {
    this.saveState = s;
    for (const fn of this.saveListeners) fn(s);
  }

  /**
   * Change the edits with an undo point. Calls with the same `merge` key
   * within a second share one undo point (slider drags, typing). Pass
   * `moves = false` for changes that leave the camera path alone (text).
   */
  change(fn: (e: Edits) => void, merge = "", moves = true): void {
    const now = performance.now();
    if (!merge || merge !== this.lastMerge.key || now - this.lastMerge.time > 1000) {
      this.undoStack.push(structuredClone(this.edits));
      if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    }
    this.lastMerge = { key: merge, time: now };
    this.redoStack = [];
    const next = structuredClone(this.edits);
    fn(next);
    this.edits = next;
    this.changed(moves);
  }

  /** Export settings: saved, but no undo point and no new path. */
  setExport(exp: Edits["export"]): void {
    this.edits = { ...this.edits, export: { ...exp } };
    this.changed(false);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.edits);
    this.edits = { ...prev, export: this.edits.export };
    this.lastMerge = { key: "", time: 0 };
    this.changed(true);
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.edits);
    this.edits = { ...next, export: this.edits.export };
    this.lastMerge = { key: "", time: 0 };
    this.changed(true);
    return true;
  }

  /** The path for the current edits, computed now if a recompute is pending. */
  currentPath(): Float32Array {
    this.recompute.flush();
    return this.finalPath;
  }

  private changed(pathChanged: boolean) {
    if (pathChanged) this.recompute();
    else this.emit();
    this.dirty = true;
    if (this.saveState !== "saving") this.setSaveState("pending");
    this.autosave();
  }

  /** Save now (also used on leaving the page). */
  async save(): Promise<void> {
    this.autosave.cancel();
    clearTimeout(this.retryTimer);
    if (this.saving) {
      await this.saving;
      if (!this.dirty) return;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.setSaveState("saving");
    const snapshot = this.edits;
    this.saving = this.saveFn(snapshot)
      .then(() => {
        if (!this.disposed) this.setSaveState(this.dirty ? "pending" : "saved");
        if (this.dirty) this.autosave();
      })
      .catch(() => {
        this.dirty = true;
        if (this.disposed) return;
        this.setSaveState("error");
        this.retryTimer = window.setTimeout(() => void this.save(), 5000);
      })
      .finally(() => (this.saving = null));
    await this.saving;
  }

  get hasUnsaved(): boolean {
    return this.dirty || this.saving !== null;
  }

  dispose(): void {
    this.disposed = true;
    this.recompute.cancel();
    clearTimeout(this.retryTimer);
    if (this.dirty) void this.save();
    this.autosave.cancel();
    this.listeners.clear();
    this.saveListeners.clear();
  }
}

/** Add or replace the keyframe at k.frame, keeping the list sorted. */
export function upsertKeyframe(list: Keyframe[], k: Keyframe): Keyframe[] {
  return [...list.filter((x) => x.frame !== k.frame), k].sort((a, b) => a.frame - b.frame);
}
