import { expect, test } from "@playwright/test";

import {
  basePlatformSettings,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

test("shared settings saves assistant, retrieval, and channel sections without cross-section drift", async ({ page }) => {
  const settingsUpdates: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    settingsUpdates,
  });

  await page.goto(`/w/${workspaceKey}/settings?tab=assistant`);

  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.getByLabel("Assistant name").fill("Marta Knowledge Desk");

  await expect.poll(() => settingsUpdates.length).toBeGreaterThanOrEqual(1);
  expect(settingsUpdates.at(-1)).toMatchObject({
    assistant: {
      assistantName: "Marta Knowledge Desk",
    },
  });
  expect(settingsUpdates.at(-1)).not.toHaveProperty("retrieval");

  await page.getByRole("tab", { name: "Retrieval" }).click();
  await expect(page.getByRole("heading", { name: "Query rewrite", exact: true })).toBeVisible();
  await page.locator("#queryRewrite").click();

  await expect.poll(() => settingsUpdates.length).toBeGreaterThanOrEqual(2);
  expect(settingsUpdates.at(-1)).toMatchObject({
    assistant: {
      conversationMode: "guided",
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 3,
      customInstruction: "Keep answers concise.",
    },
    retrieval: {
      queryRewriteEnabled: true,
      vectorTopK: 20,
      citationDisplayEnabled: true,
    },
  });
  expect(settingsUpdates.at(-1)).not.toHaveProperty("channels");

  await page.getByRole("tab", { name: "Channels" }).click();
  await expect(page.getByText("Anonymous chat")).toBeVisible();
  await page.locator("#anonChatToggle").click();

  await expect.poll(() => settingsUpdates.length).toBeGreaterThanOrEqual(3);
  expect(settingsUpdates.at(-1)).toMatchObject({
    channels: {
      anonymousChatEnabled: true,
    },
  });
  expect(settingsUpdates.at(-1)).not.toHaveProperty("retrieval");
});
