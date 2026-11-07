import { expect, test } from "@playwright/test";

import type { NotificationDelivery } from "@/lib/notification-deliveries";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
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

const openSkills = async (page: import("@playwright/test").Page) => {
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

  await openSkills(page);

  const recent = page.getByRole("region", { name: "Recent notifications" });
  await expect(recent.getByText("waiting@example.com")).toBeVisible();
  await expect(recent.getByText("desk-12@example.com")).toHaveCount(0);

  await recent.getByRole("button", { name: "Show more" }).click();
  await expect(recent.getByText("desk-12@example.com")).toBeVisible();
  await expect(recent.getByRole("button", { name: "Show more" })).toHaveCount(0);

  await recent.getByRole("button", { name: "Resend confirmation" }).click();
  await expect(recent.getByText(/Not sent: asked recently/)).toBeVisible();
});

test("recent notifications say so when nothing has been sent", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { notificationDeliveries: [] });

  await openSkills(page);

  await expect(page.getByRole("region", { name: "Recent notifications" }).getByText("No notifications sent yet.")).toBeVisible();
});
