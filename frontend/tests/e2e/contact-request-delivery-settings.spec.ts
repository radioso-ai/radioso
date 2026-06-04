import { expect, test } from "@playwright/test";

import {
  basePlatformSettings,
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

test("agent contact request delivery settings reveal, validate, save, and persist", async ({ page }) => {
  const agentUpdates: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    agentUpdates,
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);

  await expect(page.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Contact requests" })).toBeVisible();

  await page.locator("#contactRequestsToggle").click();
  await expect(page.getByLabel("Recipient emails")).toBeVisible();
  await expect(page.getByLabel("Webhook URL")).toBeVisible();

  await expect.poll(() => agentUpdates.length).toBeGreaterThanOrEqual(1);
  expect(agentUpdates.at(-1)).toMatchObject({
    contactRequestsEnabled: true,
  });

  await page.getByLabel("Recipient emails").fill("not-an-email");
  await expect(page.getByText("Fix invalid addresses: not-an-email")).toBeVisible();

  await page.getByLabel("Recipient emails").fill("support@example.com, Support@example.com\nops@example.com");
  await page.getByLabel("Webhook URL").fill("https://support.example.com/radioso/contact-request");

  await expect.poll(() => agentUpdates.at(-1)).toMatchObject({
    contactRequestsEnabled: true,
    contactRequestDelivery: {
      recipientEmails: ["support@example.com", "ops@example.com"],
      webhook: {
        url: "https://support.example.com/radioso/contact-request",
      },
    },
  });

  await page.reload();
  await expect(page.getByLabel("Recipient emails")).toHaveValue("support@example.com\nops@example.com");
  await expect(page.getByLabel("Webhook URL")).toHaveValue("https://support.example.com/radioso/contact-request");
});
