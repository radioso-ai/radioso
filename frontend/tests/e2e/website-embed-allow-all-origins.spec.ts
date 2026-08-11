import { expect, test } from "@playwright/test";

import {
  basePlatformSettings,
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

test("operator can toggle website embed allow-all origins", async ({ page }) => {
  const agentUpdates: unknown[] = [];
  const platformSettings = basePlatformSettings();
  platformSettings.channels.websiteEmbedEnabled = true;
  platformSettings.channels.websiteEmbedAllowedOrigins = ["https://host.example"];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings,
    agentUpdates,
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=web-chat`);

  await expect(page.getByRole("heading", { name: "Website widget", exact: true })).toBeVisible();
  await expect(page.getByLabel("Specific websites")).toBeVisible();

  await page.locator("#websiteEmbedWildcardOrigin").click();

  // Allowing any website retires the per-origin list, so its field goes away.
  await expect(page.getByLabel("Specific websites")).toBeHidden();
  await expect.poll(() => agentUpdates.length).toBeGreaterThanOrEqual(1);
  expect(agentUpdates.at(-1)).toMatchObject({
    surfaceSettings: {
      websiteEmbed: {
        allowedOrigins: ["*"],
      },
    },
  });
  const removedField = ["allow", "All", "Origins"].join("");
  expect(JSON.stringify(agentUpdates.at(-1))).not.toContain(removedField);
});
