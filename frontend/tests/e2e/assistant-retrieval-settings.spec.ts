import { expect, test } from "@playwright/test";

import {
  basePlatformSettings,
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

test("agent settings saves behavior and channel sections without retrieval drift", async ({ page }) => {
  const agentUpdates: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    agentUpdates,
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior`);

  await expect(page.getByRole("heading", { name: "Identity & appearance", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/agents/${defaultAgentId}\\?tab=behavior$`));
  await page.getByLabel("Assistant name").fill("Marta Knowledge Desk");

  await expect.poll(() => agentUpdates.length).toBeGreaterThanOrEqual(1);
  expect(agentUpdates.at(-1)).toMatchObject({
    name: "Marta Knowledge Desk",
  });
  expect(agentUpdates.at(-1)).not.toHaveProperty("retrieval");

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels`);
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/agents/${defaultAgentId}\\?tab=channels$`));
  await expect(page.getByRole("heading", { name: "Public chat link", level: 1 })).toBeVisible();
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

test("retrieval settings saves without channel drift", async ({ page }) => {
  const settingsUpdates: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    settingsUpdates,
  });

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
    },
  });
  expect(settingsUpdates.at(-1)).not.toHaveProperty("channels");
});

test("retrieval settings can switch the answering strategy to reasoning", async ({ page }) => {
  const settingsUpdates: unknown[] = [];
  const agentUpdates: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    agentUpdates,
    settingsUpdates,
  });

  await page.goto(`/w/${workspaceKey}/knowledge?tab=retrieval`);
  await expect(page.getByRole("heading", { name: "Answering strategy", exact: true })).toBeVisible();

  await page.locator("#retrievalStrategy").click();
  await page.getByRole("option", { name: "Reasoning (experimental)" }).click();

  await expect.poll(() => settingsUpdates.length).toBeGreaterThanOrEqual(1);
  expect(settingsUpdates.at(-1)).toMatchObject({
    retrieval: {
      retrievalStrategy: "reasoning",
    },
  });
});

test("agent skills tab saves and clears retrieval skill overrides", async ({ page }) => {
  const agentUpdates: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    agentUpdates,
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=skills`);
  const retrievalSection = page.locator("#retrieval-skill-settings");
  await expect(retrievalSection).toBeVisible();
  await expect(retrievalSection).toContainText("Inherited from default");

  await page.getByRole("button", { name: "Override answer instruction" }).click();
  await page.getByLabel("Retrieval answer instruction").fill("Answer with release-note citations only.");

  await expect.poll(() => agentUpdates.length).toBeGreaterThanOrEqual(1);
  expect(agentUpdates.at(-1)).toMatchObject({
    skillSettings: {
      "retrieval.answer": {
        customInstruction: "Answer with release-note citations only.",
      },
    },
  });

  await page.reload();
  await expect(page.getByLabel("Retrieval answer instruction")).toHaveValue("Answer with release-note citations only.");

  await page.getByRole("button", { name: "Clear override" }).click();

  await expect.poll(() => JSON.stringify((agentUpdates.at(-1) as { skillSettings?: unknown } | undefined)?.skillSettings)).toBe("{}");
  await expect(retrievalSection).toContainText("Inherited from default");
});
