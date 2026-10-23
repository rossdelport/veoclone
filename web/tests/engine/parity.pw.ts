// Parity with Reco's export: renders real proxy frames in the browser so they
// can be compared with `reco stitch --trajectory` output of the same poses.
// Skipped unless VEOCLONE_PARITY_DIR points at a folder with proxy.webm or
// proxy.mp4 (stacked, synced, left on top), match.json and frames.json
// ([{ frame, pose }] with the poses Reco rendered, or [{ frame, input }] with
// the world poses given to Reco, which the page clamps like the export).
// The view uses match.json's rig_tilt / rig_roll. Writes browser_<frame>.png
// and browser_poses.json (the world and render poses used) into that folder.
// (Playwright's Chromium has no H.264 decoder, so use a VP9 proxy here.)
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const dir = process.env.VEOCLONE_PARITY_DIR;

test("render proxy frames for the Reco parity check", async ({ page }) => {
  test.skip(!dir, "set VEOCLONE_PARITY_DIR to run the Reco parity render");
  const folder = dir!;
  page.on("pageerror", (e) => console.log("page error:", e));
  const webm = fs.existsSync(path.join(folder, "proxy.webm"));
  const proxy = path.join(folder, webm ? "proxy.webm" : "proxy.mp4");
  await page.route("**/parity/proxy", (route) => route.fulfill({ path: proxy, contentType: webm ? "video/webm" : "video/mp4" }));
  await page.goto("/test-pages/engine.html");
  await page.waitForFunction(() => "engineTest" in window);
  const info = await page.evaluate((u) => (window as any).engineTest.loadVideo(u), "/parity/proxy");
  console.log("proxy", JSON.stringify(info));

  const match = JSON.parse(fs.readFileSync(path.join(folder, "match.json"), "utf8"));
  const frames = JSON.parse(fs.readFileSync(path.join(folder, "frames.json"), "utf8"));
  const calib = {
    fps: { num: 30, den: 1 },
    frameCount: Math.round(info.duration * 30),
    proxy: { url: "", tileWidth: info.width, tileHeight: info.height / 2, layout: "vstack" },
    match,
    coverage: { pitchMin: -1, pitchMax: 1, maxFovDeg: 60, slices: [] },
    render: { blendWidth: 0.15, lensCorrection: 1.0, outputAspect: 16 / 9 },
  };
  const out: { frame: number; mediaTime: number; png: string; pose: unknown; render: unknown }[] = await page.evaluate(
    ([c, f]) => (window as any).engineTest.renderProxyFrames(c, f, [1280, 720]),
    [calib, frames] as const,
  );
  for (const o of out) {
    console.log(`frame ${o.frame}: presented media time ${o.mediaTime.toFixed(4)} s`);
    fs.writeFileSync(path.join(folder, `browser_${o.frame}.png`), Buffer.from(o.png.split(",")[1], "base64"));
    // the frame shown is the one asked for
    if (o.mediaTime >= 0) expect(Math.round(o.mediaTime * 30)).toBe(o.frame);
  }
  fs.writeFileSync(path.join(folder, "browser_poses.json"), JSON.stringify(out.map(({ frame, pose, render }) => ({ frame, pose, render })), null, 1));
});
