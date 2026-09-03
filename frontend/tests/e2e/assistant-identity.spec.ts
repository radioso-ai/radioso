import { expect, test } from "@playwright/test";

import {
  basePlatformSettings,
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

// Visitors kept asking whether they had reached a person, so the chat surfaces
// name the assistant and mark it as software on its first message. The settings
// preview renders the same components the visitor sees.
test("chat preview names the assistant and marks it as AI on its first message", async ({
  page,
}) => {
  const platformSettings = basePlatformSettings();
  platformSettings.channels.websiteEmbedEnabled = true;

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { platformSettings });

  await page.goto(
    `/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=web-chat`,
  );

  const preview = page.getByRole("complementary", { name: "Assistant preview" });
  await expect(preview).toBeVisible();

  const identity = preview.getByTestId("assistant-identity");
  await expect(identity).toHaveCount(1);
  await expect(identity).toContainText("Marta");
  await expect(identity).toContainText("AI");

  // It marks the assistant's presence once, not every turn.
  await expect(
    preview.locator('[data-message-id="preview-assistant-1"]').getByTestId(
      "assistant-identity",
    ),
  ).toBeVisible();
  await expect(
    preview.locator('[data-message-id="preview-assistant-2"]').getByTestId(
      "assistant-identity",
    ),
  ).toHaveCount(0);
});
