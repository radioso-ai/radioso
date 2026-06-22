import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
  type AgentSkillFixture,
} from "./dashboard-fixtures";

test("unified Skills surface creates skills with descriptor-owned settings controls", async ({ page }) => {
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
  await page.getByRole("combobox").first().click();
  await page.getByRole("option", { name: /Email/ }).click();
  await page.getByLabel("Skill name").fill("send_followup_email");
  await page.locator("#skill-setting-mode").click();
  await page.getByRole("option", { name: "Send" }).click();
  await page.getByRole("combobox", { name: "subject" }).click();
  await page.getByRole("option", { name: "Bind" }).click();
  await page.locator("input[placeholder='subject']").fill("Follow up");
  await page.getByRole("combobox", { name: "bodyText" }).click();
  await page.getByRole("option", { name: "Expose" }).click();
  await page.getByLabel("bodyText slot").fill("message");
  await expect(page.locator("#skill-extra-config")).toHaveCount(0);
  await page.getByRole("button", { name: "Create skill" }).click();

  await expect(page.getByText("@send_followup_email")).toBeVisible();

  await page.getByRole("button", { name: "Add new skill" }).click();
  await page.getByLabel("Skill name").fill("retrieve_events");
  await page.getByRole("button", { name: "Selected sources" }).click();
  await page.getByLabel(/Course guide/).check();
  await page.getByRole("textbox", { name: "Instruction", exact: true }).fill("Use event-specific sources only.");
  await page.locator("#skill-setting-retrievalStrategy").click();
  await page.getByRole("option", { name: "Reasoning" }).click();
  await page.getByLabel("Vector top K").fill("12");
  await page.getByLabel("Rerank results").click();
  await page.getByLabel("Rerank top K").fill("6");
  await page.getByLabel("Query rewrite").click();
  await page.getByLabel("Semantic rewrite instructions").fill("Prefer event names and dates.");
  await page.getByLabel("Lexical rewrite instructions").fill("Include exact venue terms.");
  await page.getByRole("switch", { name: "Suggested questions", exact: true }).click();
  await page.getByLabel("Suggested questions count").fill("3");
  await page.getByRole("button", { name: "Create skill" }).click();

  await expect(page.getByText("@retrieve_events")).toBeVisible();

  await page.getByRole("button", { name: "Add new skill" }).click();
  await page.getByRole("combobox").first().click();
  await page.getByRole("option", { name: /Notify/ }).click();
  await page.getByLabel("Skill name").fill("contact_human");
  await page.getByLabel("Recipient emails 1").fill("sales@example.com");
  await page.getByLabel("Recipient emails 2").fill("support@example.com");
  await page.getByLabel("Webhook URL").fill("https://hooks.example.com/contact");
  await page.getByRole("button", { name: "Create skill" }).click();

  await expect(page.getByText("@contact_human")).toBeVisible();

  await expect.poll(() =>
    agentSkillRequests.filter((request) =>
      request.method === "POST" &&
      request.path === `/agents/${defaultAgentId}/skills`,
    ).length,
  ).toBe(3);
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
          to: { slotBinding: "to", required: true },
          cc: { slotBinding: "cc", required: true },
          bodyText: { slotBinding: "message", required: true },
          bodyHtml: { slotBinding: "bodyhtml", required: true },
          replyTo: { slotBinding: "replyto", required: true },
        },
      },
      invocationMode: "routine_named",
      enabled: true,
  });

  expect(createBodies[1]).toMatchObject({
    name: "retrieve_events",
    capability: "retrieve",
    target: { kind: "source_scope", id: "all" },
    config: {
      sourceScope: { sourceIds: ["11111111-1111-4111-8111-111111111111"] },
      instruction: "Use event-specific sources only.",
      retrievalStrategy: "reasoning",
      vectorTopK: 12,
      rerankEnabled: true,
      rerankTopK: 6,
      queryRewriteEnabled: true,
      semanticRewriteInstructions: "Prefer event names and dates.",
      lexicalRewriteInstructions: "Include exact venue terms.",
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 3,
      exposedInputs: { query: true },
    },
  });

  expect(createBodies[1]).not.toMatchObject({
    config: { similarityThreshold: expect.anything() },
  });

  expect(createBodies[2]).toMatchObject({
    name: "contact_human",
    capability: "notify",
    target: { kind: "notify_delivery", id: "default" },
    config: {
      delivery: {
        recipientEmails: ["sales@example.com", "support@example.com"],
        webhook: { url: "https://hooks.example.com/contact" },
      },
      exposedInputs: {
        message: true,
        email: true,
      },
    },
  });
});
