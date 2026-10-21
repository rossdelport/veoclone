// Playwright config for the editor engine's WebGL tests (tests/engine/*.pw.ts).
// Run: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx playwright test -c playwright.engine.config.ts
import { defineConfig } from "@playwright/test";

const PORT = 5191;

export default defineConfig({
  testDir: "tests/engine",
  testMatch: /.*\.pw\.ts$/,
  timeout: 120_000,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: "chromium",
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 1,
    launchOptions: {
      // Software WebGL so the tests run on machines without a GPU.
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    },
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/test-pages/engine.html`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
