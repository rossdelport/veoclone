// End-to-end UI tests against the mock helper. See playwright.config.ts.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expectPicture, FIXTURES, MOCK, mockState, open, patchProject, resetMock, shot } from "./helpers";

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
  // The online editor may have been refused access to the network: offer the one VeoClone serves itself.
  await expect(banner.getByRole("link", { name: "http://127.0.0.1:47863/" })).toHaveAttribute("href", "http://127.0.0.1:47863/");
  await expect(banner.getByRole("link", { name: "Download VeoClone" })).toHaveAttribute("href", "https://github.com/rossdelport/veoclone/releases");
  await expect(page.locator(".pill")).toContainText("not running");
  await shot(page, "02-offline");
});

async function createMatch(page: Page, name: string, style = "Action", widest?: string) {
  await open(page, "/new");
  await page.getByLabel("Name of the match").fill(name);
  await page.getByTestId("file-left").setInputFiles(path.join(FIXTURES, "left-small.mp4"));
  await page.getByTestId("file-right").setInputFiles(path.join(FIXTURES, "right-small.mp4"));
  await expect(page.locator(".dropzone[data-side=left]")).toContainText("left-small.mp4");
  await expect(page.locator(".dropzone[data-side=right]")).toContainText("right-small.mp4");
  await expect(page.locator(".dropzone[data-side=left]")).toContainText("long"); // duration read from the file
  // Which iPhone and which lens: two simple choices, mapped to one lens option.
  const model = page.getByLabel("Which camera?");
  await expect(model).toBeEnabled();
  await expect(model).toHaveValue("Not sure"); // the default…
  await expect(page.getByRole("radio", { name: /Ultra wide/ })).toBeChecked(); // …with the 0.5× lens
  await model.selectOption("iPhone 16 Pro");
  await expect(page.locator(".lens-note")).toHaveText("Uses the iPhone 15 Pro profile (closest match)");
  await page.getByText(style, { exact: true }).click();
  if (widest) await page.getByRole("radiogroup", { name: "Widest view" }).getByText(widest, { exact: true }).click();
  await shot(page, "03-new-match");
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page).toHaveURL(/#\/project\/\w+/);
  return "iphone-16-pro:ultra";
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

test("camera style: Follow the ball, when creating a match and when running the AI again", async ({ page }) => {
  await resetMock();
  await open(page, "/new");
  const styles = page.getByRole("radiogroup", { name: "Camera style" });
  await expect(styles.getByRole("radio")).toHaveCount(4);
  await expect(styles.getByRole("radio", { name: /Broadcast/ })).toBeChecked(); // still the default
  await expect(styles.getByText("Follow the ball", { exact: true })).toBeVisible();
  await expect(styles).toContainText("Keeps the ball in the middle");
  await createMatch(page, "Ball match", "Follow the ball");
  expect((await mockState()).projects[0].style).toBe("ball");
  await expect(page).toHaveURL(/#\/edit\/\w+/, { timeout: 30_000 });
  await expect(page.locator(".style-line")).toContainText("Camera style: Follow the ball");
  // Back on the match page, another style runs the AI again.
  const id = (await mockState()).projects[0].id;
  await open(page, `/project/${id}`);
  await page.getByText("Change the camera style").click();
  await page.getByRole("radiogroup", { name: "Camera style" }).getByText("Broadcast", { exact: true }).click();
  await page.getByRole("button", { name: "Run the AI again" }).click();
  await expect.poll(async () => (await mockState()).projects[0].style).toBe("broadcast");
});

test("AI accuracy: every frame by default, every 3rd frame when chosen, and changed later", async ({ page }) => {
  await resetMock();
  await open(page, "/new");
  const accuracy = page.getByRole("radiogroup", { name: "AI accuracy" });
  await expect(accuracy.getByRole("radio", { name: /Best – check every frame \(slower\)/ })).toBeChecked();
  await expect(accuracy).toContainText("up to 3 times as long");
  await accuracy.getByText("Faster – every 3rd frame").click();
  await createMatch(page, "Quick match");
  expect((await mockState()).projects[0].aiAccuracy).toBe("faster");
  await expect(page).toHaveURL(/#\/edit\/\w+/, { timeout: 30_000 });
  const id = (await mockState()).projects[0].id;
  await open(page, `/project/${id}`);
  await expect(page.locator(".facts")).toContainText("Faster – every 3rd frame");
  await page.getByText("Change the camera style, widest view or AI accuracy").click();
  // What the AI saw (every 3rd frame) is kept: another style takes seconds…
  await expect(page.getByTestId("rerun-time")).toHaveText("This takes a few seconds: VeoClone reuses what the AI saw last time.");
  await page.getByRole("radiogroup", { name: "AI accuracy" }).getByText("Best – check every frame (slower)").click();
  // …but looking at every frame needs the whole match again.
  await expect(page.getByTestId("rerun-time")).toContainText("about as long as the first time");
  await shot(page, "qw-01-rerun-accuracy");
  await page.getByRole("button", { name: "Run the AI again" }).click();
  await expect.poll(async () => (await mockState()).projects[0].aiAccuracy).toBe("best");
  expect((await mockState()).projects[0].style).toBe("action");
});

test("GoPro: detect automatically, or pick the model and its Lens setting", async ({ page }) => {
  await resetMock();
  await open(page, "/new");
  await page.getByLabel("Name of the match").fill("GoPro match");
  const model = page.getByLabel("Which camera?");
  await expect(model).toBeEnabled();
  await expect(model.locator("optgroup")).toHaveCount(2);
  await model.selectOption("GoPro or other action camera – detect automatically");
  // Nothing more to choose: the video file says.
  await expect(page.getByText("Which lens?")).toBeHidden();
  await expect(page.locator(".lens-note")).toHaveText("VeoClone reads the camera model and its Lens setting from the video file.");
  await shot(page, "qw-05-gopro-auto");
  await model.selectOption("GoPro HERO12 Black");
  await expect(page.getByRole("radio", { name: /Recommended: the GoPro/ })).toBeChecked();
  await expect(page.locator(".lens-note")).toHaveText("Uses the HERO11 Black settings (the same lens)");
  await page.getByText("Linear", { exact: true }).click();
  await expect(page.locator(".tips")).toContainText("HyperSmooth: Off");
  await expect(page.locator(".tips")).toContainText("Anti-Flicker to 50 Hz");
  await page.getByTestId("file-left").setInputFiles(path.join(FIXTURES, "left-small.mp4"));
  await page.getByTestId("file-right").setInputFiles(path.join(FIXTURES, "right-small.mp4"));
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page).toHaveURL(/#\/project\/\w+/);
  expect((await mockState()).projects[0].lensId).toBe("gopro-hero12-black:linear");
  // Back to an iPhone: its two lenses again.
  await open(page, "/new");
  await page.getByLabel("Which camera?").selectOption("GoPro HERO9 Black");
  await page.getByLabel("Which camera?").selectOption("iPhone 15");
  await expect(page.getByRole("radio", { name: /Ultra wide/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Normal/ })).toBeVisible();
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
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page).toHaveURL(/#\/edit\/\w+/, { timeout: 60_000 });
});

test("cancel processing", async ({ page }) => {
  await resetMock();
  await createMatch(page, "Slow match to cancel");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  // "Keep going" closes the question without stopping.
  await page.getByRole("button", { name: "Keep going" }).click();
  await expect(page.getByRole("heading", { name: "Processing your match" })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
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

/** Click a point of the "Mark the pitch" picture, as a fraction of its size. */
test("widest view: Natural (like Veo) for a new match, Wide when chosen, shown on the match page and in the editor", async ({ page }) => {
  await resetMock();
  await open(page, "/new");
  const choices = page.getByRole("radiogroup", { name: "Widest view" });
  await expect(choices.getByRole("radio")).toHaveCount(3);
  await expect(choices.getByRole("radio", { name: /^Natural \(like Veo\)/ })).toBeChecked();
  await expect(choices).toContainText("Stays close to the play, so the sides of the picture never look stretched.");
  await expect(choices).toContainText("The sides can look stretched, like a fisheye.");
  await createMatch(page, "Wide view match", "Broadcast", "Wide");
  expect((await mockState()).projects[0].widestView).toBe("wide");
  await expect(page.locator(".facts dt:text-is('Widest view') + dd")).toHaveText("Wide", { timeout: 30_000 });
  await expect(page).toHaveURL(/#\/edit\/\w+/, { timeout: 10_000 });
  await expectPicture(page);
  const editor = page.getByTestId("widest-view").getByRole("radiogroup", { name: "Widest view" });
  await expect(editor.getByRole("radio", { name: /^Wide\b/ })).toBeChecked();
  await expect(page.getByTestId("widest-note")).toBeEmpty();
  await expect(page.getByTestId("natural-hint")).toHaveCount(0); // only for matches made before the setting
  expect((await mockState()).projects[0].aiRun?.widestView).toBe("wide");
});

test("editor: an older match gets the Natural look tip; Try it keeps the camera closer at once and runs the AI again in seconds", async ({ page }) => {
  const id = await openExample(page);
  const camera = page.getByTestId("widest-view");
  const choices = camera.getByRole("radiogroup", { name: "Widest view" });
  await expect(choices.getByRole("radio")).toHaveCount(3);
  // Made before the setting existed: it keeps the camera it had.
  await expect(choices.getByRole("radio", { name: /^Widest\b/ })).toBeChecked();
  await expect(camera).toContainText("How far the camera may zoom out");
  const tip = page.getByTestId("natural-hint");
  await expect(tip).toContainText("New: Natural look stops the camera zooming out so far that the edges stretch.");
  await shot(page, "nl-01-tip");

  // Zoomed right out, the camera goes as wide as the two pictures allow.
  const view = page.getByTestId("camera-view");
  await page.getByTestId("slider-zoom").fill("0.5");
  await expect(page.locator(".slider").first()).toContainText("50%");
  await page.getByRole("button", { name: "Export" }).click();
  const drawer = page.getByRole("dialog", { name: "Export your video" });
  await drawer.getByRole("button", { name: "Make video" }).click();
  await expect(drawer.getByTestId("download")).toBeVisible({ timeout: 30_000 });
  expect((await mockState()).lastExport!.path.maxFov).toBeGreaterThan(45);
  await drawer.getByRole("button", { name: "Close" }).click();
  await page.waitForTimeout(500); // the drawer has gone
  const before = await view.screenshot();

  // Try it: the editor keeps to Natural at once, and the AI runs again
  // (slowly here, so the note can be seen).
  await patchProject(id, { name: "Example match slow" });
  const gets = (await mockState()).aiPathGets;
  await tip.getByRole("button", { name: "Try it" }).click();
  await expect(tip).toHaveCount(0);
  await expect(choices.getByRole("radio", { name: /^Natural/ })).toBeChecked();
  const note = page.getByTestId("widest-note");
  await expect(note).toContainText("Updating the AI camera for “Natural (like Veo)”…");
  await expect(choices.getByRole("radio", { name: /^Wide\b/ })).toBeDisabled();
  await expect.poll(async () => (await view.screenshot()).equals(before)).toBe(false);
  await camera.scrollIntoViewIfNeeded();
  await shot(page, "nl-02-updating");
  await expect(page.getByText("Done: the AI camera now uses “Natural (like Veo)”.")).toBeVisible({ timeout: 30_000 });
  await expect(note).toBeEmpty();
  await expect(choices.getByRole("radio", { name: /^Wide\b/ })).toBeEnabled();
  const state = await mockState();
  expect(state.projects[0].widestView).toBe("natural");
  expect(state.projects[0].aiRun?.widestView).toBe("natural");
  expect(state.aiPathGets).toBe(gets + 1); // the new AI path, without leaving the editor
  await expect(page).toHaveURL(new RegExp(`#/edit/${id}$`));
  await camera.scrollIntoViewIfNeeded();
  await shot(page, "nl-03-natural");

  // The Zoom slider (still 50%) and a fix zoomed right out can't go past 34 degrees.
  await view.hover();
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 400);
  await expect(page.locator(".fixes li")).toHaveCount(1, { timeout: 5000 });
  await page.getByRole("button", { name: "Export" }).click();
  await drawer.getByRole("button", { name: "Make video" }).click();
  await expect(drawer.getByTestId("export-row")).toHaveCount(2);
  const sent = (await mockState()).lastExport!.path;
  expect(sent.finite).toBe(true);
  expect(sent.maxFov).toBeLessThanOrEqual(34);
  expect(sent.maxFov).toBeGreaterThan(33.9);
  await drawer.getByRole("button", { name: "Close" }).click();

  // Opened again: Natural, and no tip.
  await page.reload();
  await expectPicture(page);
  await expect(choices.getByRole("radio", { name: /^Natural/ })).toBeChecked();
  await expect(page.getByTestId("natural-hint")).toHaveCount(0);
});

test("editor: when running the AI again for a widest view fails, the editor keeps to it and offers to try again", async ({ page }) => {
  const id = await openExample(page);
  await patchProject(id, { name: "Example match fail" }); // the mock fails its next run once
  const choices = page.getByTestId("widest-view").getByRole("radiogroup", { name: "Widest view" });
  await choices.getByText("Wide", { exact: true }).click();
  await expect(page.getByText("The AI camera could not be updated.")).toBeVisible({ timeout: 30_000 });
  const note = page.getByTestId("widest-note");
  await expect(note).toContainText("The AI camera was made with “Widest”.");
  await expect(page.getByTestId("editor-warnings")).toContainText("Processing it again did not work");
  await expect(choices.getByRole("radio", { name: /^Wide\b/ })).toBeChecked();
  expect((await mockState()).projects[0]).toMatchObject({ status: "ready", widestView: "wide" });
  await note.getByRole("button", { name: "Run the AI again" }).click();
  await expect(page.getByText("Done: the AI camera now uses “Wide”.")).toBeVisible({ timeout: 30_000 });
  await expect(note).toBeEmpty();
  expect((await mockState()).projects[0].aiRun?.widestView).toBe("wide");
});

test("editor: the Natural look tip can be hidden for good", async ({ page }) => {
  const id = await openExample(page);
  await page.getByTestId("natural-hint").getByRole("button", { name: "Hide this tip" }).click();
  await expect(page.getByTestId("natural-hint")).toHaveCount(0);
  await page.reload();
  await expectPicture(page);
  await expect(page.getByTestId("natural-hint")).toHaveCount(0);
  const p = (await mockState()).projects.find((x) => x.id === id)!;
  expect(p.widestView).toBeNull(); // nothing changed
});

async function clickPitch(page: Page, fx: number, fy: number) {
  const box = (await page.getByTestId("pitch-canvas").boundingBox())!;
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}

test("editor: mark the pitch, undo a point, save, and run the AI again to use it", async ({ page }) => {
  const id = await openExample(page);
  // Offered straight away for a match without a pitch outline.
  const hint = page.getByTestId("pitch-hint");
  await expect(hint).toContainText("Mark the pitch so the camera ignores people outside it.");
  await expect(page.getByTestId("pitch-status")).toContainText("Pitch not marked");
  await shot(page, "qw-02-pitch-hint");
  await hint.getByRole("button", { name: "Mark the pitch" }).click();
  const dialog = page.getByRole("dialog", { name: "Mark the pitch" });
  await expect(dialog).toContainText("Click the corners of the pitch, going round it.");
  const save = dialog.getByRole("button", { name: "Save the outline" });
  await expect(save).toBeDisabled();
  for (const [fx, fy] of [[0.12, 0.42], [0.88, 0.42], [0.95, 0.8], [0.4, 0.5]]) await clickPitch(page, fx, fy);
  await expect(dialog.locator(".pitch-status")).toContainText("4 points");
  // A wrong point: Undo takes it back.
  await dialog.getByRole("button", { name: "Undo last point" }).click();
  await expect(dialog.locator(".pitch-status")).toContainText("3 of at least 4 points");
  await expect(save).toBeDisabled();
  await clickPitch(page, 0.05, 0.8);
  await expect(save).toBeEnabled();
  await shot(page, "qw-03-mark-pitch");
  await save.click();
  // Saved; the AI must run again to use it.
  const again = page.getByRole("dialog", { name: "Pitch outline saved" });
  await expect(again).toContainText("The AI needs to run again");
  await expect(again).toContainText("This takes a few seconds");
  const state = await mockState();
  const pitch = state.projects[0].pitch!;
  expect(state.pitchPuts).toBe(1);
  expect(pitch.points).toHaveLength(4);
  for (const side of [pitch.left, pitch.right]) {
    expect(side.length).toBeGreaterThanOrEqual(3);
    for (const [x, y] of side) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
  }
  await again.getByRole("button", { name: "Later" }).click();
  await expect(hint).toBeHidden();
  await expect(page.getByTestId("pitch-status")).toContainText("doesn't use it yet");
  await shot(page, "qw-04-pitch-marked");
  await page.getByTestId("pitch-status").getByRole("button", { name: "Run the AI again" }).click();
  await expect(page).toHaveURL(new RegExp(`#/project/${id}$`));
  await expect(page).toHaveURL(new RegExp(`#/edit/${id}$`), { timeout: 30_000 });
  await expect(page.getByTestId("pitch-status")).toContainText("Pitch marked: the AI ignores everyone outside it.");
  expect((await mockState()).projects[0].aiRun?.pitchId).toBe(pitch.id);
  await expect(page.getByTestId("pitch-hint")).toHaveCount(0);

  // Change it: the saved outline comes back, Start again clears it; Remove takes it away.
  await page.getByRole("button", { name: "Change the pitch outline" }).click();
  await expect(dialog.locator(".pitch-status")).toContainText("4 points");
  await dialog.getByRole("button", { name: "Start again" }).click();
  await expect(dialog.locator(".pitch-status")).toContainText("Click the first corner");
  await dialog.getByRole("button", { name: "Remove the outline" }).click();
  await page.getByRole("dialog", { name: "Pitch outline removed" }).getByRole("button", { name: "Later" }).click();
  expect((await mockState()).projects[0].pitch).toBeNull();
  await expect(page.getByTestId("pitch-status")).toContainText("still uses it");
});

test("editor: the Mark the pitch tip can be hidden for good", async ({ page }) => {
  const id = await openExample(page);
  await page.getByTestId("pitch-hint").getByRole("button", { name: "Hide this tip" }).click();
  await expect(page.getByTestId("pitch-hint")).toHaveCount(0);
  await page.reload();
  await expectPicture(page);
  await expect(page.getByTestId("pitch-status")).toContainText("Pitch not marked");
  await expect(page.getByTestId("pitch-hint")).toHaveCount(0);
  expect(id).toBeTruthy();
});

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
  await page.getByTestId("overview").scrollIntoViewIfNeeded();
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
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect(time).not.toHaveText("0:05 / 0:20", { timeout: 10_000 });
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();

  // Space plays even when a button has focus, without pressing that button again.
  await page.getByRole("button", { name: "Cut out a section" }).click();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
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

test("editor: straighten the picture, look left / centre / right, undo, autosave and export with it", async ({ page }) => {
  const id = await openExample(page);
  const view = page.getByTestId("camera-view");
  const badge = view.locator(".view-badge");
  const section = page.getByTestId("straighten");
  const tilt = page.getByTestId("straighten-tiltDeg");
  const level = page.getByTestId("straighten-rollDeg");
  const tiltValue = section.locator(".slider").nth(0).locator(".slider-value");
  const levelValue = section.locator(".slider").nth(1).locator(".slider-value");
  await expect(section).toContainText("Move these until the far side of the pitch looks level when the camera looks left, centre and right");
  await expect(section).toContainText("keep the phones as level as possible");
  await expect(tiltValue).toHaveText("0°");
  await expect(page.getByTestId("reset-tiltDeg")).toBeDisabled();
  await expect(page.getByTestId("reset-tiltDeg")).toHaveAttribute("aria-label", "Reset tilt");
  await expect(page.getByTestId("camera-level")).toBeHidden();
  // iPhones record no level and it is not straightened yet: a tip points to it.
  const tip = page.getByTestId("straighten-hint");
  await expect(tip).toContainText("Picture leaning when the camera turns? Use Straighten picture.");

  // Look left: a preview of the left edge, not a fix.
  await expect(badge).toHaveText("AI camera");
  const ai = await view.screenshot();
  await section.getByRole("button", { name: "Look left" }).click();
  await expect(badge).toHaveText("Looking left · preview only");
  await expect(section.getByRole("button", { name: "Look left" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await view.screenshot()).equals(ai)).toBe(false);
  const left = await view.screenshot();
  await expect(page.locator(".fixes li")).toHaveCount(0);

  // Tilt: the picture turns, thin level lines show while it moves, the tip goes.
  await tilt.fill("12");
  await expect(tiltValue).toHaveText("12.0° down");
  await expect(page.getByTestId("level-guides")).toHaveClass(/shown/);
  await expect.poll(async () => (await view.screenshot()).equals(left)).toBe(false);
  await expect(tip).toBeHidden();
  await shot(page, "15-editor-straighten");
  await expect(page.getByTestId("level-guides")).not.toHaveClass(/shown/, { timeout: 5000 });
  await level.fill("-3");
  await expect(levelValue).toHaveText("↺ 3.0°");
  await expect(badge).toHaveText("Looking left · preview only");

  await section.getByRole("button", { name: "Look right" }).click();
  await expect(badge).toHaveText("Looking right · preview only");
  await expect(section.getByRole("button", { name: "Look left" })).toHaveAttribute("aria-pressed", "false");
  await section.getByRole("button", { name: "Look centre" }).click();
  await expect(badge).toHaveText("Looking at the centre · preview only");
  // Pressing it again goes back to the camera; so does moving the playhead.
  await section.getByRole("button", { name: "Look centre" }).click();
  await expect(badge).toHaveText("AI camera");
  await section.getByRole("button", { name: "Look right" }).click();
  await page.keyboard.press("ArrowRight");
  await expect(badge).toHaveText("AI camera");
  await expect(page.locator(".fixes li")).toHaveCount(0);

  // Undo / redo / reset.
  await page.keyboard.press("Control+z");
  await expect(levelValue).toHaveText("0°");
  await expect(tiltValue).toHaveText("12.0° down");
  await page.keyboard.press("Control+y");
  await expect(levelValue).toHaveText("↺ 3.0°");
  await page.getByTestId("reset-tiltDeg").click();
  await expect(tiltValue).toHaveText("0°");
  await page.keyboard.press("Control+z");
  await expect(tiltValue).toHaveText("12.0° down");

  // A fix made now keeps looking at the same place when the straightening changes.
  await page.keyboard.press("k");
  await expect(page.locator(".fixes li")).toHaveCount(1);

  // Autosaved, and sent with the export.
  await expect(page.getByTestId("save-state")).toHaveText("All changes saved", { timeout: 10_000 });
  await expect.poll(async () => JSON.stringify((await savedEdits(id)).straighten)).toBe(JSON.stringify({ tiltDeg: 12, rollDeg: -3 }));
  await page.getByRole("button", { name: "Export" }).click();
  const drawer = page.getByRole("dialog", { name: "Export your video" });
  await drawer.getByRole("button", { name: "Make video" }).click();
  await expect(drawer.getByTestId("export-row")).toHaveCount(1);
  const sent = (await mockState()).lastExport!;
  expect(sent.rigTiltDeg).toBe(12);
  expect(sent.rigRollDeg).toBe(-3);
  expect(sent.path.finite).toBe(true);
  await drawer.getByRole("button", { name: "Close" }).click();

  // Opened again: the same straightening, and no tip.
  await page.reload();
  await expectPicture(page);
  await expect(tiltValue).toHaveText("12.0° down");
  await expect(levelValue).toHaveText("↺ 3.0°");
  await expect(page.getByTestId("straighten-hint")).toBeHidden();
});

test("editor: the Straighten picture tip can be hidden for good, or opens the section", async ({ page }) => {
  await openExample(page);
  const tip = page.getByTestId("straighten-hint");
  await expect(tip).toBeVisible();
  await tip.getByRole("button", { name: "Straighten picture" }).click();
  await expect(tip).toBeHidden();
  await expect(page.getByTestId("straighten-tiltDeg")).toBeFocused();
  await expect(page.getByTestId("camera-view").locator(".view-badge")).toHaveText("Looking left · preview only");
  await page.reload();
  await expectPicture(page);
  await expect(page.getByTestId("straighten-hint")).toBeHidden();
  // A fresh browser: the X hides it too.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expectPicture(page);
  await page.getByTestId("straighten-hint").getByRole("button", { name: "Hide this tip" }).click();
  await expect(page.getByTestId("straighten-hint")).toBeHidden();
  await page.reload();
  await expectPicture(page);
  await expect(page.getByTestId("straighten-hint")).toBeHidden();
});

test("editor: a camera that measured its own level (GoPro) starts straightened, Reset goes back to it, no tip", async ({ page }) => {
  await resetMock(true);
  const id = (await mockState()).projects[0].id;
  await patchProject(id, { name: "GoPro match" });
  await open(page, `/edit/${id}`);
  await expectPicture(page);
  const section = page.getByTestId("straighten");
  const tiltValue = section.locator(".slider").nth(0).locator(".slider-value");
  const levelValue = section.locator(".slider").nth(1).locator(".slider-value");
  // match.json: rig_tilt 0.12 rad = 6.9 degrees down, rig_roll -0.03 rad = 1.7 degrees
  await expect(tiltValue).toHaveText("6.9° down");
  await expect(levelValue).toHaveText("↺ 1.7°");
  await expect(page.getByTestId("camera-level")).toContainText("Your cameras measured their own level");
  await expect(page.getByTestId("straighten-hint")).toBeHidden();
  const reset = page.getByTestId("reset-tiltDeg");
  await expect(reset).toBeDisabled();
  await expect(reset).toHaveAttribute("aria-label", "Reset tilt to the camera's own level (6.9° down)");
  await page.getByTestId("straighten-tiltDeg").fill("15");
  await expect(tiltValue).toHaveText("15.0° down");
  await reset.click();
  await expect(tiltValue).toHaveText("6.9° down");
  await expect(reset).toBeDisabled();
  // The export sends the camera's own values.
  await page.getByRole("button", { name: "Export" }).click();
  const drawer = page.getByRole("dialog", { name: "Export your video" });
  await drawer.getByRole("button", { name: "Make video" }).click();
  await expect(drawer.getByTestId("export-row")).toHaveCount(1);
  const sent = (await mockState()).lastExport!;
  expect(sent.rigTiltDeg).toBeCloseTo((0.12 * 180) / Math.PI, 9);
  expect(sent.rigRollDeg).toBeCloseTo((-0.03 * 180) / Math.PI, 9);
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

test("a ?helper= link to another computer is ignored, also when it was remembered", async ({ page }) => {
  const hosts = new Set<string>();
  page.on("request", (r) => hosts.add(new URL(r.url()).host));
  await page.goto("/?helper=https%3A%2F%2Fveo-helper.example#/");
  await expect(page.locator(".pill")).not.toContainText("Looking for VeoClone");
  expect(await page.evaluate(() => localStorage.getItem("veoclone.helper"))).toBeNull();

  // An address saved earlier (by an older version) is not used either.
  await page.evaluate(() => localStorage.setItem("veoclone.helper", "http://evil.example:47863"));
  await page.goto("/#/");
  await expect(page.locator(".pill")).not.toContainText("Looking for VeoClone");
  expect([...hosts].filter((h) => h.includes("example"))).toEqual([]);
});

test("the iPhone list loads once VeoClone starts", async ({ page }) => {
  await resetMock();
  await page.route(`${MOCK}/**`, (route) => route.abort()); // VeoClone not running yet
  await open(page, "/new");
  await expect(page.getByTestId("helper-offline")).toBeVisible();
  await expect(page.getByLabel("Which camera?")).toBeDisabled();
  await page.unroute(`${MOCK}/**`);
  await expect(page.getByTestId("helper-offline")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByLabel("Which camera?")).toBeEnabled();
  await expect(page.getByLabel("Which camera?").locator("option")).not.toHaveCount(1);
});

test("Try again after a failed upload sends only the video that is missing", async ({ page }) => {
  await resetMock();
  const puts: string[] = [];
  await page.route(`${MOCK}/api/projects/*/files/*`, (route) => {
    const side = route.request().url().split("/").pop()!;
    puts.push(side);
    return side === "right" && puts.filter((s) => s === "right").length === 1 ? route.abort() : route.continue();
  });
  await open(page, "/new");
  await page.getByTestId("file-left").setInputFiles(path.join(FIXTURES, "left-small.mp4"));
  await page.getByTestId("file-right").setInputFiles(path.join(FIXTURES, "right-small.mp4"));
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByText("could not be reached")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page).toHaveURL(/#\/project\/\w+/);
  expect(puts).toEqual(["left", "right", "right"]);
  expect((await mockState()).projects).toHaveLength(1);
});

// A GoPro saves a long recording as several files ("chapters"), all from one camera.
const CLIP = readFileSync(path.join(FIXTURES, "left-small.mp4"));
const gopro = (name: string) => ({ name, mimeType: "video/mp4", buffer: CLIP });
/** The file names listed in a box, in the order they are joined. */
const partNames = (side: "left" | "right") => `.dropzone[data-side=${side}] .dz-part .dz-name`;

test("a GoPro video in several files: put in order, a part removed and added back, sent part by part", async ({ page }) => {
  await resetMock();
  await open(page, "/new");
  await page.getByLabel("Name of the match").fill("GoPro chapters");
  const left = page.locator(".dropzone[data-side=left]");
  // Chosen in any order: joined in the order the camera recorded them.
  await page.getByTestId("file-left").setInputFiles([gopro("GX030042.MP4"), gopro("GX010042.MP4"), gopro("GX020042.MP4")]);
  await expect(page.locator(partNames("left"))).toHaveText(["GX010042.MP4", "GX020042.MP4", "GX030042.MP4"]);
  // "3 parts · 0:06 · 60 KB": the length of all three together.
  await expect(left.getByTestId("parts-summary")).toHaveText(/^3 parts · \d+:\d\d · \d+ KB$/);
  await expect(left.locator(".dz-warn")).toHaveCount(0);
  await page.getByTestId("file-right").setInputFiles(path.join(FIXTURES, "right-small.mp4"));
  await expect(page.locator(".dropzone[data-side=right]")).toContainText("right-small.mp4"); // one file, as before
  await shot(page, "gp-01-parts");

  // Removing the middle part: VeoClone says one is missing.
  await left.getByRole("button", { name: "Remove GX020042.MP4" }).click();
  await expect(page.locator(partNames("left"))).toHaveText(["GX010042.MP4", "GX030042.MP4"]);
  await expect(left.locator(".dz-warn")).toContainText("A part seems to be missing: GX020042.MP4.");
  await page.getByTestId("file-left").setInputFiles([gopro("GX020042.MP4"), gopro("GX030042.MP4"), gopro("GX010042.MP4")]);
  await expect(left.locator(".dz-warn")).toHaveCount(0);

  await page.getByRole("button", { name: "Start" }).click();
  await expect(page).toHaveURL(/#\/project\/\w+/);
  const state = await mockState();
  expect(state.uploads).toEqual([
    { side: "left", name: "GX010042.MP4", part: 1, parts: 3 },
    { side: "left", name: "GX020042.MP4", part: 2, parts: 3 },
    { side: "left", name: "GX030042.MP4", part: 3, parts: 3 },
    { side: "right", name: "right-small.mp4", part: null, parts: null },
  ]);
  expect(state.projects[0].files.left!.parts!.map((p) => p!.name)).toEqual(["GX010042.MP4", "GX020042.MP4", "GX030042.MP4"]);
  expect(state.projects[0].files.right!.parts).toBeUndefined();
  await expect(page.getByRole("heading", { name: "Your match is ready" })).toBeVisible({ timeout: 30_000 });
});

test("files from different recordings, and a missing first part, are pointed out", async ({ page }) => {
  await resetMock();
  await open(page, "/new");
  const left = page.locator(".dropzone[data-side=left]");
  const right = page.locator(".dropzone[data-side=right]");
  await page.getByTestId("file-left").setInputFiles([gopro("GX010043.MP4"), gopro("GX020042.MP4"), gopro("GX010042.MP4")]);
  await expect(page.locator(partNames("left"))).toHaveText(["GX010042.MP4", "GX020042.MP4", "GX010043.MP4"]);
  await expect(left.locator(".dz-warn")).toContainText("These files seem to come from different recordings (recordings 0042 and 0043).");
  await shot(page, "gp-02-mixed");
  // HERO5 and older: GOPR0077.MP4 is the first part, then GP010077.MP4…
  await page.getByTestId("file-right").setInputFiles([gopro("GP020077.MP4"), gopro("GP010077.MP4")]);
  await expect(right.locator(".dz-warn")).toContainText("A part seems to be missing: GOPR0077.MP4.");
  await expect(right.locator(".dz-warn")).toContainText("line up and level the cameras");
  await page.getByTestId("file-right").setInputFiles([gopro("GP010077.MP4"), gopro("GOPR0077.MP4")]);
  await expect(page.locator(partNames("right"))).toHaveText(["GOPR0077.MP4", "GP010077.MP4"]);
  await expect(right.locator(".dz-warn")).toHaveCount(0);
  // Other cameras: by name, with a word on joining.
  await page.getByTestId("file-left").setInputFiles([gopro("clip10.mp4"), gopro("clip2.mp4")]);
  await expect(page.locator(partNames("left"))).toHaveText(["clip2.mp4", "clip10.mp4"]);
  await expect(left.locator(".dz-note")).toContainText("VeoClone joins these 2 files in this order into one video.");
  // Back to one file: as before.
  await page.getByTestId("file-left").setInputFiles(path.join(FIXTURES, "left-small.mp4"));
  await expect(left.locator(".dz-parts")).toHaveCount(0);
  await expect(left).toContainText("left-small.mp4");
});

test("Try again after a failed upload sends only the parts that are missing", async ({ page }) => {
  await resetMock();
  const puts: string[] = [];
  await page.route(`${MOCK}/api/projects/*/files/**`, (route) => {
    const url = new URL(route.request().url());
    const what = `${url.pathname.split("/").pop()}${url.searchParams.get("part") ?? ""}`;
    puts.push(what);
    return what === "left2" && puts.filter((s) => s === "left2").length === 1 ? route.abort() : route.continue();
  });
  await open(page, "/new");
  await page.getByTestId("file-left").setInputFiles([gopro("GX010042.MP4"), gopro("GX020042.MP4"), gopro("GX030042.MP4")]);
  await page.getByTestId("file-right").setInputFiles(path.join(FIXTURES, "right-small.mp4"));
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByText("could not be reached")).toBeVisible();
  const left = page.locator(".dropzone[data-side=left]");
  await expect(left.locator(".dz-part").first()).toContainText("Sent");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page).toHaveURL(/#\/project\/\w+/);
  expect(puts).toEqual(["left1", "left2", "left2", "left3", "right"]);
  expect((await mockState()).projects).toHaveLength(1);
});

test("a video with a part missing on VeoClone: add all its files again, only the missing part is sent", async ({ page }) => {
  await resetMock();
  const res = await fetch(`${MOCK}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Unfinished upload" }) });
  const { id } = (await res.json()) as { id: string };
  const put = (side: string, query: string, name: string) =>
    fetch(`${MOCK}/api/projects/${id}/files/${side}${query}`, { method: "PUT", headers: { "X-Filename": name }, body: CLIP });
  expect((await put("left", "?part=1&parts=2", "GX010042.MP4")).ok).toBe(true);
  expect((await put("right", "", "right.mp4")).ok).toBe(true);
  await open(page, `/project/${id}`);
  await expect(page.getByText("Some files of a video are missing.")).toBeVisible();
  const left = page.locator(".dropzone[data-side=left]");
  await expect(left.locator(".dz-part")).toHaveCount(2);
  await expect(left.locator(".dz-part").nth(1)).toContainText("not sent yet");
  await expect(left.locator(".dz-warn")).toContainText("haven't been sent to VeoClone yet");
  await expect(page.getByRole("button", { name: "Start" })).toBeDisabled();
  await shot(page, "gp-03-missing-part");
  await page.getByTestId("file-left").setInputFiles([gopro("GX020042.MP4"), gopro("GX010042.MP4")]);
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByRole("heading", { name: "Processing your match" })).toBeVisible();
  const state = await mockState();
  expect(state.uploads.slice(2)).toEqual([{ side: "left", name: "GX020042.MP4", part: 2, parts: 2 }]);
  expect(state.projects[0].files.left!.parts!.every(Boolean)).toBe(true);
});

test("Stop during an upload leaves no half-made match behind", async ({ page }) => {
  await resetMock();
  // Send slowly, so Stop comes while VeoClone is still receiving the video
  // (it refuses to delete the match until it notices the upload has gone).
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 4000 });
  await open(page, "/new");
  await page.getByTestId("file-left").setInputFiles(path.join(FIXTURES, "left-small.mp4"));
  await page.getByTestId("file-right").setInputFiles(path.join(FIXTURES, "right-small.mp4"));
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.locator(".dropzone[data-side=left] .dz-progress")).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("Stopped. Press Start to try again.")).toBeVisible();
  await expect.poll(async () => (await mockState()).projects.length, { timeout: 10_000 }).toBe(0);
});

test("swap left and right after a failure, without sending the videos again", async ({ page }) => {
  await resetMock();
  await createMatch(page, "Please fail once, slowly");
  await expect(page.getByRole("alert").filter({ hasText: "couldn't line up" })).toBeVisible({ timeout: 30_000 });
  let puts = 0;
  page.on("request", (r) => r.method() === "PUT" && r.url().includes("/files/") && puts++);
  await page.getByRole("button", { name: "Swap left and right and try again" }).click();
  await expect(page).toHaveURL(/#\/edit\/\w+/, { timeout: 60_000 });
  const state = await mockState();
  expect(state.swaps).toBe(1);
  expect(state.projects[0].files.left!.name).toBe("right-small.mp4");
  expect(state.projects[0].files.right!.name).toBe("left-small.mp4");
  expect(puts).toBe(0);
});

test("warnings show on the home card and in the editor, and can be hidden", async ({ page }) => {
  await resetMock(true);
  await open(page, "/");
  await expect(page.getByTestId("warnings-badge")).toHaveText("1 thing to check");
  await page.getByRole("link", { name: "Open editor" }).click();
  await expectPicture(page);
  const notes = page.getByTestId("editor-warnings");
  await expect(notes).toContainText("typical iPhone lens");
  await shot(page, "10-editor-warnings");
  await notes.getByRole("button", { name: "Hide these notes" }).click();
  await expect(notes).toBeHidden();
  await page.reload();
  await expectPicture(page);
  await expect(page.getByTestId("editor-warnings")).toBeHidden();
});

test("change phone or lens from the editor: two choices, then everything is processed again", async ({ page }) => {
  const id = await openExample(page);
  await page.getByRole("link", { name: "Change phone or lens" }).click();
  const dialog = page.getByRole("dialog", { name: "Change phone or lens" });
  await expect(dialog).toContainText("does all the processing again");
  await dialog.getByLabel("Which camera?").selectOption("iPhone 13 mini");
  await dialog.getByText("Normal (1×)").click();
  await expect(dialog.locator(".lens-note")).toHaveText("Uses the iPhone 13 profile (closest match)");
  await shot(page, "11-change-lens");
  await dialog.getByRole("button", { name: "Process again" }).click();
  await expect(page).toHaveURL(new RegExp(`#/project/${id}$`));
  await expect(page.getByRole("heading", { name: "Processing your match" })).toBeVisible();
  expect((await mockState()).projects[0].lensId).toBe("iphone-13-mini:main");
  await expect(page).toHaveURL(new RegExp(`#/edit/${id}$`), { timeout: 30_000 });
});

test("two different iPhones: a phone and lens for each, also when changing them later", async ({ page }) => {
  await resetMock();
  await open(page, "/new");
  await page.getByLabel("Name of the match").fill("Two different phones");
  await page.getByTestId("file-left").setInputFiles(path.join(FIXTURES, "left-small.mp4"));
  await page.getByTestId("file-right").setInputFiles(path.join(FIXTURES, "right-small.mp4"));
  await expect(page.getByLabel("Which camera?")).toBeEnabled();
  // One choice for both phones unless the box is ticked.
  const differ = page.getByLabel("The two phones are different models");
  await expect(differ).not.toBeChecked();
  await expect(page.getByRole("group", { name: "Right phone" })).toBeHidden();
  await expect(page.locator(".phones-picker").getByRole("heading", { name: "Left phone" })).toBeHidden();
  await page.getByLabel("Which camera?").selectOption("iPhone 13 Pro Max");
  await differ.check();
  const left = page.getByRole("group", { name: "Left phone" });
  const right = page.getByRole("group", { name: "Right phone" });
  await expect(left.getByRole("heading", { name: "Left phone" })).toBeVisible();
  await expect(right.getByRole("heading", { name: "Right phone" })).toBeVisible();
  await expect(left.getByLabel("Which camera?")).toHaveValue("iPhone 13 Pro Max");
  await expect(right.getByLabel("Which camera?")).toHaveValue("iPhone 13 Pro Max"); // starts as the left one
  await right.getByLabel("Which camera?").selectOption("iPhone 11");
  await expect(left.getByRole("radio", { name: /Ultra wide/ })).toBeChecked();
  await expect(right.getByRole("radio", { name: /Ultra wide/ })).toBeChecked();
  await expect(left.getByLabel("Which camera?")).toHaveValue("iPhone 13 Pro Max");
  await shot(page, "16-two-phones");
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page).toHaveURL(/#\/project\/\w+/);
  const id = (await mockState()).projects[0].id;
  expect((await mockState()).projects[0]).toMatchObject({ lensId: "iphone-13-pro-max:ultra", rightLensId: "iphone-11:ultra" });
  await expect(page.locator(".facts")).toContainText("Left phone: iPhone 13 Pro Max · Ultra wide (0.5×); right phone: iPhone 11 · Ultra wide (0.5×)", { timeout: 30_000 });

  // "Change phone or lens" shows both phones; one phone for both again.
  await expect(page).toHaveURL(new RegExp(`#/edit/${id}$`), { timeout: 10_000 });
  await page.getByRole("link", { name: "Change phone or lens" }).click();
  const dialog = page.getByRole("dialog", { name: "Change phone or lens" });
  await expect(dialog.getByLabel("The two phones are different models")).toBeChecked();
  await expect(dialog.getByRole("group", { name: "Left phone" }).getByLabel("Which camera?")).toHaveValue("iPhone 13 Pro Max");
  await expect(dialog.getByRole("group", { name: "Right phone" }).getByLabel("Which camera?")).toHaveValue("iPhone 11");
  await shot(page, "17-change-two-phones");
  await dialog.getByLabel("The two phones are different models").uncheck();
  await expect(dialog.getByRole("group", { name: "Right phone" })).toBeHidden();
  await expect(dialog.getByLabel("Which camera?")).toHaveValue("iPhone 13 Pro Max");
  await dialog.getByRole("button", { name: "Process again" }).click();
  await expect(page).toHaveURL(new RegExp(`#/project/${id}$`));
  expect((await mockState()).projects[0]).toMatchObject({ lensId: "iphone-13-pro-max:ultra", rightLensId: null });
  await expect(page.locator(".facts dd").filter({ hasText: "Ultra wide" })).toHaveText("iPhone 13 Pro Max · Ultra wide (0.5×)", { timeout: 30_000 });
});

test("a re-run that fails keeps the match ready, and the editor still opens", async ({ page }) => {
  await resetMock(true);
  const id = (await mockState()).projects[0].id;
  await patchProject(id, { name: "Example match fail" }); // the mock fails its next run once
  await open(page, `/project/${id}`);
  await expect(page.getByRole("heading", { name: "Your match is ready" })).toBeVisible();
  const rerun = page.locator("details.rerun");
  await rerun.locator("summary").click();
  await rerun.getByText("Action", { exact: true }).click();
  // The page checks for news every 5 s; the open box and the choice must survive that.
  await page.waitForTimeout(6000);
  await expect(rerun).toHaveAttribute("open", "");
  await expect(rerun.getByRole("radio", { name: /Action/ })).toBeChecked();
  await rerun.getByRole("button", { name: "Run the AI again" }).click();
  await expect(page.getByText("Processing it again did not work")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Your match is ready" })).toBeVisible();
  await shot(page, "12-rerun-failed");
  await page.getByRole("link", { name: "Open the editor" }).click();
  await expectPicture(page);
  await expect(page.getByTestId("editor-warnings")).toContainText("Processing it again did not work");
});

test("editor: arrow keys and Space still step and play after using a slider or a tick box", async ({ page }) => {
  const id = await openExample(page);
  const time = page.locator(".time-label");
  await page.getByTestId("slider-smoothSeconds").click();
  const smooth = await page.getByTestId("slider-smoothSeconds").inputValue();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(time).toHaveText("0:05 / 0:20");
  expect(await page.getByTestId("slider-smoothSeconds").inputValue()).toBe(smooth);

  const skip = page.getByRole("checkbox", { name: "Skip cut parts when playing" });
  await skip.click();
  await expect(skip).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect(skip).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("save-state")).toHaveText("All changes saved", { timeout: 10_000 });
  expect((await savedEdits(id)).smoothSeconds).toBe(Number(smooth));
});

test("editor: after the preview fails mid-way, Try again brings the picture back", async ({ page }) => {
  await openExample(page);
  const view = page.getByTestId("camera-view");
  // As if VeoClone had been closed for a moment while the preview was playing.
  await page.evaluate(() => document.querySelector("video")!.dispatchEvent(new Event("error")));
  await expect(view.getByText("The preview video could not be loaded")).toBeVisible();
  await view.getByRole("button", { name: "Try again" }).click(); // a real mouse click
  await expectPicture(page);
});

test("a slow AI on the main processor is shown as a warning", async ({ page }) => {
  await resetMock();
  await page.route(`${MOCK}/api/health`, async (route) => {
    const res = await route.fetch();
    const health = await res.json();
    await route.fulfill({ response: res, json: { ...health, ai: { available: true, provider: "CPU", model: "yolo26n.onnx" } } });
  });
  await open(page, "/new");
  const pill = page.locator(".pill");
  await expect(pill).toHaveClass(/pill-warn/);
  await expect(pill).toContainText("AI on the main processor (slow)");
  await expect(page.getByText("The AI will run on the main processor")).toBeVisible();
  await shot(page, "13-slow-ai");
});

test("editor: a preview that can't be fetched is not blamed on the browser", async ({ page }) => {
  await resetMock(true);
  const id = (await mockState()).projects[0].id;
  // Like Chrome and Edge, which play the real helper's H.264 preview (this test browser can't).
  await page.addInitScript(() => {
    const canPlay = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type: string) {
      return type.includes("avc1") ? "probably" : canPlay.call(this, type);
    };
  });
  await page.route("**/proxy.mp4", (route) => route.abort("connectionreset"));
  await open(page, `/edit/${id}`);
  const view = page.getByTestId("camera-view");
  await expect(view).toContainText("The preview video could not be loaded. Make sure VeoClone is still running");
  await expect(view).not.toContainText("This browser");
});

test("text: add a match title and a player name, change them, and export with them", async ({ page }) => {
  const id = await openExample(page);
  const section = page.getByTestId("text-section");
  const words = page.getByTestId("text-words");
  const items = section.locator(".texts li");
  const time = page.locator(".time-label");
  // How many pixels of the text layer over the camera view are painted.
  const painted = () =>
    page.getByTestId("text-canvas").evaluate((c: HTMLCanvasElement) => {
      if (!c.width || !c.height) return 0;
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let count = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) count++;
      return count;
    });
  expect(await painted()).toBe(0);
  await expect(section).toContainText("Add the team names");

  // A fix, selected, so a Delete that reached the editor would remove it.
  await page.keyboard.press("k");
  await expect(page.locator(".fixes li")).toHaveCount(1);

  // Match title: team names and today's date at the top, the first line ready to type over.
  await section.getByRole("button", { name: "Match title" }).click();
  await expect(items).toHaveCount(1);
  await expect(words).toBeFocused();
  await expect(words).toHaveValue(/^Home team vs Away team\n\w{3} \d{1,2} \w{3} \d{4}$/);
  const date = (await words.inputValue()).split("\n")[1];
  await expect(page.getByTestId("text-when")).toHaveText("Shows for the whole video.");
  // Typing never triggers the editor's shortcuts: Space, K, the arrow keys, Delete.
  await page.keyboard.type("Kickers vs Roverss");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Delete");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(words).toHaveValue(`Kickers vs Rovers\n${date}`);
  await expect(items.first()).toContainText("Kickers vs Rovers");
  await expect(time).toHaveText("0:00 / 0:20");
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect(page.locator(".fixes li")).toHaveCount(1);
  // Shown live over the camera view.
  await expect.poll(painted).toBeGreaterThan(1000);
  await page.keyboard.press("Escape");
  await expect(words).not.toBeFocused();

  // Player name: 5 seconds from the playhead, bottom left.
  await clickTimeline(page, 0.5);
  await expect(time).toHaveText("0:10 / 0:20");
  const titleOnly = await painted();
  await section.getByRole("button", { name: "Player name" }).click();
  await expect(items).toHaveCount(2);
  await expect(words).toBeFocused();
  await page.keyboard.type("#7 Sam Jones");
  await expect(words).toHaveValue("#7 Sam Jones");
  await expect(page.getByTestId("text-when")).toHaveText("Shows from 0:10 to 0:15.");
  await expect(section.getByRole("button", { name: "Bottom left" })).toHaveAttribute("aria-pressed", "true");
  await section.getByRole("button", { name: "Top right" }).click();
  await expect(section.getByRole("button", { name: "Top right" })).toHaveAttribute("aria-pressed", "true");
  await section.getByRole("radio", { name: "Large" }).check();
  await expect.poll(painted).toBeGreaterThan(titleOnly);
  await shot(page, "14-editor-text");

  // Hide it from a later moment.
  await clickTimeline(page, 0.6);
  await section.getByRole("button", { name: "Hide from here" }).click();
  await expect(page.getByTestId("text-when")).toHaveText("Shows from 0:10 to 0:12.");
  await expect(section).toContainText("Not on screen at the playhead");

  // Clicking a bar on the timeline picks that text.
  const tl = (await page.getByTestId("timeline").boundingBox())!;
  await page.mouse.click(tl.x + tl.width * 0.1, tl.y + tl.height - 22 - 18 + 5);
  await expect(words).toHaveValue(`Kickers vs Rovers\n${date}`);
  await expect(time).toHaveText("0:02 / 0:20");

  // The Delete key removes the text picked last, not the fix picked before it.
  await page.keyboard.press("Delete");
  await expect(items).toHaveCount(1);
  await expect(page.locator(".fixes li")).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(items).toHaveCount(2);

  // Delete, and undo brings it back.
  await section.getByRole("button", { name: "Delete the text “#7 Sam Jones”" }).click();
  await expect(items).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(items).toHaveCount(2);

  // Autosaved with the edits.
  await expect(page.getByTestId("save-state")).toHaveText("All changes saved", { timeout: 10_000 });
  await expect.poll(async () => (await mockState()).edits[id]?.overlays?.length).toBe(2);
  const [title, player] = (await mockState()).edits[id].overlays;
  expect(title).toMatchObject({ kind: "title", text: `Kickers vs Rovers\n${date}`, position: "top-center", start: 0, end: 600 });
  expect(player).toMatchObject({ kind: "player", text: "#7 Sam Jones", position: "top-right", size: "large" });
  expect(player.end).toBeGreaterThan(player.start);

  // Export: each text as a PNG the size of the video, with when it shows.
  await page.getByRole("button", { name: "Export" }).click();
  const drawer = page.getByRole("dialog", { name: "Export your video" });
  await drawer.getByRole("button", { name: "Make video" }).click();
  await expect(drawer.getByTestId("download")).toBeVisible({ timeout: 30_000 });
  await shot(page, "15-export-text");
  const sent = (await mockState()).lastExport!;
  expect(sent.overlays).toHaveLength(2);
  for (const o of sent.overlays) {
    expect(o).toMatchObject({ width: 1920, height: 1080 });
    expect(o.bytes).toBeGreaterThan(1000);
    expect(o.bytes).toBeLessThan(4 << 20);
  }
  expect(sent.overlays[0].ranges).toEqual([[0, 20]]);
  expect(sent.overlays[1].ranges).toEqual([[player.start / 30, player.end / 30]]);
});
