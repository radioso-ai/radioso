import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
  type AgentChannelCredentialFixture,
} from "./dashboard-fixtures";

test("operator creates, copies, and revokes an MCP converse credential", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  const existingGrant: AgentChannelCredentialFixture = {
    id: "existing-grant",
    audience: "mcp",
    label: "Acme pilot",
    prefix: "radioso_mcp_conv",
    status: "active",
    createdAt: "2026-04-26T12:00:00.000Z",
    expiresAt: "2026-11-29T23:59:59.000Z",
    lastUsedAt: null,
    revokedAt: null,
  };
  const grantRequests: Array<{ method: "GET" | "POST"; path: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    agentChannelCredentials: [existingGrant],
    agentChannelCredentialRequests: grantRequests,
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=mcp-channel`);

  await expect(page.getByRole("heading", { name: "MCP", exact: true, level: 3 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "MCP converse credential" })).toHaveCount(0);
  await expect(page.getByText("Connect your client")).toHaveCount(0);
  await expect(page.getByText("Acme pilot")).toBeVisible();

  await page.getByLabel("Credential label").fill("Customer handoff");
  await page.getByRole("button", { name: "Create credential" }).click();

  // The mock issues tokens at index grants.length + 1; one grant is seeded above, so the
  // first created token is index 2.
  const issuedToken = "radioso_mcp_2_plaintext";
  await expect(page.getByText(issuedToken)).toBeVisible();
  await expect(page.getByText("Shown once")).toBeVisible();
  // Same-host merged MCP is intentionally unavailable. The grant lifecycle remains usable,
  // but no client config should be generated for the unsupported same-host transport.
  await expect(page.getByText(`Bearer ${issuedToken}`)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy mcp converse client config instruction" })).toHaveCount(0);

  await page.getByRole("button", { name: "Copy MCP credential secret" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(issuedToken);

  await expect.poll(() =>
    grantRequests.some((request) =>
      request.method === "POST" &&
      request.path === `/agents/${defaultAgentId}/channel-credentials` &&
      (request.body as { audience?: string; label?: string; expiresAt?: string }).audience === "mcp" &&
      (request.body as { audience?: string; label?: string; expiresAt?: string }).label === "Customer handoff" &&
      Boolean((request.body as { expiresAt?: string }).expiresAt),
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

  await existingGrantRow.getByRole("button", { name: "Rotate" }).click();
  const rotateDialog = page.getByRole("alertdialog", { name: "Rotate Acme pilot?" });
  await expect(rotateDialog.getByText(/current secret will stop working immediately/i)).toBeVisible();
  await rotateDialog.getByRole("button", { name: "Cancel" }).click();
  expect(grantRequests.some((request) => request.path.endsWith("/existing-grant/rotate"))).toBe(false);

  await existingGrantRow.getByRole("button", { name: "Rotate" }).click();
  await page.getByRole("alertdialog", { name: "Rotate Acme pilot?" }).getByRole("button", { name: "Rotate credential" }).click();
  await expect.poll(() => grantRequests.some((request) =>
    request.method === "POST" && request.path === `/agents/${defaultAgentId}/channel-credentials/existing-grant/rotate`,
  )).toBe(true);

  await existingGrantRow.getByRole("button", { name: "Revoke" }).click();
  const revokeDialog = page.getByRole("alertdialog", { name: "Revoke Acme pilot?" });
  await expect(revokeDialog.getByText(/cannot be restored/i)).toBeVisible();
  await revokeDialog.getByRole("button", { name: "Revoke credential" }).click();

  await expect.poll(() =>
    grantRequests.some((request) =>
      request.method === "POST" &&
      request.path === `/agents/${defaultAgentId}/channel-credentials/existing-grant/revoke`,
    ),
  ).toBe(true);
});

test("operator creates a separate role-free REST credential for the explicit agent chat endpoint", async ({ page }) => {
  const credentialRequests: Array<{ method: "GET" | "POST"; path: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    agentChannelCredentialRequests: credentialRequests,
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=api-channel`);

  await expect(page.getByText(`/api/v1/agents/${defaultAgentId}/chat`, { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent API credentials" })).toBeVisible();
  await expect(page.getByLabel("Role")).toHaveCount(0);
  await page.getByLabel("Credential label").fill("Production chat client");
  await expect(page.getByLabel("Expires")).not.toHaveValue("");
  await page.getByRole("button", { name: "Create credential" }).click();

  await expect(page.getByText("radioso_rest_1_plaintext")).toBeVisible();
  await expect.poll(() => credentialRequests.some((request) => {
    const body = request.body as { audience?: string; label?: string; expiresAt?: string } | undefined;
    return request.method === "POST"
      && request.path === `/agents/${defaultAgentId}/channel-credentials`
      && body?.audience === "rest"
      && body.label === "Production chat client"
      && Boolean(body.expiresAt);
  })).toBe(true);
});
