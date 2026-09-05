import { expect, test, type Page } from "@playwright/test";

import {
  basePlatformSettings,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

const workspaceId = "workspace-1";
const resource = "https://mcp.example.com/operator/mcp";
const transactionId = "11111111-1111-4111-8111-111111111111";

const setupArtifacts = [
  {
    id: "codex-cli",
    displayName: "Codex CLI",
    clientVersion: "0.149.0",
    status: "unavailable",
    description: "This exact client build has not completed the compatibility gate.",
    setupInstructions: [],
    command: null,
    configuration: null,
    handoffUrl: null,
    permittedLaunchTarget: "codex CLI",
    expectedClientId: "https://codex.example/client-metadata.json",
    redirectMechanism: "browser OAuth callback",
    failureRecovery: "Start the command again if the browser authorization expires.",
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    clientVersion: "2.1.149",
    status: "unavailable",
    description: "This build has no passing setup artifact.",
    setupInstructions: [],
    command: null,
    configuration: null,
    handoffUrl: null,
    permittedLaunchTarget: "Claude Code",
    expectedClientId: null,
    redirectMechanism: "browser OAuth callback",
    failureRecovery: "Use another client or the generic route.",
  },
  {
    id: "generic",
    displayName: "Another MCP client",
    clientVersion: null,
    status: "unverified",
    description: "Manual standards-based setup for another MCP client.",
    setupInstructions: ["Add the URL to your client's MCP settings.", "Complete OAuth when your client opens the authorization page."],
    command: null,
    configuration: JSON.stringify({ mcpServers: { radioso: { url: resource } } }, null, 2),
    handoffUrl: null,
    permittedLaunchTarget: "your MCP client",
    expectedClientId: null,
    redirectMechanism: "client-declared browser OAuth callback",
    failureRecovery: "Check the client's OAuth redirect and start again.",
  },
];

const setupResponse = (availability: "available" | "disabled" | "misconfigured" | "unavailable" = "available") => ({
  availability,
  resource: availability === "available" ? resource : null,
  artifacts: availability === "available" ? setupArtifacts : [],
  checkedAt: "2026-09-04T12:00:00.000Z",
  message: availability === "available" ? null : "Configure the Operator MCP resource for this deployment.",
});

const grant = (overrides: Record<string, unknown> = {}) => ({
  id: "22222222-2222-4222-8222-222222222222",
  clientId: "https://codex.example/client-metadata.json",
  clientName: "Codex CLI",
  clientVersion: "0.149.0",
  clientMetadataDigest: "sha256:client",
  workspaceId,
  workspaceName: "Demo workspace",
  userId: "user-1",
  userName: "Operator",
  scopes: ["operator:read", "operator:probe"],
  offlineAccess: false,
  status: "active",
  createdAt: "2026-09-04T11:00:00.000Z",
  lastUsedAt: "2026-09-04T11:30:00.000Z",
  revokedAt: null,
  revokedReason: null,
  canRevoke: true,
  isOwner: true,
  ...overrides,
});

const grantDetail = (overrides: Record<string, unknown> = {}) => ({
  ...grant(overrides),
  redirectHost: "127.0.0.1:3210",
  resource,
  credentialCount: 1,
  recentInvocationCount: 3,
});

const stubRuntimeConfig = async (page: Page, operatorMcpUrl = resource) => {
  await page.route("**/runtime-config", async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ mcpUrl: "", operatorMcpUrl, publicApiUrl: "" }),
  }));
};

const installApiAccessMock = async (page: Page, role: "member" | "admin" = "admin") => {
  await page.route("**/backend/api/v1/account/workspaces/workspace-1/api-access**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/+$/, "");
    if (request.method() === "GET" && path.endsWith("/api-access")) {
      return route.fulfill({ json: {
        effectiveRole: role,
        capabilities: { manageOwnPersonalTokens: true, auditWorkspacePersonalTokens: role === "admin", manageServiceAccounts: role === "admin" },
        defaults: { personalTokenLifetimeDays: 90, serviceCredentialLifetimeDays: 365 },
        limits: { personalTokensPerUser: 10, serviceAccountsPerWorkspace: 50, credentialsPerServiceAccount: 5, maximumPageSize: 100 },
        legacyCredentialMigration: { status: "destroyed", migratedAt: "2026-08-31T00:00:00.000Z" },
      } });
    }
    if (request.method() === "GET" && path.endsWith("/personal-tokens")) return route.fulfill({ json: { items: [], page: 1, limit: 50, total: 0 } });
    if (request.method() === "GET" && path.endsWith("/service-accounts")) return route.fulfill({ json: { items: [], page: 1, limit: 50, total: 0 } });
    return route.fulfill({ status: 404, json: { error: { message: `Unhandled API access request: ${path}` } } });
  });
};

const installOperatorRoutes = async (page: Page, options: {
  setup?: ReturnType<typeof setupResponse>;
  grants?: ReturnType<typeof grant>[];
  details?: ReturnType<typeof grantDetail>;
  onRevoke?: () => void;
}) => {
  let currentGrants: Array<Record<string, unknown>> = [...(options.grants ?? [])];
  await page.route("**/backend/api/v1/workspaces/workspace-1/operator-mcp/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/+$/, "");
    if (request.method() === "GET" && path.endsWith("/setup")) return route.fulfill({ json: options.setup ?? setupResponse() });
    if (request.method() === "GET" && path.endsWith("/grants")) return route.fulfill({ json: { grants: currentGrants, canViewWorkspace: true } });
    if (request.method() === "GET" && /\/grants\/[^/]+$/.test(path)) return route.fulfill({ json: options.details ?? grantDetail() });
    if (request.method() === "POST" && path.endsWith("/revoke")) {
      options.onRevoke?.();
      currentGrants = currentGrants.map((item) => ({ ...item, status: "revoked", revokedAt: "2026-09-04T12:00:00.000Z" }));
      return route.fulfill({ json: currentGrants[0] ?? grant({ status: "revoked" }) });
    }
    return route.fulfill({ status: 404, json: { error: { message: `Unhandled Operator MCP request: ${path}` } } });
  });
};

const openApiAccess = async (page: Page) => {
  await page.goto(`/w/${workspaceKey}/settings?tab=api-access`);
  await expect(page.getByRole("heading", { name: "API access", level: 1 })).toBeVisible();
  await expect(page.locator("#operator-mcp")).toBeVisible();
};

test("Operator MCP chooser shows exact-build gating and generic setup without inferring a connection", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() });
  await installApiAccessMock(page);
  await installOperatorRoutes(page, { grants: [] });
  await stubRuntimeConfig(page);
  await openApiAccess(page);

  const card = page.locator("#operator-mcp");
  await expect(card.getByRole("heading", { name: "Radioso MCP for your favorite engine" })).toBeVisible();
  await expect(card.getByText("Available", { exact: true })).toBeVisible();
  await expect(card.getByRole("combobox", { name: "Choose MCP client" })).toHaveValue("generic");
  await expect(card.getByText("Another MCP client", { exact: true })).toBeVisible();
  await expect(card.getByText(resource, { exact: true })).toBeVisible();
  await expect(card.getByRole("option", { name: /Codex CLI/ })).toBeDisabled();
  await expect(card.getByRole("option", { name: /Claude Code/ })).toBeDisabled();
  await expect(card.getByText("No operator MCP grants yet.")).toBeVisible();
  await expect(card.getByText("Unverified", { exact: true })).toBeVisible();
  await expect(card.getByText(/selection only prepares setup/i)).toBeVisible();
});

test("Operator MCP setup is unavailable when the deployment has no canonical resource", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() });
  await installApiAccessMock(page);
  await installOperatorRoutes(page, { setup: setupResponse("disabled"), grants: [] });
  await stubRuntimeConfig(page, "");
  await openApiAccess(page);

  const card = page.locator("#operator-mcp");
  await expect(card.getByText("Operator MCP is not ready for this deployment.")).toBeVisible();
  await expect(card.getByRole("combobox", { name: "Choose MCP client" })).toHaveCount(0);
  await expect(card.getByText(/Configure the Operator MCP resource/i)).toBeVisible();
});

const consentTransaction = (overrides: Record<string, unknown> = {}) => ({
  transactionId,
  client: {
    clientId: "https://codex.example/client-metadata.json",
    displayName: "Codex CLI",
    clientUri: "https://codex.example",
    clientVersion: "0.149.0",
    metadataDigest: "sha256:client",
    applicationType: "native",
  },
  requestedScopes: ["operator:read", "operator:probe", "operator:propose"],
  requestedOfflineAccess: true,
  redirectHost: "127.0.0.1:3210",
  redirectUri: "http://127.0.0.1:3210/oauth/callback",
  resource,
  currentUser: { id: "user-1", displayName: "Operator", email: "operator@example.com" },
  workspaces: [
    { id: workspaceId, name: "Demo workspace", role: "admin" },
    { id: "workspace-2", name: "Research workspace", role: "member" },
  ],
  status: "pending",
  expiresAt: "2026-09-04T13:00:00.000Z",
  ...overrides,
});

const installConsentRoutes = async (page: Page, transaction: Record<string, unknown>, decisions: unknown[]) => {
  await page.route(`**/backend/api/v1/operator-mcp/oauth/transactions/${transactionId}`, async (route) => route.fulfill({ json: transaction }));
  await page.route(`**/backend/api/v1/operator-mcp/oauth/transactions/${transactionId}/decision`, async (route) => {
    decisions.push(route.request().postDataJSON());
    return route.fulfill({ json: { redirectUrl: "about:blank" } });
  });
};

test("consent identifies the real client, warns about loopback/external data, and submits narrowed scopes", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() });
  const decisions: unknown[] = [];
  await installConsentRoutes(page, consentTransaction(), decisions);
  const response = await page.goto(`/oauth/operator-mcp/consent?transaction=${transactionId}`);
  expect(response).not.toBeNull();
  expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(response?.headers()["x-frame-options"]).toBe("DENY");
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  expect(response?.headers()["cache-control"]).toContain("no-store");

  await expect(page.getByText("Authorize Radioso MCP", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "https://codex.example" })).toHaveAttribute("href", "https://codex.example")
  await expect(page.getByText("Codex CLI · 0.149.0")).toBeVisible();
  await expect(page.getByText("127.0.0.1:3210", { exact: true })).toBeVisible();
  await expect(page.getByText(/may receive workspace data/i)).toBeVisible();
  await expect(page.getByText(/loopback or private-scheme redirect/i)).toBeVisible();
  await expect(page.getByLabel("Workspace", { exact: true })).toHaveValue(workspaceId);
  await page.getByLabel("Run bounded diagnostics and retrieval probes").uncheck();
  await expect(page.getByLabel("Keep access for future sessions")).not.toBeChecked();
  await page.getByRole("button", { name: "Approve access" }).click();
  await expect.poll(() => decisions).toHaveLength(1);
  expect(decisions[0]).toEqual({ decision: "approve", workspaceId, approvedToolScopes: ["operator:read", "operator:propose"], offlineAccess: false });
});

test("consent supports deny and safe no-access, expired, decided, and account-swap states", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() });
  const decisions: unknown[] = [];
  await installConsentRoutes(page, consentTransaction(), decisions);
  await page.goto(`/oauth/operator-mcp/consent?transaction=${transactionId}`);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => decisions).toHaveLength(1);
  expect(decisions[0]).toEqual({ decision: "deny", offlineAccess: false });
  await expect(page).toHaveURL("about:blank");
  decisions.length = 0;

  await page.goto(`/oauth/operator-mcp/consent?transaction=${transactionId}`);
  await page.getByRole("button", { name: "Deny" }).click();
  await expect.poll(() => decisions).toHaveLength(1);
  expect(decisions[0]).toEqual({ decision: "deny", offlineAccess: false });
  await expect(page).toHaveURL("about:blank");

  await installConsentRoutes(page, consentTransaction({ workspaces: [] }), decisions);
  await page.goto(`/oauth/operator-mcp/consent?transaction=${transactionId}`);
  await expect(page.getByText("No workspace access", { exact: true })).toBeVisible();

  await installConsentRoutes(page, consentTransaction({ status: "expired" }), decisions);
  await page.goto(`/oauth/operator-mcp/consent?transaction=${transactionId}`);
  await expect(page.getByText("Authorization expired", { exact: true })).toBeVisible();

  await installConsentRoutes(page, consentTransaction({ status: "approved" }), decisions);
  await page.goto(`/oauth/operator-mcp/consent?transaction=${transactionId}`);
  await expect(page.getByText("Authorization already decided", { exact: true })).toBeVisible();
});

test("password sign-in returns to the pending consent transaction", async ({ page }) => {
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() });
  await installConsentRoutes(page, consentTransaction(), []);
  let authenticated = false;
  await page.route("**/backend/api/v1/auth/registration", async (route) => route.fulfill({ json: { available: false } }));
  await page.route("**/backend/api/v1/ee/auth/google/status", async (route) => route.fulfill({ json: { enabled: false } }));
  await page.route("**/backend/api/v1/auth/login", async (route) => {
    authenticated = true;
    await route.fulfill({ json: {
      userId: "user-1",
      accountId: "account-1",
      organizationName: "Demo account",
      workspaceId,
      workspaceName: "Demo workspace",
      workspacePublicRouteKey: workspaceKey,
    } });
  });
  await page.route(`**/backend/api/v1/operator-mcp/oauth/transactions/${transactionId}`, async (route) => {
    await route.fulfill(authenticated
      ? { json: consentTransaction() }
      : { status: 401, json: { error: { code: "unauthorized", message: "Unauthorized" } } });
  });

  await page.goto(`/oauth/operator-mcp/consent?transaction=${transactionId}`);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await page.getByLabel("Email").fill("operator@example.com");
  await page.getByLabel("Password").fill("password-for-test");
  await page.getByRole("button", { name: "Sign In" }).click();

  await expect(page).toHaveURL(`/oauth/operator-mcp/consent?transaction=${transactionId}`);
  await expect(page.getByText("Authorize Radioso MCP", { exact: true })).toBeVisible();
});

test("consent rejects a session swap before showing approval controls", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() });
  await installConsentRoutes(page, consentTransaction({ currentUser: { id: "user-2", displayName: "Other operator", email: "other@example.com" } }), []);
  await page.goto(`/oauth/operator-mcp/consent?transaction=${transactionId}`);
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("radioso.authUser"))).toContain("user-1");
  await expect(page.getByText("Sign in as the requesting user", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve access" })).toHaveCount(0);
});

test("grant inventory exposes safe detail and requires explicit confirmation before revocation", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() });
  await installApiAccessMock(page, "admin");
  const revokeRequests: string[] = [];
  await installOperatorRoutes(page, { grants: [grant()], details: grantDetail(), onRevoke: () => revokeRequests.push("revoked") });
  await stubRuntimeConfig(page);
  await openApiAccess(page);

  const card = page.locator("#operator-mcp");
  await expect(card.getByText("Codex CLI", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Inspect" }).click();
  await expect(card.getByText("Safe grant metadata only")).toBeVisible();
  await expect(card.getByText("https://codex.example/client-metadata.json")).toBeVisible();
  await card.getByRole("button", { name: "Revoke grant" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Revoke grant?" });
  await expect(confirm.getByText(/stop working immediately/i)).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  expect(revokeRequests).toHaveLength(0);
  await card.getByRole("button", { name: "Revoke grant" }).click();
  await page.getByRole("alertdialog", { name: "Revoke grant?" }).getByRole("button", { name: "Revoke grant" }).click();
  await expect.poll(() => revokeRequests).toHaveLength(1);
});

test("member sees an owner-controlled grant without a revoke action", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() });
  await installApiAccessMock(page, "member");
  await installOperatorRoutes(page, { grants: [grant({ userId: "user-2", userName: "Workspace owner", isOwner: false, canRevoke: false })], details: grantDetail({ userId: "user-2", userName: "Workspace owner", isOwner: false, canRevoke: false }) });
  await stubRuntimeConfig(page);
  await openApiAccess(page);
  const card = page.locator("#operator-mcp");
  await card.getByRole("button", { name: "Inspect" }).click();
  await expect(card.getByText("Workspace owner")).toBeVisible();
  await expect(card.getByRole("button", { name: "Revoke grant" })).toHaveCount(0);
});

const proposalDetail = {
  id: "33333333-3333-4333-8333-333333333333",
  workspaceId,
  targetType: "ingestion_settings",
  targetLabel: "Ingestion settings",
  summary: "Increase the chunk overlap for course material.",
  status: "pending",
  preview: { current: { fixedWindowChunkOverlap: 200 }, proposed: { fixedWindowChunkOverlap: 240 } },
  currentVersionMatches: true,
  evidenceCases: null,
  reason: null,
  failureReason: null,
  appliedRef: null,
};

const installProposalRoutes = async (page: Page, calls: string[], workspaceHeaders: string[]) => {
  await page.route("**/backend/api/v1/copilot/proposals/33333333-3333-4333-8333-333333333333", async (route) => route.fulfill({ json: proposalDetail }));
  await page.route("**/backend/api/v1/copilot/availability", async (route) => { workspaceHeaders.push(route.request().headers()["x-workspace-id"] ?? ""); return route.fulfill({ json: { available: true, reason: "ok", canManage: true, applyableProposalTargets: ["ingestion_settings"] } }); });
  await page.route("**/backend/api/v1/copilot/proposals/33333333-3333-4333-8333-333333333333/apply", async (route) => { workspaceHeaders.push(route.request().headers()["x-workspace-id"] ?? ""); calls.push("apply"); return route.fulfill({ json: { status: "applied" } }); });
  await page.route("**/backend/api/v1/copilot/proposals/33333333-3333-4333-8333-333333333333/dismiss", async (route) => { workspaceHeaders.push(route.request().headers()["x-workspace-id"] ?? ""); calls.push("dismiss"); return route.fulfill({ json: { status: "dismissed" } }); });
};

test("proposal deep-link resolves its workspace independently for review, apply, and dismiss", async ({ page }) => {
  await seedDashboardStorage(page);
  await page.addInitScript(() => window.localStorage.setItem("radioso.activeWorkspaceId", "different-workspace"));
  const calls: string[] = [];
  const workspaceHeaders: string[] = [];
  await installProposalRoutes(page, calls, workspaceHeaders);
  await page.goto("/oauth/operator-mcp/proposal/33333333-3333-4333-8333-333333333333");
  await expect(page.getByText("Review proposal from Radioso MCP", { exact: true })).toBeVisible();
  await expect(page.getByText("Increase the chunk overlap for course material.")).toBeVisible();
  await expect.poll(() => workspaceHeaders).toContain(workspaceId);
  await page.getByRole("button", { name: /Show proposed changes/ }).click();
  await page.getByRole("button", { name: "Apply" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Apply proposal" }).click();
  await expect.poll(() => calls).toContain("apply");

  await page.reload();
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect.poll(() => calls).toContain("dismiss");
  expect(workspaceHeaders).not.toContain("different-workspace");
});

test("proposal deep-link returns to review after a signed-out operator logs in", async ({ page }) => {
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() });
  let authenticated = false;
  await page.route("**/backend/api/v1/auth/registration", async (route) => route.fulfill({ json: { available: false } }));
  await page.route("**/backend/api/v1/ee/auth/google/status", async (route) => route.fulfill({ json: { enabled: false } }));
  await page.route("**/backend/api/v1/auth/login", async (route) => {
    authenticated = true;
    await route.fulfill({ json: {
      userId: "user-1",
      accountId: "account-1",
      organizationName: "Demo account",
      workspaceId,
      workspaceName: "Demo workspace",
      workspacePublicRouteKey: workspaceKey,
    } });
  });
  await page.route("**/backend/api/v1/copilot/proposals/33333333-3333-4333-8333-333333333333", async (route) => {
    await route.fulfill(authenticated
      ? { json: proposalDetail }
      : { status: 401, json: { error: { code: "unauthorized", message: "Unauthorized" } } });
  });
  await page.route("**/backend/api/v1/copilot/availability", async (route) => route.fulfill({
    json: { available: true, reason: "ok", canManage: true, applyableProposalTargets: ["ingestion_settings"] },
  }));

  const proposalPath = "/oauth/operator-mcp/proposal/33333333-3333-4333-8333-333333333333";
  await page.goto(proposalPath);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await page.getByLabel("Email").fill("operator@example.com");
  await page.getByLabel("Password").fill("password-for-test");
  await page.getByRole("button", { name: "Sign In" }).click();

  await expect(page).toHaveURL(proposalPath);
  await expect(page.getByText("Review proposal from Radioso MCP", { exact: true })).toBeVisible();
});
