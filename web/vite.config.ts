/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// base './' so the same build works on GitHub Pages (/veoclone/) and when
// served by the helper at the root of http://127.0.0.1:47863/.
export default defineConfig({
  base: "./",
  test: { environment: "node", include: ["src/**/*.test.ts", "tests/**/*.test.ts"] },
});
