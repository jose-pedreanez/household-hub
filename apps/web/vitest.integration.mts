import path from "node:path";
import { defineConfig } from "vitest/config";

// Live integration tests: need the Docker stack running and seeded (scripts/bootstrap.sh, scripts/seed-demo.mjs).
export default defineConfig({
  resolve: {
    alias: {
      "@": import.meta.dirname,
      "server-only": path.resolve(import.meta.dirname, "tests/support/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
