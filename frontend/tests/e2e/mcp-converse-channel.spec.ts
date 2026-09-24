import { expect, test, type Page } from "@playwright/test";
import type { McpConnection } from '@/lib/api-external-skills';

import {
  baseSkillCapabilities,
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
  await expect(card.getByText("Not enabled", { exact: true })).toBeVisible();
  await expect(card.getByText("Not enabled on this deployment.")).toBeVisible();
  await expect(card.getByRole("link", { name: /Deployment setup guide/ })).toBeVisible();

  await expect(card.getByRole("button", { name: "Connect a client" })).toHaveCount(0);
  await expect(page.locator('#mcp-skill-connections')).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Copy MCP server URL" })).toHaveCount(0);
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
  // Revoked access leaves the inventory outright: no row, no badge, no history to reopen.
  await expect(card.getByText("Acme pilot")).toHaveCount(0);
  await expect(card.getByText("Revoked", { exact: true })).toHaveCount(0);
  await expect(card.locator('summary').filter({ hasText: 'Revoked access' })).toHaveCount(0);
  await expect(card.getByText("Claude Code", { exact: true })).toBeVisible();
  await openRowMenu(page, 'Claude Code');
  await page.getByRole('menuitem', { name: 'Details', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('Skills manages MCP connections in a panel without leaving the page', async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {});
  await stubRuntimeConfig(page, { mcpUrl: MCP_SERVER_URL });
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);
  await expect(page.getByRole('tab', { name: 'Connections', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Manage MCP connections', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'MCP connections', exact: true });
  await expect(panel.getByLabel('Server URL', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/anchor=assistant-skills/);
  await expect(page.locator('#mcp-channel')).toHaveCount(0);
  await panel.getByLabel('Display name', { exact: true }).fill('Support tools');
  await panel.getByLabel('Server URL', { exact: true }).fill(MCP_SERVER_URL);
  await panel.getByLabel('Access token', { exact: true }).fill('test-token');
  await panel.getByRole('button', { name: 'Save connection', exact: true }).click();
  await expect(panel.getByText('Support tools', { exact: true })).toBeVisible();
  await expect(panel).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: '../.context/mcp-servers-panel.png', fullPage: true });
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByRole('tab', { name: 'Skills', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Manage MCP connections', exact: true }).click();
  await expect(panel.getByText('Support tools', { exact: true })).toBeVisible();
  await expect(panel).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: '../.context/mcp-servers-panel-mobile.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});

test('adding an MCP skill opens server setup and returns with refreshed targets', async ({ page }) => {
  const capabilities = baseSkillCapabilities();
  const mcp = capabilities.find((capability) => capability.id === 'mcp_tool')!;
  mcp.available = false;
  mcp.targets = [];
  mcp.unavailableReason = 'no_connection';
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { skillCapabilities: capabilities });
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);
  await page.getByRole('button', { name: 'Add new skill', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Add new skill', exact: true });
  await picker.getByRole('button', { name: 'Manage MCP connections', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'MCP connections', exact: true });
  await expect(picker).toBeHidden();
  await panel.getByLabel('Display name', { exact: true }).fill('Support tools');
  await panel.getByLabel('Server URL', { exact: true }).fill(MCP_SERVER_URL);
  await panel.getByLabel('Access token', { exact: true }).fill('test-token');
  await panel.getByRole('button', { name: 'Save connection', exact: true }).click();
  await expect(panel.getByText('Support tools', { exact: true })).toBeVisible();
  mcp.available = true;
  mcp.unavailableReason = null;
  mcp.targets = [{ id: 'new-server', label: 'Support tools', status: 'authorized' }];
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('button', { name: /MCP Tool/ })).toBeEnabled();
  await expect(page).toHaveURL(/anchor=assistant-skills/);
});

test('Test connection discovers tools, reports failures, and supports retry without invoking tools', async ({ page }) => {
  await seedDashboardStorage(page);
  const connection: McpConnection = {
    id: 'support-server', displayName: 'Support tools', serverUrl: MCP_SERVER_URL,
    authMethod: 'oauth', status: 'authorized', hasCredential: true,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
  await installDashboardApiMocks(page, {
    mcpConnections: [connection],
  });
  let releaseFirstRequest!: () => void;
  const firstRequest = new Promise<void>((resolve) => { releaseFirstRequest = resolve; });
  let attempts = 0;
  const posts: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.startsWith('/backend/api/v1/agents/')) posts.push(path);
  });
  await page.route('**/mcp-connections/support-server/discover', async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await firstRequest;
      await route.fulfill({ json: { tools: [{ name: 'search' }, { name: 'ask_agent' }] } });
    } else if (attempts === 2) {
      await route.fulfill({ status: 500, json: { error: { code: 'internal_error', message: 'Internal server error' } } });
    } else if (attempts === 3) {
      connection.status = 'needs_reauth';
      await route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'This connection needs re-authorization before tools can be discovered.' } } });
    } else {
      connection.status = 'authorized';
      await route.fulfill({ json: { tools: [] } });
    }
  });
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);
  await page.getByRole('button', { name: 'Manage MCP connections', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'MCP connections', exact: true });
  const testButton = panel.getByRole('button', { name: 'Test connection to Support tools', exact: true });
  const connectionResult = panel.getByRole('status', { name: '', exact: true });
  await expect(panel.getByText('Credentials saved', { exact: true })).toBeVisible();
  await testButton.click();
  await expect(testButton).toBeDisabled();
  await expect(testButton).toHaveText('Testing…');
  releaseFirstRequest();
  await expect(connectionResult).toHaveText('Connected · 2 tools found');
  await testButton.click();
  await expect(panel.getByRole('alert')).toContainText('Check the server URL and credentials');
  await expect(connectionResult).toHaveCount(0);
  await testButton.click();
  await expect(panel.getByRole('alert')).toContainText('needs re-authorization');
  await expect(panel.getByRole('button', { name: 'Re-authorize', exact: true })).toBeVisible();
  await testButton.click();
  await expect(connectionResult).toHaveText('Connected · 0 tools found');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Re-authorize', exact: true })).toHaveCount(0);
  expect(posts).toEqual(Array(4).fill(`/backend/api/v1/agents/${defaultAgentId}/mcp-connections/support-server/discover`));
  await page.screenshot({ path: '../.context/mcp-test-connection.png', fullPage: true });
});

test('the inventory lists only live access and pages older active access', async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {});
  await stubRuntimeConfig(page, { mcpUrl: MCP_SERVER_URL });
  const live: AgentChannelCredentialFixture = {
    id: 'live', audience: 'mcp', label: 'Working client', prefix: 'rd_live', status: 'active',
    createdAt: '2026-01-01T00:00:00Z', expiresAt: '2030-01-01T00:00:00Z',
    lastUsedAt: null, revokedAt: null,
  };
  await page.route('**/backend/api/v1/agents/*/channel-credentials?*', async (route) => {
    const nextPage = new URL(route.request().url()).searchParams.has('cursor');
    await route.fulfill({ json: {
      credentials: nextPage
        ? [{ ...live, id: 'older', label: 'Older client' }]
        : [live, { ...live, id: 'paused', label: 'Paused client', status: 'disabled' }],
      nextCursor: nextPage ? null : 'older',
    } });
  });
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=mcp-channel`);
  const card = page.locator('#mcp-channel');
  await expect(card.getByText('Working client', { exact: true })).toBeVisible();
  // Disabled access is restorable, not retired, so it stays on the list with its badge.
  await expect(card.getByText('Paused client', { exact: true })).toBeVisible();
  await expect(card.getByText('Disabled', { exact: true })).toBeVisible();
  await expect(card.locator('summary').filter({ hasText: 'Revoked access' })).toHaveCount(0);
  await expect(card.getByText('No clients connected yet.')).toHaveCount(0);
  await card.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(card.getByText('Older client', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0);
  await page.screenshot({ path: '../.context/mcp-channel-ux.png', fullPage: true });
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

test("operator opens the agent to credential-free callers and rotates its public id", async ({ page }) => {
  const agentUpdates: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { agentUpdates });
  await stubRuntimeConfig(page, { mcpUrl: MCP_SERVER_URL });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=mcp-channel`);

  const card = page.locator("#mcp-channel");
  await expect(card.getByText("Open access", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Copy agent public id" })).toHaveCount(0);
  await expect(card.getByLabel("New conversations per hour")).toHaveCount(0);

  // Opening the door publishes the card with it, and the id appears once.
  await card.getByRole("switch", { name: "Allow connecting without a credential" }).click();
  await expect(card.getByRole("button", { name: "Copy agent public id" })).toBeVisible();
  await expect(card.getByRole("switch", { name: "Publish the agent card" })).toBeChecked();
  await expect.poll(() => agentUpdates.at(-1)).toMatchObject({
    agentCardEnabled: true,
    publicAgentAccessEnabled: true,
  });

  await card.getByLabel("Description").fill("Answers questions about orders and returns.");
  await card.getByLabel("New conversations per hour").fill("40");
  await card.getByLabel("New conversations per hour").blur();
  await expect.poll(() => agentUpdates.at(-1)).toMatchObject({ walkInConversationsPerHour: 40 });

  const firstPublicId = await card.getByText(/^ag_/).innerText();

  await card.getByRole("button", { name: "Rotate" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Rotate the public id?" });
  await expect(confirm.getByText(/disconnected on its next request/i)).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(card.getByText(firstPublicId)).toBeVisible();

  await card.getByRole("button", { name: "Rotate" }).click();
  await page.getByRole("alertdialog", { name: "Rotate the public id?" }).getByRole("button", { name: "Rotate" }).click();
  await expect(card.getByText(firstPublicId)).toHaveCount(0);
  await expect(card.getByText(/^ag_/)).toBeVisible();

  // Taking the card down closes the credential-free door with it.
  await card.getByRole("switch", { name: "Publish the agent card" }).click();
  await expect.poll(() => agentUpdates.at(-1)).toMatchObject({
    agentCardEnabled: false,
    publicAgentAccessEnabled: false,
  });
  await expect(card.getByLabel("New conversations per hour")).toHaveCount(0);
});
