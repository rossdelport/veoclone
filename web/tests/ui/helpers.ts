import { expect, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MOCK_PORT } from "../../playwright.config";

export const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dev/fixtures");
export const SHOTS = process.env.UI_SHOTS_DIR ?? "";

/** Open a route of the editor talking to the mock helper. */
export async function open(page: Page, hash: string, helper = MOCK): Promise<void> {
  await page.goto(`/?helper=${encodeURIComponent(helper)}#${hash}`);
}

export async function resetMock(seed = false): Promise<void> {
  const res = await fetch(`${MOCK}/__mock/reset${seed ? "?seed" : ""}`, { method: "POST" });
  expect(res.ok).toBe(true);
}

export interface MockState {
  projects: {
    id: string;
    name: string;
    status: string;
    lensId: string | null;
    rightLensId?: string | null;
    style: string;
    warnings: string[];
    files: { left?: { name: string }; right?: { name: string } };
    exports: { id: string; status: string }[];
  }[];
  edits: Record<
    string,
    {
      segments: { start: number; end: number }[];
      keyframes: { frame: number }[];
      zoom: number;
      smoothSeconds: number;
      overlays: { id: string; kind: string; text: string; position: string; size: string; start: number; end: number }[];
      straighten?: { tiltDeg: number; rollDeg: number };
      export: { width: number };
    }
  >;
  lastExport: null | {
    segments: { startFrame: number; endFrame: number }[];
    width: number;
    height: number;
    quality: string;
    path: { frames: number; finite: boolean; first: { yaw: number; pitch: number; fov: number } };
    /** Size of each text PNG and when it shows (seconds of the finished video). */
    overlays: { width: number; height: number; bytes: number; ranges: [number, number][] }[];
    /** Straighten picture, degrees. */
    rigTiltDeg?: number;
    rigRollDeg?: number;
  };
  editsPuts: number;
  openFolder: { project: string; export: string | null }[];
  swaps: number;
}

/** Change a match on the mock helper directly (like another browser tab would). */
export async function patchProject(id: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${MOCK}/api/projects/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect(res.ok).toBe(true);
}

export async function mockState(): Promise<MockState> {
  return (await (await fetch(`${MOCK}/__mock/state`)).json()) as MockState;
}

/** Screenshot for a human to look at, when UI_SHOTS_DIR is set. */
export async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** Wait until the camera view shows a picture (a black frame compresses to almost nothing). */
export async function expectPicture(page: Page): Promise<Buffer> {
  const view = page.getByTestId("camera-view");
  await expect(view.locator(".viewer-msg")).toBeHidden({ timeout: 30_000 });
  let png = Buffer.alloc(0);
  await expect(async () => {
    png = await view.screenshot();
    expect(png.length).toBeGreaterThan(40_000);
  }).toPass({ timeout: 20_000 });
  return png;
}
