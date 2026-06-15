import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

test("workspace settings shows sanitized customer email activity", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    emailActivity: [
      {
        id: "activity-1",
        workspaceId,
        agentId: defaultAgentId,
        routineId: "routine-1",
        conversationId: null,
        skillDefinitionId: "88888888-8888-4888-8888-000000000001",
        connectionId: "99999999-9999-4999-8999-000000000001",
        skillName: "support_email_customer",
        mode: "send",
        outcome: "needs_reauth",
        recipientSummary: {
          toCount: 1,
          ccCount: 0,
          domains: ["example.com"],
          redactedRecipients: ["c***@example.com"],
        },
        providerMessageId: null,
        errorCode: "needs_reauth",
        createdAt: nowIso,
      },
    ],
  });

  await page.goto(`/w/${workspaceKey}/settings?tab=workspace`);

  await expect(page.getByRole("heading", { name: "Email skill activity" })).toBeVisible();
  await expect(page.getByText("support_email_customer")).toBeVisible();
  await expect(page.getByText("Needs re-auth")).toBeVisible();
  await expect(page.getByText("c***@example.com")).toBeVisible();
  await expect(page.getByText("1 to, 0 cc · example.com")).toBeVisible();
  await expect(page.getByText("This is the full confidential message body")).toHaveCount(0);
  await expect(page.getByText("refresh-token-secret")).toHaveCount(0);
});
