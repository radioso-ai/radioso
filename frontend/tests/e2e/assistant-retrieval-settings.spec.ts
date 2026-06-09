import { expect, test } from "@playwright/test";

import {
  baseDocumentSources,
  basePlatformSettings,
  baseRetrievalDefaults,
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
  // Pre-expand sanity: a visible inherited default (Suggested questions). Query
  // rewrite's "Default: off" lives inside the collapsed Advanced group, asserted
  // there after expanding (and again after clear, below).
  await expect(retrievalSection).toContainText("Default: on");

  await retrievalSection.getByRole("button", { name: "Advanced" }).click();
  await retrievalSection.getByRole("region", { name: "Answering" }).getByRole("button", { name: "Explain Query Rewrite" }).click();
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
  await retrievalSection.getByRole("button", { name: "Advanced" }).click();
  await expect(page.locator("#retrievalQueryRewrite")).toContainText("On");

  await page.locator("#retrievalQueryRewrite").click();
  await page.getByRole("option", { name: "Use workspace default" }).click();

  await expect.poll(() => JSON.stringify((agentUpdates.at(-1) as { skillSettings?: unknown } | undefined)?.skillSettings)).toBe("{}");
  await expect(retrievalSection.getByRole("region", { name: "Answering" })).toContainText("Default: off");
});

test("agent retrieval skill settings show scope first and answering controls under Advanced", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    documentSources: baseDocumentSources(),
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);
  const retrievalSection = page.locator("#retrieval-skill-settings");
  await expect(retrievalSection).toBeVisible();

  const sourceScope = retrievalSection.locator("#agent-source-scope-settings");
  const suggestedQuestions = retrievalSection.getByText("Suggested Questions", { exact: true });
  const advancedButton = retrievalSection.getByRole("button", { name: "Advanced" });
  await expect(sourceScope).toBeVisible();
  await expect(suggestedQuestions).toBeVisible();
  await expect(advancedButton).toBeVisible();
  await expect(retrievalSection.getByRole("heading", { name: "Knowledge scope", exact: true })).toHaveCount(0);

  await expect.poll(async () =>
    sourceScope.evaluate((sourceElement) => {
      const root = sourceElement.closest("#retrieval-skill-settings");
      const suggested = root?.querySelector("#agentSuggestedQuestionsEnabled");
      const advanced = Array.from(root?.querySelectorAll("button") ?? []).find((button) =>
        button.textContent?.trim() === "Advanced",
      );
      if (!suggested || !advanced) {
        return false;
      }
      const sourceBeforeSuggested = Boolean(
        sourceElement.compareDocumentPosition(suggested) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      const suggestedBeforeAdvanced = Boolean(
        suggested.compareDocumentPosition(advanced) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      return sourceBeforeSuggested && suggestedBeforeAdvanced;
    }),
  ).toBe(true);

  await expect(page.locator("#retrievalQueryRewrite")).toBeHidden();
  await advancedButton.click();

  const answeringGroup = retrievalSection.getByRole("region", { name: "Answering" });
  await expect(answeringGroup.getByText("Query Rewrite", { exact: true })).toBeVisible();
  await expect(answeringGroup.getByText("Answering Strategy", { exact: true })).toBeVisible();
  const retrievalTuningGroup = retrievalSection.getByRole("region", { name: "Retrieval tuning" });
  await expect(retrievalTuningGroup.getByText("Vector Top K", { exact: true })).toBeVisible();
  await expect(retrievalTuningGroup.getByRole("button", { name: "Override vector top K" })).toBeVisible();
  const metadataRulesGroup = retrievalSection.getByRole("region", { name: "Metadata rules" });
  await expect(metadataRulesGroup.getByText("Metadata Rules", { exact: true })).toBeVisible();
  await expect(metadataRulesGroup.locator("#agent-metadata-rules-settings")).toBeVisible();
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
  const retrievalDefaults = baseRetrievalDefaults();
  retrievalDefaults.metadataRules = [
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
    retrievalDefaults,
    agentUpdates,
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);
  const retrievalSection = page.locator("#retrieval-skill-settings");
  const metadataRulesSection = page.locator("#agent-metadata-rules-settings");
  await expect(retrievalSection).toBeVisible();
  await expect(metadataRulesSection).toBeHidden();
  await retrievalSection.getByRole("button", { name: "Advanced" }).click();
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
  await retrievalSection.getByRole("button", { name: "Advanced" }).click();
  await expect(metadataRulesSection.getByLabel("Field")).toHaveValue("region");
  await expect(metadataRulesSection.getByPlaceholder("e.g. et or example.com")).toHaveValue("eu");

  await metadataRulesSection.getByRole("button", { name: "Clear override" }).click();

  await expect.poll(() => JSON.stringify((agentUpdates.at(-1) as { skillSettings?: unknown } | undefined)?.skillSettings)).toBe("{}");
  await expect(metadataRulesSection).toContainText("Using workspace default");
  await expect(metadataRulesSection).toContainText("1 inherited rule");
  await expect(metadataRulesSection.getByLabel("Field")).toHaveCount(0);
});

test("agent skills tab keeps source scope primary and metadata rules under Advanced", async ({ page }) => {
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
  const retrievalSection = page.locator("#retrieval-skill-settings");
  await expect(knowledgeScopeSection).toBeVisible();
  await expect(knowledgeScopeSection.locator("#agent-source-scope-settings")).toBeVisible();
  await expect(knowledgeScopeSection.locator("#agent-metadata-rules-settings")).toHaveCount(0);
  await expect(retrievalSection.locator("#agent-metadata-rules-settings")).toBeHidden();

  await retrievalSection.getByRole("button", { name: "Advanced" }).click();
  const metadataRulesGroup = retrievalSection.getByRole("region", { name: "Metadata rules" });
  await expect(metadataRulesGroup.locator("#agent-metadata-rules-settings")).toBeVisible();

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
