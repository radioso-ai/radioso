import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
  type AgentSkillFixture,
} from "./dashboard-fixtures";

test("unified Skills surface creates skills with descriptor-owned settings controls", async ({ page }) => {
  test.setTimeout(60_000);

  const agentSkillRequests: Array<{ method: string; path: string; body?: unknown }> = [];
  const agentSkills: AgentSkillFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    agentSkills,
    agentSkillRequests,
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);

  await expect(page.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Contact requests" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Webhook exports" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Retrieval answers" })).toHaveCount(0);

  await page.getByRole("button", { name: "Add new skill" }).click();
  await expect(page.getByRole("dialog", { name: "Add new skill" })).toBeVisible();
  await expect(page.getByRole("button", { name: /MCP Tool/i })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Slack Post/i })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Notify Human/i })).toHaveCount(0);
  await page.getByRole("button", { name: /Email/i }).click();
  await expect(page.getByRole("dialog", { name: "Configure Email" })).toBeVisible();
  await expect(page.getByLabel("Skill name")).toHaveValue("send_support_outbound_email");
  await expect(page.getByLabel("Target")).toBeVisible();
  await expect(page.getByLabel("Mode")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "subject" })).toHaveCount(0);
  await page.getByLabel("Skill name").fill("send_followup_email");
  await page.locator("#skill-setting-mode").click();
  await page.getByRole("option", { name: "Send" }).click();
  await page.getByRole("button", { name: "Advanced" }).click();
  await page.getByLabel("When to use").click();
  await page.getByRole("option", { name: "Agent decides when to use it" }).click();
  await page.getByRole("button", { name: /Routine integration/ }).click();
  await page.getByRole("combobox", { name: "subject" }).click();
  await page.getByRole("option", { name: "Use a fixed value" }).click();
  await page.locator("input[placeholder='subject']").fill("Follow up");
  await page.getByLabel("bodyText slot").fill("message");
  await page.getByRole("button", { name: "failed" }).click();
  await expect(page.locator("#skill-extra-config")).toBeVisible();
  await page.getByRole("button", { name: "Create skill" }).click();

  await expect(page.getByText("@send_followup_email")).toBeVisible();

  await page.getByRole("button", { name: "Add new skill" }).click();
  await page.getByRole("button", { name: /Knowledge Retrieval/i }).click();
  await expect(page.getByRole("dialog", { name: "Configure Knowledge Retrieval" })).toBeVisible();
  await expect(page.getByLabel("Skill name")).toHaveValue("retrieve_course_guide");
  await expect(page.getByLabel("Vector top K")).toHaveCount(0);
  await page.getByLabel("Skill name").fill("retrieve_events");
  await page.getByRole("button", { name: "Selected sources" }).click();
  await page.getByLabel(/Course guide/).check();
  await page.getByRole("textbox", { name: "Instruction", exact: true }).fill("Use event-specific sources only.");
  await expect(page.getByRole("switch", { name: "Suggested questions", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Advanced" }).click();
  await page.getByLabel("When to use").click();
  await page.getByRole("option", { name: "Only when a routine calls it (@name)" }).click();
  await page.locator("#skill-setting-retrievalStrategy").click();
  await page.getByRole("option", { name: "Reasoning" }).click();
  await page.getByLabel("Vector top K").fill("12");
  await expect(page.getByLabel("Rerank top K")).toHaveCount(0);
  await page.getByRole("switch", { name: "Rerank results" }).click();
  await page.getByLabel("Rerank top K").fill("6");
  await expect(page.getByLabel("Semantic rewrite instructions", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Override Semantic rewrite instructions" }).click();
  await page.getByLabel("Semantic rewrite instructions", { exact: true }).fill("Prefer event names and dates.");
  await page.getByRole("button", { name: "Override Lexical rewrite instructions" }).click();
  await page.getByLabel("Lexical rewrite instructions", { exact: true }).fill("Include exact venue terms.");
  await page.getByLabel("Suggested questions count").fill("3");
  await page.getByRole("button", { name: "Create skill" }).click();

  await expect(page.getByText("@retrieve_events")).toBeVisible();

  await page.getByRole("button", { name: "Add new skill" }).click();
  await expect(page.getByRole("button", { name: /Notify Human/i })).toHaveCount(0);

  await expect.poll(() =>
    agentSkillRequests.filter((request) =>
      request.method === "POST" &&
      request.path === `/agents/${defaultAgentId}/skills`,
    ).length,
  ).toBe(2);
  const createBodies = agentSkillRequests
    .filter((request) => request.method === "POST" && request.path === `/agents/${defaultAgentId}/skills`)
    .map((request) => request.body);

  expect(createBodies[0]).toMatchObject({
      name: "send_followup_email",
      capability: "email",
      target: { kind: "customer_email_connection", id: "99999999-9999-4999-8999-000000000001" },
      config: {
        mode: "send",
        boundInputs: { subject: "Follow up" },
        exposedInputs: {
          to: { description: "To", slotBinding: "to", required: true },
          bodyText: { description: "Body Text", slotBinding: "message", required: true },
        },
      },
      invocationMode: "agent_selectable",
      enabled: true,
  });

  expect(createBodies[1]).toMatchObject({
    name: "retrieve_events",
    capability: "retrieve",
    target: { kind: "source_scope", id: "11111111-1111-4111-8111-111111111111" },
    config: {
      sourceScope: { sourceIds: ["11111111-1111-4111-8111-111111111111"] },
      instruction: "Use event-specific sources only.",
      retrievalStrategy: "reasoning",
      vectorTopK: 12,
      rerankEnabled: true,
      rerankTopK: 6,
      semanticRewriteInstructions: "Prefer event names and dates.",
      lexicalRewriteInstructions: "Include exact venue terms.",
      suggestedQuestionsCount: 3,
      exposedInputs: { query: true },
    },
    invocationMode: "routine_named",
  });

  expect(createBodies[1]).not.toMatchObject({
    config: { similarityThreshold: expect.anything() },
  });

});
