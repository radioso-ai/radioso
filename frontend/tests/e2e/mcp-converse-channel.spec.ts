import { expect, test, type Page } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
  type AgentChannelCredentialFixture,
} from "./dashboard-fixtures";

const MCP_SERVER_URL = "https://mcp.example.com/mcp";
const PUBLIC_API_URL = "https://api.example.com";

const stubRuntimeConfig = async (page: Page, config: { mcpUrl?: string; publicApiUrl?: string }) => {
  await page.route("**/runtime-config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ mcpUrl: config.mcpUrl ?? "", publicApiUrl: config.publicApiUrl ?? "" }),
    });
  });
};

const acknowledgeAndFinish = async (page: Page, dialogName: string | RegExp) => {
  const dialog = page.getByRole("dialog", { name: dialogName });
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
};

const openRowMenu = async (page: Page, label: string) => {
  await page.getByRole("button", { name: `Actions for ${label}` }).click();
};

test("the MCP card offers only the deployment guide when no MCP server is configured", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {});
  await stubRuntimeConfig(page, {});

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=mcp-channel`);

  const card = page.locator("#mcp-channel");
  await expect(card.getByRole("heading", { name: "MCP", exact: true, level: 3 })).toBeVisible();
  await expect(card.getByText("Not enabled")).toBeVisible();
  await expect(card.getByText("Not enabled on this deployment.")).toBeVisible();
  await expect(card.getByRole("link", { name: /Deployment setup guide/ })).toBeVisible();

  await expect(card.getByRole("button", { name: "Connect a client" })).toHaveCount(0);
  await expect(card.getByText("MCP server")).toHaveCount(0);
  await expect(card.getByText("Connected clients")).toHaveCount(0);
});

test("operator connects an MCP client, rotates it, and revokes it", async ({ page }) => {
  const existingClient: AgentChannelCredentialFixture = {
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
  const credentialRequests: Array<{ method: "GET" | "POST"; path: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    agentChannelCredentials: [existingClient],
    agentChannelCredentialRequests: credentialRequests,
  });
  await stubRuntimeConfig(page, { mcpUrl: MCP_SERVER_URL });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=mcp-channel`);

  const card = page.locator("#mcp-channel");
  await expect(card.getByText("Enabled", { exact: true })).toBeVisible();
  await expect(card.getByText(MCP_SERVER_URL)).toBeVisible();
  await expect(card.getByText("Acme pilot")).toBeVisible();

  await card.getByRole("button", { name: "Connect a client" }).click();
  const connectDialog = page.getByRole("dialog", { name: "Connect a client" });
  await connectDialog.getByRole("radio", { name: "Claude Code" }).check();
  await expect(connectDialog.getByLabel("Label")).toHaveValue("Claude Code");
  await expect(connectDialog.getByLabel("Expires")).not.toHaveValue("");
  await connectDialog.getByRole("button", { name: "Create credential & get config" }).click();

  // The mock issues tokens at index credentials.length + 1; one client is seeded above.
  const issuedSecret = "radioso_mcp_2_plaintext";
  const configDialog = page.getByRole("dialog", { name: "Finish connecting — Claude Code" });
  await expect(configDialog.getByText(`claude mcp add --transport http radioso ${MCP_SERVER_URL}`)).toBeVisible();
  await expect(configDialog.getByText(`Bearer ${issuedSecret}`)).toBeVisible();

  await expect.poll(() => credentialRequests.some((request) => {
    const body = request.body as { audience?: string; label?: string; expiresAt?: string } | undefined;
    return request.method === "POST"
      && request.path === `/agents/${defaultAgentId}/channel-credentials`
      && body?.audience === "mcp"
      && body.label === "Claude Code"
      && Boolean(body.expiresAt);
  })).toBe(true);

  await acknowledgeAndFinish(page, "Finish connecting — Claude Code");
  await expect(page.getByText(issuedSecret)).toHaveCount(0);

  await openRowMenu(page, "Acme pilot");
  await page.getByRole("menuitem", { name: "Rotate" }).click();
  const rotateConfirm = page.getByRole("alertdialog", { name: "Rotate Acme pilot?" });
  await expect(rotateConfirm.getByText(/current secret stops working immediately/i)).toBeVisible();
  await rotateConfirm.getByRole("button", { name: "Cancel" }).click();
  expect(credentialRequests.some((request) => request.path.endsWith("/existing-grant/rotate"))).toBe(false);

  await openRowMenu(page, "Acme pilot");
  await page.getByRole("menuitem", { name: "Rotate" }).click();
  await page.getByRole("alertdialog", { name: "Rotate Acme pilot?" }).getByRole("button", { name: "Rotate credential" }).click();
  await expect.poll(() => credentialRequests.some((request) =>
    request.method === "POST" && request.path === `/agents/${defaultAgentId}/channel-credentials/existing-grant/rotate`,
  )).toBe(true);

  // A rotation has no recorded client, so the dialog offers the generic server block.
  const rotatedDialog = page.getByRole("dialog", { name: "Credential issued" });
  await expect(rotatedDialog.getByText("radioso_agent_rotated_existing-grant").first()).toBeVisible();
  await expect(rotatedDialog.getByText('"mcpServers"')).toBeVisible();
  await acknowledgeAndFinish(page, "Credential issued");

  await openRowMenu(page, "Acme pilot");
  await page.getByRole("menuitem", { name: "Revoke" }).click();
  const revokeConfirm = page.getByRole("alertdialog", { name: "Revoke Acme pilot?" });
  await expect(revokeConfirm.getByText(/stops working immediately\. Cannot be undone\./)).toBeVisible();
  await revokeConfirm.getByRole("button", { name: "Revoke" }).click();

  await expect.poll(() => credentialRequests.some((request) =>
    request.method === "POST" && request.path === `/agents/${defaultAgentId}/channel-credentials/existing-grant/revoke`,
  )).toBe(true);
  await expect(card.getByText("Revoked", { exact: true })).toBeVisible();
});

test("operator creates a role-free Agent API credential against the canonical endpoint", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  const credentialRequests: Array<{ method: "GET" | "POST"; path: string; body?: unknown }> = [];
  const existingRest: AgentChannelCredentialFixture = {
    id: "existing-rest-grant",
    audience: "rest",
    label: "Existing REST client",
    prefix: "radioso_rest_old",
    status: "active",
    createdAt: "2026-04-26T12:00:00.000Z",
    expiresAt: "2026-11-29T23:59:59.000Z",
    lastUsedAt: null,
    revokedAt: null,
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    agentChannelCredentials: [existingRest],
    agentChannelCredentialRequests: credentialRequests,
  });
  await stubRuntimeConfig(page, { publicApiUrl: PUBLIC_API_URL });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=api-channel`);

  const card = page.locator("#api-channel");
  await expect(card.getByRole("heading", { name: "Agent API", exact: true, level: 3 })).toBeVisible();
  await expect(card.getByRole("heading", { name: "Credentials", level: 4 })).toBeVisible();
  await expect(card.getByText(`${PUBLIC_API_URL}/api/v1/agents/${defaultAgentId}/chat`).first()).toBeVisible();
  await expect(card.getByLabel("Role")).toHaveCount(0);

  await card.getByLabel("Credential label").fill("Production chat client");
  await expect(card.getByLabel("Expires")).not.toHaveValue("");
  await card.getByRole("button", { name: "Create credential" }).click();

  const issuedSecret = "radioso_rest_2_plaintext";
  const issuedDialog = page.getByRole("dialog", { name: "Credential issued" });
  await expect(issuedDialog.getByText(issuedSecret)).toBeVisible();
  await issuedDialog.getByRole("button", { name: "Copy Agent API credential secret" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(issuedSecret);
  await acknowledgeAndFinish(page, "Credential issued");
  await expect(page.getByText(issuedSecret)).toHaveCount(0);

  await expect.poll(() => credentialRequests.some((request) => {
    const body = request.body as { audience?: string; label?: string; expiresAt?: string } | undefined;
    return request.method === "POST"
      && request.path === `/agents/${defaultAgentId}/channel-credentials`
      && body?.audience === "rest"
      && body.label === "Production chat client"
      && Boolean(body.expiresAt);
  })).toBe(true);

  await openRowMenu(page, "Existing REST client");
  await page.getByRole("menuitem", { name: "Details" }).click();
  const detailsDialog = page.getByRole("dialog", { name: "Existing REST client" });
  await expect(detailsDialog.getByText("Last used never")).toBeVisible();
  await detailsDialog.getByRole("button", { name: "Done" }).click();

  await openRowMenu(page, "Existing REST client");
  await page.getByRole("menuitem", { name: "Rotate" }).click();
  await page.getByRole("alertdialog", { name: "Rotate Existing REST client?" }).getByRole("button", { name: "Rotate credential" }).click();
  await expect(page.getByRole("dialog", { name: "Credential issued" }).getByText("radioso_agent_rotated_existing-rest-grant")).toBeVisible();
  await acknowledgeAndFinish(page, "Credential issued");
  await expect.poll(() => credentialRequests.some((request) =>
    request.method === "POST" && request.path === `/agents/${defaultAgentId}/channel-credentials/existing-rest-grant/rotate`,
  )).toBe(true);
});
