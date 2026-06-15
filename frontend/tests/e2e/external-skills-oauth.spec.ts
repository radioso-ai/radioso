import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

test("operator creates an OAuth MCP connection and starts the authorize flow", async ({ page }) => {
  const mcpConnectionRequests: string[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { mcpConnections: [], mcpConnectionRequests });

  // Capture window.open so the external consent redirect does not navigate in-test.
  await page.addInitScript(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = ((url?: string | URL) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(url));
      return null;
    }) as typeof window.open;
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);

  await expect(page.getByRole("heading", { name: "External MCP skills" })).toBeVisible();

  await page.getByLabel("Display name").fill("Scheduler");
  await page.getByLabel("Server URL").fill("https://mcp.example.com/mcp");

  // Switch to OAuth and fill the client configuration.
  await page.getByLabel("Authentication").click();
  await page.getByRole("option", { name: "OAuth" }).click();
  await page.getByLabel("Authorization endpoint").fill("https://auth.example.com/authorize");
  await page.getByLabel("Token endpoint").fill("https://auth.example.com/token");
  await page.getByLabel("Client ID").fill("client-123");

  await page.getByRole("button", { name: "Save server" }).click();

  // The new connection appears as not-yet-verified with an Authorize action.
  const connectionRow = page.locator("div", { hasText: "Scheduler" }).first();
  await expect(page.getByText("Not verified")).toBeVisible();
  const authorizeButton = page.getByRole("button", { name: "Authorize" });
  await expect(authorizeButton).toBeVisible();

  await authorizeButton.click();

  await expect
    .poll(() => mcpConnectionRequests.some((entry) => entry.includes("/oauth/authorize")))
    .toBe(true);
  await expect
    .poll(async () => {
      const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
      return opened.some((url) => url.startsWith("https://auth.example.com/authorize"));
    })
    .toBe(true);
});
