import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./integrationDatabaseGlobalSetup.ts"],
    include: ["src/**/*.test.ts"],
  },
});
