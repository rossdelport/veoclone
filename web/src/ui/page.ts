export interface PageContext {
  /** The page's own area. */
  root: HTMLElement;
  /** Middle of the app bar, for page titles and actions. */
  slot: HTMLElement;
  /** Right end of the app bar, after the VeoClone status: the page's main action. */
  actions: HTMLElement;
  setTitle(title: string): void;
}

export interface Page {
  dispose(): void;
  /** A reason not to leave right now (shown in a confirm dialog), or null. */
  leaveWarning?(): string | null;
}
