import { expect, test } from "@playwright/test";

import {
  basePlatformSettings,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

test("operator can see public chat link last-used lifecycle", async ({ page }) => {
  const platformSettings = basePlatformSettings();
  platformSettings.channels.anonymousChatEnabled = true;
  platformSettings.channels.anonymousChatLastUsedAt = "2026-04-26T11:45:00.000Z";

  await page.clock.setFixedTime(new Date("2026-04-26T12:00:00.000Z"));
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings,
  });

  await page.goto(`/w/${workspaceKey}/agents?tab=channels&anchor=web-chat`);
  const publicChatSection = page.getByRole("main").locator("#public-chat-link");

  await expect(publicChatSection.getByRole("heading", { name: "Public link", exact: true })).toBeVisible();
  await expect(publicChatSection.getByText("Active")).toHaveCount(0);
  await expect(publicChatSection.getByText("Revoked")).toHaveCount(0);
  await expect(publicChatSection.getByRole("button", { name: "Revoke" })).toHaveCount(0);
  await expect(publicChatSection.getByText("Last used: 15 minutes ago")).toBeVisible();
});
