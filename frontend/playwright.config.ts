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
  timeout: 30_000,
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
