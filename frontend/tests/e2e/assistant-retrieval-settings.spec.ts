import { expect, test } from "@playwright/test";

import {
  baseDocumentSources,
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

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);
  const retrievalSection = page.locator("#retrieval-skill-settings");
  await expect(retrievalSection).toBeVisible();
  await expect(retrievalSection).toContainText("Using workspace default: off");

  await retrievalSection.getByRole("button", { name: "Explain Query Rewrite" }).click();
  await expect(page.getByRole("heading", { name: "Query Rewrite" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.locator("#retrievalQueryRewrite").click();
  await page.getByRole("option", { name: "On" }).click();

  await expect.poll(() => agentUpdates.length).toBeGreaterThanOrEqual(1);
  expect(agentUpdates.at(-1)).toMatchObject({
    skillSettings: {
      "retrieval.answer": {
        queryRewriteEnabled: true,
      },
    },
  });

  await page.reload();
  await expect(page.locator("#retrievalQueryRewrite")).toContainText("On");

  await page.locator("#retrievalQueryRewrite").click();
  await page.getByRole("option", { name: "Use workspace default" }).click();

  await expect.poll(() => JSON.stringify((agentUpdates.at(-1) as { skillSettings?: unknown } | undefined)?.skillSettings)).toBe("{}");
  await expect(retrievalSection).toContainText("Using workspace default: off");
});

test("agent skills tab collapses retrieval settings when retrieval is off", async ({ page }) => {
  const agentUpdates: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    agentUpdates,
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);
  const retrievalSection = page.locator("#retrieval-skill-settings");
  await expect(retrievalSection).toBeVisible();
  await expect(page.locator("#agent-knowledge-scope-settings")).toBeVisible();

  await page.locator("#retrievalEnabledToggle").click();
  await expect(retrievalSection).toBeHidden();
  await expect(page.locator("#agent-knowledge-scope-settings")).toBeHidden();

  await expect.poll(() => agentUpdates.length).toBeGreaterThanOrEqual(1);
  expect(agentUpdates.at(-1)).toMatchObject({
    retrievalEnabled: false,
  });

  await page.locator("#retrievalEnabledToggle").click();
  await expect(retrievalSection).toBeVisible();
  await expect(page.locator("#agent-knowledge-scope-settings")).toBeVisible();
});

test("agent skills tab saves, persists, and clears retrieval metadata rules", async ({ page }) => {
  const agentUpdates: unknown[] = [];
  const platformSettings = basePlatformSettings();
  platformSettings.retrieval.metadataRules = [
    {
      id: "workspace-region",
      field: "region",
      valueType: "string",
      operator: "equals",
      value: "emea",
      effect: "boost",
      enabled: true,
      triggerMode: "always_on",
      conditions: [
        {
          id: "workspace-region-condition",
          field: "region",
          valueType: "string",
          operator: "equals",
          value: "emea",
        },
      ],
      combinator: "and",
    },
  ];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings,
    agentUpdates,
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);
  const retrievalSection = page.locator("#retrieval-skill-settings");
  const metadataRulesSection = page.locator("#agent-metadata-rules-settings");
  await expect(retrievalSection).toBeVisible();
  await expect(metadataRulesSection).toContainText("Using workspace default");
  await expect(metadataRulesSection).toContainText("1 inherited rule");
  await expect(metadataRulesSection).toContainText("region equals emea");
  await expect(metadataRulesSection.getByLabel("Field")).toHaveCount(0);

  await metadataRulesSection.getByRole("button", { name: "Override metadata rules" }).click();
  await expect(metadataRulesSection.getByLabel("Field")).toHaveValue("region");
  await expect(metadataRulesSection.getByPlaceholder("e.g. et or example.com")).toHaveValue("emea");

  await metadataRulesSection.getByLabel("Field").fill("region");
  await metadataRulesSection.getByPlaceholder("e.g. et or example.com").fill("eu");

  await expect.poll(() => {
    const last = agentUpdates.at(-1) as { skillSettings?: { "retrieval.answer"?: { metadataRules?: unknown[] } } } | undefined;
    return last?.skillSettings?.["retrieval.answer"]?.metadataRules?.length ?? 0;
  }).toBe(1);
  expect(agentUpdates.at(-1)).toMatchObject({
    skillSettings: {
      "retrieval.answer": {
        metadataRules: [
          {
            field: "region",
            valueType: "string",
            operator: "equals",
            value: "eu",
            effect: "boost",
            enabled: true,
            triggerMode: "always_on",
          },
        ],
      },
    },
  });

  await page.reload();
  await expect(metadataRulesSection.getByLabel("Field")).toHaveValue("region");
  await expect(metadataRulesSection.getByPlaceholder("e.g. et or example.com")).toHaveValue("eu");

  await metadataRulesSection.getByRole("button", { name: "Clear override" }).click();

  await expect.poll(() => JSON.stringify((agentUpdates.at(-1) as { skillSettings?: unknown } | undefined)?.skillSettings)).toBe("{}");
  await expect(metadataRulesSection).toContainText("Using workspace default");
  await expect(metadataRulesSection).toContainText("1 inherited rule");
  await expect(metadataRulesSection.getByLabel("Field")).toHaveCount(0);
});

test("agent skills tab keeps source scope and metadata rules together", async ({ page }) => {
  const agentUpdates: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    documentSources: baseDocumentSources(),
    agentUpdates,
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior`);
  await expect(page.locator("#assistant-behavior #agent-source-scope-settings")).toHaveCount(0);

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);
  const knowledgeScopeSection = page.locator("#agent-knowledge-scope-settings");
  await expect(knowledgeScopeSection).toBeVisible();
  await expect(knowledgeScopeSection.locator("#agent-source-scope-settings")).toBeVisible();
  await expect(knowledgeScopeSection.locator("#agent-metadata-rules-settings")).toBeVisible();

  await knowledgeScopeSection.getByRole("button", { name: "Selected sources" }).click();
  await knowledgeScopeSection.getByText("Release notes").click();

  await expect.poll(() => {
    const last = agentUpdates.at(-1) as { sourceScope?: { mode?: string; sourceIds?: string[] } } | undefined;
    return last?.sourceScope?.sourceIds?.length ?? 0;
  }).toBe(1);
  expect(agentUpdates.at(-1)).toMatchObject({
    sourceScope: {
      mode: "selected",
      sourceIds: ["22222222-2222-4222-8222-222222222222"],
    },
  });
  expect(agentUpdates.at(-1)).not.toHaveProperty("retrieval");
});
