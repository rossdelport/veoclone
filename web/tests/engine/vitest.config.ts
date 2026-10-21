// Runs the engine unit tests: npx vitest run --config tests/engine/vitest.config.ts
// (they also run with `npm test` once vite.config.ts includes "tests/**/*.test.ts").
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: { environment: "node", include: ["tests/engine/**/*.test.ts"] },
});
