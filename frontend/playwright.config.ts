import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3210);
const host = process.env.PLAYWRIGHT_HOST ?? "127.0.0.1";
const baseURL = `http://${host}:${port}`;
const webServerCommand = process.env.CI
  ? `pnpm exec next start --port ${port} --hostname ${host}`
  : `pnpm exec next dev --webpack --port ${port} --hostname ${host}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  reporter: "list",
  // CI serves a prebuilt bundle, so 30s is the test's own budget and a real signal. A local
  // run serves `next dev`, where the first visit to a route compiles it on demand — a cost
  // that lands inside whichever test happens to arrive first, and grows with the number of
  // workers competing for it. Holding local runs to the CI budget makes a cold server report
  // compilation as unrelated test failures, so local gets room for it instead.
  timeout: process.env.CI ? 30_000 : 90_000,
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    command: webServerCommand,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
