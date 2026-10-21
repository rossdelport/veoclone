// Playwright UI tests (tests/ui/*.spec.ts) against the built editor
// (vite preview) and the mock helper (dev/mock-helper.mjs).
// Run: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run test:ui
import { defineConfig } from "@playwright/test";

export const MOCK_PORT = 47991;
const WEB_PORT = 5198;
const OUT = "node_modules/.ui-test-dist";

export default defineConfig({
  testDir: "tests/ui",
  testMatch: /.*\.spec\.ts$/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1, // the tests share one mock helper
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    launchOptions: {
      // Software WebGL so the tests run on machines without a GPU.
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
    },
  },
  webServer: [
    {
      command: `node dev/mock-helper.mjs --port ${MOCK_PORT} --empty --speed 4`,
      url: `http://127.0.0.1:${MOCK_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // Builds into node_modules so it never touches dist/.
      command: `npx vite build --logLevel warn --outDir ${OUT} --emptyOutDir && npx vite preview --outDir ${OUT} --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}/`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
