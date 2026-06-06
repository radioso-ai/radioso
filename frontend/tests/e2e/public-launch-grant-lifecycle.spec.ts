import { expect, test } from "@playwright/test";

import {
  basePlatformSettings,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

test("operator can see and revoke the public chat link grant lifecycle", async ({ page }) => {
  const agentUpdates: unknown[] = [];
  const platformSettings = basePlatformSettings();
  platformSettings.channels.anonymousChatEnabled = true;
  platformSettings.channels.anonymousChatLastUsedAt = "2026-04-26T11:45:00.000Z";
  platformSettings.channels.anonymousChatStatus = "active";

  await page.clock.setFixedTime(new Date("2026-04-26T12:00:00.000Z"));
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings,
    agentUpdates,
  });

  await page.goto(`/w/${workspaceKey}/agents?tab=channels&anchor=public-chat-link`);
  const publicChatSection = page.getByRole("main").locator("#public-chat-link");

  await expect(publicChatSection.getByRole("heading", { name: "Public chat link" })).toBeVisible();
  // No "Active" badge — a channel is self-evidently active when its toggle is on.
  await expect(publicChatSection.getByText("Active")).toHaveCount(0);
  await expect(publicChatSection.getByText("Last used: 15 minutes ago")).toBeVisible();

  await publicChatSection.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByRole("heading", { name: "Revoke public chat link credential" })).toBeVisible();
  await page.getByRole("button", { name: "Revoke" }).last().click();

  await expect.poll(() => agentUpdates.length).toBeGreaterThanOrEqual(1);
  expect(agentUpdates.at(-1)).toMatchObject({
    revokeAnonymousChatToken: true,
  });
  await expect(publicChatSection.getByText("Revoked — rotate to issue a new credential.")).toBeVisible();
});
