// End-to-end UI tests against the mock helper. See playwright.config.ts.
import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { expectPicture, FIXTURES, mockState, open, resetMock, shot } from "./helpers";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("page error:", e.message));
});

test("home lists matches and shows the helper as connected", async ({ page }) => {
  await resetMock(true);
  await open(page, "/");
  await expect(page.getByRole("heading", { name: "Your matches" })).toBeVisible();
  await expect(page.locator(".pill")).toContainText("Connected");
  const card = page.getByTestId("match-card");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Example match");
  await expect(card).toContainText("Ready to edit");
  await shot(page, "01-home");
});

test("empty home has a friendly first step", async ({ page }) => {
  await resetMock();
  await open(page, "/");
  await expect(page.getByRole("heading", { name: "No matches yet" })).toBeVisible();
});

test("shows how to start VeoClone when the helper is not running", async ({ page }) => {
  await open(page, "/", "http://127.0.0.1:47998");
  const banner = page.getByTestId("helper-offline");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("VeoClone isn't running on this PC");
  await expect(banner).toContainText("Open VeoClone.exe");
  await expect(banner).toContainText("click Allow");
  await expect(banner.getByRole("link", { name: "Download VeoClone" })).toHaveAttribute("href", "https://github.com/rossdelport/veoclone/releases");
  await expect(page.locator(".pill")).toContainText("not running");
  await shot(page, "02-offline");
});

async function createMatch(page: Page, name: string) {
  await open(page, "/new");
  await page.getByLabel("Name of the match").fill(name);
  await page.getByTestId("file-left").setInputFiles(path.join(FIXTURES, "left-small.mp4"));
  await page.getByTestId("file-right").setInputFiles(path.join(FIXTURES, "right-small.mp4"));
  await expect(page.locator(".dropzone[data-side=left]")).toContainText("left-small.mp4");
  await expect(page.locator(".dropzone[data-side=right]")).toContainText("right-small.mp4");
  await expect(page.locator(".dropzone[data-side=left]")).toContainText("long"); // duration read from the file
  // Lens list comes from the helper; pick the first real profile.
  const lens = page.locator("#lens");
  await expect(lens.locator("option")).not.toHaveCount(1);
  const first = await lens.locator("optgroup option").first().getAttribute("value");
  await lens.selectOption(first!);
  await page.getByText("Action", { exact: true }).click();
  await shot(page, "03-new-match");
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page).toHaveURL(/#\/project\/\w+/);
  return first!;
}

test("create a match, process it and open the editor", async ({ page }) => {
  await resetMock();
  const lensId = await createMatch(page, "Saturday league");
  await expect(page.locator(".steps")).toBeVisible();
  await expect(page.getByText("AI ball tracking")).toBeVisible();
  await expect(page.locator(".step-active, .step-done").first()).toBeVisible();
  await shot(page, "04-processing");
  await expect(page.getByRole("heading", { name: "Your match is ready" })).toBeVisible({ timeout: 30_000 });
  // Opens the editor by itself.
  await expect(page).toHaveURL(/#\/edit\/\w+/, { timeout: 10_000 });
  await expectPicture(page);
  const state = await mockState();
  expect(state.projects[0]).toMatchObject({ name: "Saturday league", lensId, style: "action", status: "ready" });
});

test("a failed step explains itself and Try again works", async ({ page }) => {
  await resetMock();
  await createMatch(page, "Please fail once, slowly"); // slow, so the failing step is seen
  const error = page.getByRole("alert").filter({ hasText: "couldn't line up" });
  await expect(error).toBeVisible({ timeout: 30_000 });
  // Technical detail only behind "Show details".
  await expect(page.getByText("calibrate_videos")).toBeHidden();
  await page.getByText("Show details").click();
  await expect(page.getByText("calibrate_videos")).toBeVisible();
  await expect(page.locator(".step-failed")).toContainText("Line up and join the videos");
  await shot(page, "05-failed");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page).toHaveURL(/#\/edit\/\w+/, { timeout: 60_000 });
});

test("cancel processing", async ({ page }) => {
  await resetMock();
  await createMatch(page, "Slow match to cancel");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Stop processing" }).click();
  await expect(page.getByText("Processing was stopped.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start again" })).toBeVisible();
});

async function openExample(page: Page) {
  await resetMock(true);
  const id = (await mockState()).projects[0].id;
  await open(page, `/edit/${id}`);
  await expectPicture(page);
  return id;
}

async function savedEdits(id: string) {
  await expect.poll(async () => (await mockState()).edits[id] !== undefined, { timeout: 10_000 }).toBe(true);
  return (await mockState()).edits[id];
}

/** Click the timeline at a fraction of its width. */
async function clickTimeline(page: Page, fraction: number) {
  const box = (await page.getByTestId("timeline").boundingBox())!;
  await page.mouse.click(box.x + box.width * fraction, box.y + 40);
}

test("editor: add, select, remove and undo camera fixes", async ({ page }) => {
  const id = await openExample(page);
  const view = page.getByTestId("camera-view");
  await expect(view.locator(".view-badge")).toHaveText("AI camera");
  const before = await view.screenshot();

  // Drag the picture: adds a fix at the playhead.
  await clickTimeline(page, 0.3);
  const box = (await view.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".fixes li")).toHaveCount(1);
  await expect(view.locator(".view-badge")).toHaveText("Your fix");
  expect((await view.screenshot()).equals(before)).toBe(false);

  // K adds a fix with the current view somewhere else.
  await clickTimeline(page, 0.8);
  await page.keyboard.press("k");
  await expect(page.locator(".fixes li")).toHaveCount(2);

  // Clicking in the whole-pitch overview points the camera there.
  await clickTimeline(page, 0.55);
  const ov = (await page.getByTestId("overview").boundingBox())!;
  await page.mouse.click(ov.x + ov.width * 0.45, ov.y + ov.height * 0.5);
  await expect(page.locator(".fixes li")).toHaveCount(3);
  await shot(page, "06-editor-fixes");

  // Delete removes the selected fix; Ctrl+Z brings it back.
  await page.keyboard.press("Delete");
  await expect(page.locator(".fixes li")).toHaveCount(2);
  await page.keyboard.press("Control+z");
  await expect(page.locator(".fixes li")).toHaveCount(3);

  // Autosaved to the helper.
  await expect(page.getByTestId("save-state")).toHaveText("All changes saved", { timeout: 10_000 });
  const edits = await savedEdits(id);
  expect(edits.keyframes).toHaveLength(3);
});

test("editor: trim the start and end and cut out a section", async ({ page }) => {
  const id = await openExample(page);
  const kept = page.getByTestId("kept-length");
  await expect(kept).toHaveText("0:20");

  await clickTimeline(page, 0.1);
  await page.getByRole("button", { name: "Set start here" }).click();
  await clickTimeline(page, 0.9);
  await page.getByRole("button", { name: "Set end here" }).click();
  await expect(kept).toHaveText("0:16");

  // Cut out a section in the middle.
  await clickTimeline(page, 0.4);
  await page.getByRole("button", { name: "Cut out a section" }).click();
  await clickTimeline(page, 0.6);
  await page.getByRole("button", { name: "Cut to here" }).click();
  await expect(kept).toHaveText("0:12");
  await expect(page.locator(".cuts li")).toHaveCount(3);
  await shot(page, "07-editor-trim");

  // Put the middle back.
  await page.locator(".cuts li").nth(1).getByRole("button", { name: "Put back" }).click();
  await expect(kept).toHaveText("0:16");
  await page.keyboard.press("Control+z");
  await expect(kept).toHaveText("0:12");

  await expect(page.getByTestId("save-state")).toHaveText("All changes saved", { timeout: 10_000 });
  const edits = await savedEdits(id);
  expect(edits.segments).toHaveLength(2);
  expect(edits.segments[0].start).toBeGreaterThan(40);
  expect(edits.segments[1].end).toBeLessThan(560);
});

test("editor: playback, frame steps and sliders", async ({ page }) => {
  const id = await openExample(page);
  const time = page.locator(".time-label");
  await expect(time).toHaveText("0:00 / 0:20");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(time).toHaveText("0:05 / 0:20");
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(time).not.toHaveText("0:05 / 0:20", { timeout: 10_000 });
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();

  // Space plays even when a button has focus, without pressing that button again.
  await page.getByRole("button", { name: "Cut out a section" }).click();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cut to here" })).toBeVisible();
  await page.keyboard.press("Space");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Cut out a section" })).toBeVisible();

  const zoom = page.getByTestId("slider-zoom");
  await zoom.fill("1.5");
  await expect(page.locator(".slider").first()).toContainText("150%");
  await expect(page.getByTestId("save-state")).toHaveText("All changes saved", { timeout: 10_000 });
  expect((await savedEdits(id)).zoom).toBe(1.5);
});

test("export: make a video, download it, show it in the folder, delete it", async ({ page }) => {
  const id = await openExample(page);
  await clickTimeline(page, 0.25);
  await page.getByRole("button", { name: "Set start here" }).click();

  await page.getByRole("button", { name: "Export" }).click();
  const drawer = page.getByRole("dialog", { name: "Export your video" });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("Your video will be 0:15 long");
  await drawer.getByRole("radio", { name: "1440p" }).check();
  await drawer.getByRole("radio", { name: "Best" }).check();
  await drawer.getByRole("button", { name: "Make video" }).click();
  const row = drawer.getByTestId("export-row");
  await expect(row).toHaveCount(1);
  await shot(page, "08-export-running");
  const download = drawer.getByTestId("download");
  await expect(download).toBeVisible({ timeout: 30_000 });
  await shot(page, "09-export-done");

  // What the helper received: the kept part and the final camera path.
  const sent = (await mockState()).lastExport!;
  expect(sent.width).toBe(2560);
  expect(sent.height).toBe(1440);
  expect(sent.quality).toBe("high");
  expect(sent.segments).toHaveLength(1);
  expect(sent.segments[0].startFrame).toBeGreaterThan(140);
  expect(sent.segments[0].endFrame).toBe(600);
  expect(sent.path.frames).toBe(600);
  expect(sent.path.finite).toBe(true);

  const [file] = await Promise.all([page.waitForEvent("download"), download.click()]);
  expect(file.suggestedFilename()).toMatch(/^Example match .*\.mp4$/);

  await drawer.getByRole("button", { name: "Show in folder" }).click();
  await expect.poll(async () => (await mockState()).openFolder.length).toBe(1);
  expect((await mockState()).openFolder[0].project).toBe(id);

  await drawer.getByRole("button", { name: "Delete this video" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(drawer).toContainText("No videos yet");
});

test("delete a match from the home page", async ({ page }) => {
  await resetMock(true);
  await open(page, "/");
  await page.getByRole("button", { name: "Delete Example match" }).click();
  await page.getByRole("button", { name: "Delete match" }).click();
  await expect(page.getByRole("heading", { name: "No matches yet" })).toBeVisible();
});
