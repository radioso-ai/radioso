import { expect, test } from "@playwright/test";

import {
  basePlatformSettings,
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

test("shared settings saves assistant, retrieval, and channel sections without cross-section drift", async ({ page }) => {
  const settingsUpdates: unknown[] = [];
  const agentUpdates: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    agentUpdates,
    settingsUpdates,
  });

  await page.goto(`/w/${workspaceKey}/agents?tab=behavior`);

  await expect(page.getByRole("heading", { name: "Agent" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/agents/${defaultAgentId}\\?tab=behavior$`));
  await page.getByLabel("Assistant name").fill("Marta Knowledge Desk");

  await expect.poll(() => agentUpdates.length).toBeGreaterThanOrEqual(1);
  expect(agentUpdates.at(-1)).toMatchObject({
    name: "Marta Knowledge Desk",
  });
  expect(agentUpdates.at(-1)).not.toHaveProperty("retrieval");

  await page.goto(`/w/${workspaceKey}/knowledge?tab=retrieval`);
  await expect(page.getByRole("heading", { name: "Query rewrite", exact: true })).toBeVisible();
  await page.locator("#queryRewrite").click();

  await expect.poll(() => settingsUpdates.length).toBeGreaterThanOrEqual(1);
  expect(settingsUpdates.at(-1)).toMatchObject({
    assistant: {
      suggestedQuestionsEnabled: true,
      customInstruction: "Keep answers concise.",
    },
    retrieval: {
      queryRewriteEnabled: true,
      vectorTopK: 20,
      citationDisplayEnabled: true,
    },
  });
  expect(settingsUpdates.at(-1)).not.toHaveProperty("channels");

  await page.goto(`/w/${workspaceKey}/agents?tab=channels`);
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/agents/${defaultAgentId}\\?tab=channels$`));
  await expect(page.getByText("Public chat link")).toBeVisible();
  await page.locator("#anonChatToggle").click();

  await expect.poll(() => agentUpdates.length).toBeGreaterThanOrEqual(2);
  expect(agentUpdates.at(-1)).toMatchObject({
    surfaceSettings: {
      anonymousChat: {
        enabled: true,
      },
    },
  });
  expect(agentUpdates.at(-1)).not.toHaveProperty("retrieval");
});
