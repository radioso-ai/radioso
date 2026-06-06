import { expect, test } from "@playwright/test";

import {
  basePlatformSettings,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

test("operator can see and revoke the public chat link grant lifecycle", async ({ page }) => {
  const settingsUpdates: unknown[] = [];
  const platformSettings = basePlatformSettings();
  platformSettings.channels.anonymousChatEnabled = true;
  platformSettings.channels.anonymousChatLastUsedAt = "2026-04-26T11:45:00.000Z";
  platformSettings.channels.anonymousChatStatus = "active";

  await page.clock.setFixedTime(new Date("2026-04-26T12:00:00.000Z"));
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings,
    settingsUpdates,
  });

  await page.goto(`/w/${workspaceKey}/agents?tab=channels&anchor=public-chat-link`);

  await expect(page.getByRole("heading", { name: "Public chat link" })).toBeVisible();
  await expect(page.getByText("Active")).toBeVisible();
  await expect(page.getByText("Last used: 15 minutes ago")).toBeVisible();

  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByRole("heading", { name: "Revoke public chat link credential" })).toBeVisible();
  await page.getByRole("button", { name: "Revoke" }).last().click();

  await expect.poll(() => settingsUpdates.length).toBeGreaterThanOrEqual(1);
  expect(settingsUpdates.at(-1)).toMatchObject({
    channels: {
      revokeAnonymousChatToken: true,
    },
  });
  await expect(page.getByText("Revoked — rotate to issue a new credential.")).toBeVisible();
});
