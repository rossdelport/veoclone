// VeoClone updating itself (DESIGN.md 4.11), against the mock helper.
import { expect, test } from "@playwright/test";
import { MOCK, open, resetMock, shot } from "./helpers";

interface MockUpdate {
  status: { state: string; message?: string };
  settings: { autoUpdate: boolean; startWithWindows: boolean | null };
  checks: number;
  installs: number;
  settingsPatches: Record<string, unknown>[];
}

async function mockUpdate(body?: Record<string, unknown>): Promise<MockUpdate> {
  const res = await fetch(`${MOCK}/__mock/update`, body ? { method: "POST", body: JSON.stringify(body) } : undefined);
  expect(res.ok).toBe(true);
  return (await res.json()) as MockUpdate;
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("page error:", e.message));
});

test("updates: the home page says VeoClone is up to date, and the settings work", async ({ page }) => {
  await resetMock();
  await open(page, "/");
  const card = page.getByTestId("veoclone-card");
  await expect(card).toContainText("VeoClone is up to date.");
  await expect(card).toContainText("This is VeoClone version of 20 Oct 2026 (1a2b3c4).");
  await expect(page.locator(".pill")).toHaveAttribute("title", /^Connected to VeoClone version of 20 Oct 2026 \(1a2b3c4\)\nVeoClone is up to date\./);
  // Nothing about updates gets in the way while all is well.
  await expect(page.getByTestId("update-banner")).toHaveCount(0);

  await card.getByRole("button", { name: "Check for updates" }).click();
  await expect(card).toContainText("Checking for updates…");
  await expect(card.getByTestId("update-status")).toHaveAttribute("data-state", "up-to-date", { timeout: 10_000 });
  expect((await mockUpdate()).checks).toBe(1);

  const auto = card.getByLabel("Update VeoClone automatically");
  await expect(auto).toBeChecked();
  await auto.uncheck();
  await expect(card).toContainText("Automatic updates are off.");
  await expect(page.locator(".toast").filter({ hasText: "Automatic updates are off" })).toBeVisible();
  const startup = card.getByLabel("Start VeoClone when Windows starts");
  await expect(startup).not.toBeChecked();
  await startup.check();
  await expect(page.locator(".toast").filter({ hasText: "VeoClone will start when Windows starts" })).toBeVisible();
  const state = await mockUpdate();
  expect(state.settingsPatches).toEqual([{ autoUpdate: false }, { startWithWindows: true }]);
  expect(state.settings).toEqual({ autoUpdate: false, startWithWindows: true });
  await shot(page, "20-updates-settings");

  // Read back from VeoClone after a reload.
  await page.reload();
  await expect(card.getByLabel("Update VeoClone automatically")).not.toBeChecked();
  await expect(card.getByLabel("Start VeoClone when Windows starts")).toBeChecked();
});

test("updates: Install now restarts VeoClone with the new version, and the page waits for it", async ({ page }) => {
  await resetMock(true);
  await mockUpdate({ status: { state: "ready", message: "Update ready — it installs when nothing is processing." } });
  await open(page, "/");
  const card = page.getByTestId("veoclone-card");
  await expect(card).toContainText("Update ready — it installs when nothing is processing.");
  await expect(page.locator(".pill")).toHaveAttribute("title", /Update ready/);
  // Ready is not worth a banner on every page.
  await expect(page.getByTestId("update-banner")).toHaveCount(0);
  await shot(page, "21-update-ready");

  await card.getByRole("button", { name: "Install now" }).click();
  const banner = page.getByTestId("update-banner");
  await expect(banner).toContainText("Updating VeoClone… it will restart in a moment.");
  expect((await mockUpdate()).installs).toBe(1);
  // While it restarts: a calm note instead of "VeoClone isn't running", and the matches stay.
  await expect(banner).toContainText("VeoClone is restarting after an update…", { timeout: 15_000 });
  await shot(page, "22-update-restarting");
  await expect(page.getByTestId("helper-offline")).toHaveCount(0);
  await expect(page.locator(".pill")).toContainText("Restarting VeoClone…");
  await expect(page.getByTestId("match-card")).toHaveCount(1);
  // Back by itself, as the new version.
  await expect(page.locator(".toast").filter({ hasText: "VeoClone updated itself to the newest version." })).toBeVisible({ timeout: 20_000 });
  await expect(banner).toHaveCount(0);
  await expect(card).toContainText("This is VeoClone version of 25 Oct 2026 (9f8e7d6).");
  await expect(card).toContainText("VeoClone is up to date.");
  await expect(page.locator(".pill")).toContainText("Connected");
});

test("updates: a failed update is explained in plain words, and Try again checks again", async ({ page }) => {
  await resetMock();
  await mockUpdate({
    status: {
      state: "failed",
      message: "The update didn't download properly, so VeoClone kept the version you have. It will try again later.",
      detail: "got 12 bytes with SHA-256 00, expected 13 bytes",
    },
  });
  await open(page, "/");
  const card = page.getByTestId("veoclone-card");
  await expect(card).toContainText("The update didn't download properly, so VeoClone kept the version you have.");
  await card.getByText("Show details").click();
  await expect(card).toContainText("expected 13 bytes");
  await shot(page, "23-update-failed");
  await card.getByRole("button", { name: "Try again" }).click();
  await expect.poll(async () => (await mockUpdate()).checks).toBe(1);
  await expect(card).toContainText("VeoClone is up to date.", { timeout: 10_000 });
});

test("updates: a development copy says it doesn't update itself", async ({ page }) => {
  await resetMock();
  await mockUpdate({
    version: { number: "0.1.0", sha: "dev", date: null },
    status: { state: "disabled", message: "This is a development copy of VeoClone. It doesn't update itself.", canUpdate: false, latest: undefined },
  });
  await open(page, "/");
  const card = page.getByTestId("veoclone-card");
  await expect(card).toContainText("This is a development copy of VeoClone. It doesn't update itself.");
  await expect(card).toContainText("This is VeoClone development build.");
  await expect(card.getByRole("button", { name: "Check for updates" })).toHaveCount(0);
  await expect(card.getByLabel("Update VeoClone automatically")).toBeDisabled();
});

test("updates: a VeoClone from before it updated itself is asked to download the new one once", async ({ page }) => {
  await resetMock();
  await page.route(`${MOCK}/api/health`, async (route) => {
    const res = await route.fetch();
    const health = await res.json();
    delete health.update;
    await route.fulfill({ response: res, json: { ...health, version: "0.1.0" } });
  });
  await open(page, "/");
  const card = page.getByTestId("veoclone-card");
  await expect(card).toContainText("This copy of VeoClone doesn't update itself yet.");
  await expect(card.getByRole("link", { name: "Download VeoClone" })).toHaveAttribute(
    "href",
    "https://github.com/rossdelport/veoclone/releases/download/helper-latest/VeoClone-windows.zip",
  );
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  await expect(page.locator(".pill")).toHaveAttribute("title", /^Connected to VeoClone version 0\.1\.0\nGraphics card/);
});
