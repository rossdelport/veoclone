// WebGL renderers vs the CPU mirror of the shader (projection.ts sampleRay),
// on a synthetic stacked texture. Runs in headless Chromium with SwiftShader.
import { expect, test, type Page } from "@playwright/test";

type Stats = { width: number; height: number; pixels: number; litPixels: number; meanAbs: number; maxAbs: number; over3: number; worst: unknown[] };

async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("/test-pages/engine.html");
  await page.waitForFunction(() => "engineTest" in window);
  return errors;
}

// minLit = share of pixels that show video (the rest is black, outside the cameras)
const poses = [
  { yaw: 0, pitch: 0, fov: 40, minLit: 0.9 }, // the seam: both cameras + blend
  { yaw: 0.6, pitch: -0.1, fov: 30, minLit: 0.95 }, // left camera
  { yaw: -0.7, pitch: 0.1, fov: 25, minLit: 0.85 }, // right camera
  { yaw: 0.05, pitch: -0.3, fov: 52, minLit: 0.5 }, // wide, near the bottom edge
  { yaw: 1.6, pitch: 0.5, fov: 60, minLit: 0.1 }, // mostly outside the coverage
];

test("camera view matches the CPU mirror pixel for pixel", async ({ page }) => {
  const errors = await open(page);
  await page.evaluate(() => (window as any).engineTest.setup());
  for (const pose of poses) {
    const s: Stats = await page.evaluate((p) => (window as any).engineTest.compareView(p), pose);
    console.log("view", JSON.stringify(pose), `mean ${s.meanAbs.toFixed(3)} max ${s.maxAbs} >3: ${s.over3}/${s.pixels} lit ${s.litPixels}`);
    expect(s.width).toBe(320);
    expect(s.height).toBe(180);
    expect(s.litPixels).toBeGreaterThan(s.pixels * pose.minLit);
    expect(s.meanAbs).toBeLessThan(0.6);
    // only pixels right on a coverage edge may differ by more than 3 levels
    expect(s.over3, JSON.stringify(s.worst)).toBeLessThan(s.pixels * 0.003);
  }
  expect(errors).toEqual([]);
});

test("overview matches the CPU mirror and maps canvas <-> yaw/pitch", async ({ page }) => {
  const errors = await open(page);
  await page.evaluate(() => (window as any).engineTest.setup());
  const s: Stats = await page.evaluate(() => (window as any).engineTest.compareOverview());
  console.log("overview", `mean ${s.meanAbs.toFixed(3)} max ${s.maxAbs} >3: ${s.over3}/${s.pixels} lit ${s.litPixels}`);
  expect(s.litPixels).toBeGreaterThan(s.pixels * 0.3);
  expect(s.meanAbs).toBeLessThan(0.6);
  expect(s.over3, JSON.stringify(s.worst)).toBeLessThan(s.pixels * 0.005);

  const m = await page.evaluate(() => (window as any).engineTest.overviewMapping());
  const [tl, , br, mid] = m.points;
  expect(tl.yp.yaw).toBeCloseTo(m.extent.yawMax, 9); // left edge = largest yaw
  expect(tl.yp.pitch).toBeCloseTo(m.extent.pitchMax, 9); // top = highest pitch
  expect(br.yp.yaw).toBeCloseTo(m.extent.yawMin, 9);
  expect(br.yp.pitch).toBeCloseTo(m.extent.pitchMin, 9);
  expect(mid.yp.yaw).toBeCloseTo((m.extent.yawMin + m.extent.yawMax) / 2, 9);
  for (const p of m.points) {
    expect(p.back.x).toBeCloseTo(p.x, 9);
    expect(p.back.y).toBeCloseTo(p.y, 9);
  }
  expect(errors).toEqual([]);
});

test("survives losing the GPU context and draws again once it is back", async ({ page }) => {
  const errors = await open(page);
  await page.evaluate(() => (window as any).engineTest.setup());
  const r = await page.evaluate((p) => (window as any).engineTest.loseAndRestore(p), poses[0]);
  expect(r.threw).toBe(false);
  expect(r.after.meanAbs).toBeLessThan(0.6);
  expect(r.after.litPixels).toBeGreaterThan(r.after.pixels * 0.2);
  expect(errors).toEqual([]);
});

test.describe("on a HiDPI screen", () => {
  test.use({ deviceScaleFactor: 2 });
  test("draws at device pixels and still matches", async ({ page }) => {
    const errors = await open(page);
    await page.evaluate(() => (window as any).engineTest.setup());
    const s: Stats = await page.evaluate((p) => (window as any).engineTest.compareView(p), poses[1]);
    expect([s.width, s.height]).toEqual([640, 360]);
    expect(s.meanAbs).toBeLessThan(0.6);
    expect(s.over3).toBeLessThan(s.pixels * 0.003);
    const m = await page.evaluate(() => (window as any).engineTest.overviewMapping());
    expect(m.cssWidth).toBe(400); // canvas <-> yaw/pitch stays in CSS pixels
    expect(errors).toEqual([]);
  });
});
