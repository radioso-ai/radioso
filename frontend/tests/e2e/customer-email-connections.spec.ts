import { expect, test, type Page } from "@playwright/test";

import {
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

type EmailConnectionFixture = {
  id: string;
  workspaceId: string;
  oauthConnectionId: string;
  displayName: string;
  provider: string;
  senderEmail: string;
  senderName: string | null;
  replyToEmail: string | null;
  status: "authorized" | "disabled" | "needs_reauth" | "error";
  lastHealthStatus: "ok" | "failed" | "unknown" | null;
  lastHealthCheckedAt: string | null;
  lastErrorCode: string | null;
  updatedAt: string;
};

const oauthConnectionId = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";

const emailConnection = (
  id: string,
  displayName: string,
  overrides: Partial<EmailConnectionFixture> = {},
): EmailConnectionFixture => ({
  id,
  workspaceId,
  oauthConnectionId,
  displayName,
  provider: "google_mail",
  senderEmail: `${id}@support.example`,
  senderName: null,
  replyToEmail: null,
  status: "authorized",
  lastHealthStatus: null,
  lastHealthCheckedAt: null,
  lastErrorCode: null,
  updatedAt: nowIso,
  ...overrides,
});

type EmailConnectionRequest = { method: string; path: string; body: unknown };

// An in-memory email-connections API: the list reflects what the operator has changed. Registered
// after the shared fixture's catch-all, so it is matched first.
const mockEmailConnections = async (
  page: Page,
  initial: EmailConnectionFixture[],
  options: { deleteFailure?: string } = {},
) => {
  let connections = initial;
  const requests: EmailConnectionRequest[] = [];
  await page.route(new RegExp(`/backend/api/v1/workspaces/${workspaceId}/(email-oauth|oauth|email)-connections`), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/backend\/api\/v1/, "");
    const method = request.method();
    if (path.endsWith("oauth-connections")) {
      await route.fulfill({
        json: {
          connections: [{
            id: oauthConnectionId,
            provider: "google_mail",
            displayName: "Support Gmail",
            status: "authorized",
            grantedScopes: [],
            providerAccountId: null,
            updatedAt: nowIso,
          }],
        },
      });
      return;
    }
    if (method === "GET") {
      await route.fulfill({ json: { connections } });
      return;
    }
    requests.push({ method, path, body: request.postDataJSON() });
    const [, connectionId, action] = path.match(/\/email-connections\/([^/]+)(?:\/(health-check))?$/) ?? [];
    const target = connections.find((connection) => connection.id === connectionId);
    if (!target) {
      await route.fulfill({ status: 404, json: { error: { message: "Customer email connection not found" } } });
      return;
    }
    if (method === "DELETE") {
      if (options.deleteFailure) {
        await route.fulfill({ status: 409, json: { error: { code: "conflict", message: options.deleteFailure } } });
        return;
      }
      connections = connections.filter((connection) => connection.id !== connectionId);
      await route.fulfill({ status: 204, contentType: "application/json", body: "" });
      return;
    }
    const updated: EmailConnectionFixture = action === "health-check"
      ? { ...target, status: "authorized", lastHealthStatus: "ok", lastErrorCode: null, lastHealthCheckedAt: nowIso }
      : { ...target, status: (request.postDataJSON() as { disabled: boolean }).disabled ? "disabled" : "authorized" };
    connections = connections.map((connection) => connection.id === connectionId ? updated : connection);
    await route.fulfill({ json: { connection: updated } });
  });
  return requests;
};

const openCustomerEmail = async (page: Page) => {
  await page.goto(`/w/${workspaceKey}/settings?tab=workspace`);
  await expect(page.getByRole("heading", { name: "Customer email" })).toBeVisible();
};

test("an email connection opens in a sheet where its health is checked and it is deleted", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  const requests = await mockEmailConnections(page, [
    emailConnection("conn-support", "Support outbound", { senderName: "Support Team", lastHealthStatus: "failed", lastErrorCode: "provider_health_failed", status: "error" }),
    emailConnection("conn-billing", "Billing outbound"),
  ]);

  await openCustomerEmail(page);
  await expect(page.getByRole("button", { name: "Billing outbound", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Support outbound", exact: true }).click();

  const sheet = page.getByRole("dialog", { name: "Support outbound" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Support Team <conn-support@support.example>")).toBeVisible();
  await expect(sheet.getByText("provider_health_failed")).toBeVisible();

  // The result of the check shows in the sheet, which covers the section's own messages.
  await sheet.getByRole("button", { name: "Check health of Support outbound" }).click();
  await expect(sheet.getByText("Health check passed.")).toBeVisible();
  expect(requests).toContainEqual(expect.objectContaining({ method: "POST", path: `/workspaces/${workspaceId}/email-connections/conn-support/health-check` }));
  await expect(sheet.getByText("provider_health_failed")).toHaveCount(0);

  await sheet.getByRole("button", { name: "Delete Support outbound" }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("button", { name: "Support outbound", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Billing outbound", exact: true })).toBeVisible();
  expect(requests.at(-1)).toMatchObject({ method: "DELETE", path: `/workspaces/${workspaceId}/email-connections/conn-support` });
});

test("a refused delete explains itself inside the sheet, and the row switch pauses a connection", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  const requests = await mockEmailConnections(
    page,
    [emailConnection("conn-support", "Support outbound")],
    { deleteFailure: "Customer email connection is still referenced by an email skill" },
  );

  await openCustomerEmail(page);
  await page.getByRole("button", { name: "Support outbound", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Support outbound" });
  await sheet.getByRole("button", { name: "Delete Support outbound" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("Customer email connection is still referenced by an email skill");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("button", { name: "Support outbound", exact: true })).toBeFocused();

  const enabled = page.getByRole("switch", { name: "Enable Support outbound" });
  await expect(enabled).toBeChecked();
  await enabled.click();
  await expect(enabled).not.toBeChecked();
  expect(requests.at(-1)).toMatchObject({
    method: "PATCH",
    path: `/workspaces/${workspaceId}/email-connections/conn-support`,
    body: { disabled: true },
  });
});
