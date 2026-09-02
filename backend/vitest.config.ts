import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@radioso/crawler": fileURLToPath(new URL("../packages/crawler/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["./tests/support/integrationDatabaseGlobalSetup.ts"],
    setupFiles: ["./tests/support/loadEnv.ts"],
    testTimeout: 10_000,
    coverage: {
      reporter: ["text", "lcov"],
    },
  },
});
