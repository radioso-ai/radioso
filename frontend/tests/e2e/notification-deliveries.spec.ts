import { expect, test, type Page } from "@playwright/test";

import type { NotificationDelivery } from "@/lib/notification-deliveries";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

const conversationId = "99999999-9999-4999-8999-999999999991";

const delivery = (index: number, overrides: Partial<NotificationDelivery> = {}): NotificationDelivery => ({
  id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
  agentId: defaultAgentId,
  conversationId,
  kind: "handoff",
  recipientEmail: `desk-${index}@example.com`,
  outcome: "sent",
  createdAt: new Date(Date.UTC(2026, 10, 7, 12, 0, 60 - index)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 10, 7, 12, 0, 60 - index)).toISOString(),
  ...overrides,
});

/** The workspace-effective role the server resolves, account role and workspace grant together. */
const installEffectiveRole = async (page: Page, effectiveRole: "owner" | "admin" | "member") => {
  await page.route(`**/backend/api/v1/account/workspaces/${workspaceId}/api-access`, async (route) => {
    await route.fulfill({
      json: {
        effectiveRole,
        capabilities: { manageOwnPersonalTokens: true, auditWorkspacePersonalTokens: false, manageServiceAccounts: effectiveRole !== "member" },
        defaults: { personalTokenLifetimeDays: 90, serviceCredentialLifetimeDays: 365 },
        limits: { personalTokensPerUser: 10, serviceAccountsPerWorkspace: 50, credentialsPerServiceAccount: 5, maximumPageSize: 100 },
        legacyCredentialMigration: { active: false },
      },
    });
  });
};

const openSkills = async (page: Page) => {
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);
  await expect(page.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
};

test("an operator sees who each notice was sent to, why one was not, and asks an unconfirmed address again", async ({ page }) => {
  const requests: string[] = [];
  const resends: Array<{ agentId: string; email: string }> = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    notificationDeliveries: [
      delivery(1, { recipientEmail: "waiting@example.com", outcome: "skipped_unconfirmed", kind: "contact_request" }),
      delivery(2, { recipientEmail: "stopped@example.com", outcome: "skipped_revoked", kind: "approval" }),
      delivery(3, { recipientEmail: "ready@example.com", outcome: "sent", kind: "completion" }),
      delivery(4, { recipientEmail: "elsewhere@example.com", agentId: "11111111-1111-4111-8111-111111111111" }),
    ],
    notificationDeliveryRequests: requests,
    confirmationResends: resends,
  });
  await installEffectiveRole(page, "admin");

  await openSkills(page);

  const recent = page.getByRole("region", { name: "Recent notifications" });
  await expect(recent.getByText("ready@example.com")).toBeVisible();
  await expect(recent.getByText("Sent", { exact: true })).toBeVisible();
  await expect(recent.getByText("Not sent: stopped by the recipient")).toBeVisible();
  await expect(recent.getByText("Contact request", { exact: false })).toBeVisible();
  await expect(recent.getByText("Approval", { exact: false })).toBeVisible();
  await expect(recent.getByText("Completion", { exact: false })).toBeVisible();
  // Another agent's notices are not this agent's.
  await expect(recent.getByText("elsewhere@example.com")).toHaveCount(0);
  expect(requests[0]).toContain(`agentId=${defaultAgentId}`);

  // Only the address that has not confirmed can be asked again.
  await expect(recent.getByRole("button", { name: "Resend confirmation" })).toHaveCount(1);
  await recent.getByRole("button", { name: "Resend confirmation" }).click();
  await expect(recent.getByText("Confirmation sent")).toBeVisible();
  expect(resends).toEqual([{ agentId: defaultAgentId, email: "waiting@example.com" }]);

  // Each row opens the conversation that raised the notice.
  await expect(recent.getByRole("link", { name: "Open conversation" }).first())
    .toHaveAttribute("href", new RegExp(`/w/${workspaceKey}/activity\\?.*itemId=${conversationId}`));
});

test("recent notifications page through a long log and say plainly when a resend was not sent", async ({ page }) => {
  const resends: Array<{ agentId: string; email: string }> = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    notificationDeliveries: [
      delivery(1, { recipientEmail: "waiting@example.com", outcome: "skipped_unconfirmed" }),
      ...Array.from({ length: 11 }, (_, index) => delivery(index + 2)),
    ],
    confirmationResends: resends,
    confirmationResendSent: false,
  });
  await installEffectiveRole(page, "admin");

  await openSkills(page);

  const recent = page.getByRole("region", { name: "Recent notifications" });
  await expect(recent.getByText("waiting@example.com")).toBeVisible();
  await expect(recent.getByText("desk-12@example.com")).toHaveCount(0);

  await recent.getByRole("button", { name: "Show more" }).click();
  await expect(recent.getByText("desk-12@example.com")).toBeVisible();
  await expect(recent.getByRole("button", { name: "Show more" })).toHaveCount(0);

  await recent.getByRole("button", { name: "Resend confirmation" }).click();
  await expect(recent.getByText(/Not sent: already confirmed, asked recently/)).toBeVisible();
});

test("recent notifications say so when nothing has been sent", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { notificationDeliveries: [] });

  await openSkills(page);

  await expect(page.getByRole("region", { name: "Recent notifications" }).getByText("No notifications sent yet.")).toBeVisible();
});

test("a teammate who cannot manage recipients sees the log without a resend they could not make", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    notificationDeliveries: [delivery(1, { recipientEmail: "waiting@example.com", outcome: "skipped_unconfirmed" })],
  });
  await installEffectiveRole(page, "member");

  await openSkills(page);

  const recent = page.getByRole("region", { name: "Recent notifications" });
  await expect(recent.getByText("waiting@example.com")).toBeVisible();
  await expect(recent.getByText("Not sent: not confirmed")).toBeVisible();
  await expect(recent.getByRole("button", { name: "Resend confirmation" })).toHaveCount(0);
});

test("asking an address again twice quickly asks it once", async ({ page }) => {
  const resends: Array<{ agentId: string; email: string }> = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    notificationDeliveries: [delivery(1, { recipientEmail: "waiting@example.com", outcome: "skipped_unconfirmed" })],
    confirmationResends: resends,
  });
  await installEffectiveRole(page, "admin");
  // The answer takes a moment, as a real send does, so the first click is still in flight for the second.
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}/notification-recipient-confirmations/resend`, async (route) => {
    resends.push({ agentId: defaultAgentId, email: (route.request().postDataJSON() as { email: string }).email });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ status: 202, json: { sent: true } });
  });

  await openSkills(page);

  const recent = page.getByRole("region", { name: "Recent notifications" });
  await recent.getByRole("button", { name: "Resend confirmation" }).dblclick();
  await expect(recent.getByText("Confirmation sent")).toBeVisible();
  expect(resends).toEqual([{ agentId: defaultAgentId, email: "waiting@example.com" }]);
});

