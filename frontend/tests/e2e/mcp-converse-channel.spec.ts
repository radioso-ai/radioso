import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
  type McpConverseGrantFixture,
} from "./dashboard-fixtures";

test("operator creates, copies, and revokes an MCP converse credential", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  const existingGrant: McpConverseGrantFixture = {
    id: "existing-grant",
    label: "Acme pilot",
    tokenPrefix: "radioso_mcp_conv",
    enabled: true,
    createdAt: "2026-04-26T12:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
  };
  const grantRequests: Array<{ method: "GET" | "POST" | "DELETE"; path: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    mcpConverseGrants: [existingGrant],
    mcpConverseGrantRequests: grantRequests,
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=mcp-channel`);

  await expect(page.getByRole("heading", { name: "MCP converse credential" })).toBeVisible();
  await expect(page.getByText("Acme pilot")).toBeVisible();

  await page.getByLabel("Credential label").fill("Customer handoff");
  await page.getByRole("button", { name: "Create credential" }).click();

  // The mock issues tokens at index grants.length + 1; one grant is seeded above, so the
  // first created token is index 2.
  const issuedToken = "radioso_mcp_converse_2_plaintext";
  // The token legitimately appears twice (the standalone token field and embedded in the
  // JSON config), so scope to the first match.
  await expect(page.getByText(issuedToken).first()).toBeVisible();
  await expect(page.getByText("Shown once")).toBeVisible();
  await expect(page.getByText(`Bearer ${issuedToken}`)).toBeVisible();

  await page.getByRole("button", { name: "Copy MCP converse grant token" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(issuedToken);

  await page.getByRole("button", { name: "Copy mcp converse client config instruction" }).click();
  const copiedConfig = await page.evaluate(() => navigator.clipboard.readText());
  // The MCP endpoint URL is resolved from the deployment (shared with the workspace MCP
  // card), so assert the contract — the bearer is the converse grant and the URL points at
  // an /mcp endpoint — rather than hardcoding a deployment-specific host.
  const parsedConfig = JSON.parse(copiedConfig);
  expect(parsedConfig.mcpServers.radioso.headers.Authorization).toBe(`Bearer ${issuedToken}`);
  expect(typeof parsedConfig.mcpServers.radioso.url).toBe("string");
  expect(parsedConfig.mcpServers.radioso.url).toContain("/mcp");

  await expect.poll(() =>
    grantRequests.some((request) =>
      request.method === "POST" &&
      request.path === `/agents/${defaultAgentId}/mcp-converse-grants` &&
      JSON.stringify(request.body) === JSON.stringify({ label: "Customer handoff" }),
    ),
  ).toBe(true);

  const existingGrantRow = page
    .locator("div")
    .filter({
      has: page.getByText("Acme pilot", { exact: true }),
      hasNot: page.getByText("Customer handoff", { exact: true }),
    })
    .filter({ has: page.getByRole("button", { name: "Revoke" }) })
    .last();
  await existingGrantRow.getByRole("button", { name: "Revoke" }).click();

  await expect.poll(() =>
    grantRequests.some((request) =>
      request.method === "DELETE" &&
      request.path === `/agents/${defaultAgentId}/mcp-converse-grants/existing-grant`,
    ),
  ).toBe(true);
});
