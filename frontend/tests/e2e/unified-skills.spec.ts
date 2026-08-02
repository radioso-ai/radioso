import { expect, test } from "@playwright/test";

import {
  baseSkillCapabilities,
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
  const mcpConnectionRequests: string[] = [];
  const mcpConnectionId = "77777777-7777-4777-8777-777777777777";
  const alternateMcpConnectionId = "88888888-8888-4888-8888-888888888888";
  const skillCapabilities = baseSkillCapabilities();
  const mcpCapability = skillCapabilities.find((capability) => capability.id === "mcp_tool");
  if (!mcpCapability) throw new Error("MCP capability fixture missing");
  mcpCapability.targets = [
    { id: mcpConnectionId, label: "Support MCP", status: "authorized" },
    { id: alternateMcpConnectionId, label: "Analytics MCP", status: "authorized" },
  ];
  mcpCapability.available = true;
  mcpCapability.unavailableReason = null;

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    agentSkills,
    agentSkillRequests,
    skillCapabilities,
    mcpConnections: [{
      id: mcpConnectionId,
      displayName: "Support MCP",
      serverUrl: "https://mcp.example.com/mcp",
      authMethod: "access_token",
      status: "authorized",
      hasCredential: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }, {
      id: alternateMcpConnectionId,
      displayName: "Analytics MCP",
      serverUrl: "https://analytics-mcp.example.com/mcp",
      authMethod: "access_token",
      status: "authorized",
      hasCredential: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
    mcpDiscoveredTools: [{
      name: "post_message",
      description: "Post a support message.",
      inputSchema: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string", description: "Message text" },
          urgent: { type: "boolean", description: "Mark the message urgent" },
        },
      },
    }, {
      name: "create_ticket",
      description: "Create a support ticket.",
      inputSchema: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string", description: "Ticket title" },
          priority: { type: "boolean", description: "Mark the ticket high priority" },
        },
      },
    }],
    mcpConnectionRequests,
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);

  await expect(page.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Contact requests" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Webhook exports" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Retrieval answers" })).toHaveCount(0);

  await page.getByRole("button", { name: "Add new skill" }).click();
  await expect(page.getByRole("dialog", { name: "Add new skill" })).toBeVisible();
  await expect(page.getByRole("button", { name: /MCP Tool/i })).toBeEnabled();
  await expect(page.getByRole("button", { name: /Slack Post/i })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Notify Human/i })).toBeEnabled();
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

  await expect(page.getByText("@send_followup_email", { exact: true })).toBeVisible();

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

  await expect(page.getByText("@retrieve_events", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add new skill" }).click();
  await page.getByRole("button", { name: /MCP Tool/i }).click();
  await expect(page.getByRole("dialog", { name: "Configure MCP Tool" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "MCP tool" })).toContainText("post_message");
  await page.getByLabel("Target").click();
  await page.getByRole("option", { name: "Analytics MCP" }).click();
  await expect.poll(() => mcpConnectionRequests).toContain(
    `POST /agents/${defaultAgentId}/mcp-connections/${alternateMcpConnectionId}/discover`,
  );
  await expect(page.getByRole("combobox", { name: "MCP tool" })).toContainText("post_message");
  await page.getByRole("combobox", { name: "MCP tool" }).click();
  await page.getByRole("option", { name: "create_ticket" }).click();
  await page.getByLabel("Skill name").fill("support_create_ticket");
  await page.getByRole("button", { name: /Routine integration/ }).click();
  await expect(page.getByText("Ticket title")).toBeVisible();
  await page.getByRole("combobox", { name: "priority" }).click();
  await page.getByRole("option", { name: "Use a fixed value" }).click();
  await page.locator("input[placeholder='priority']").fill("true");
  await page.getByRole("button", { name: "Create skill" }).click();

  await expect(page.getByText("@support_create_ticket", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add new skill" }).click();
  await page.getByRole("button", { name: /Notify Human/i }).click();
  await expect(page.getByRole("dialog", { name: "Configure Notify Human" })).toBeVisible();
  // Re-adding a deleted "contact human" skill must default to the canonical name the
  // contact-request gate keys on, or "Talk to a human" stays disconnected.
  await expect(page.getByLabel("Skill name")).toHaveValue("contact_human");
  await page.keyboard.press("Escape");

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

  expect(createBodies[2]).toMatchObject({
    name: "support_create_ticket",
    capability: "mcp_tool",
    target: { kind: "mcp_connection", id: alternateMcpConnectionId },
    config: {
      toolName: "create_ticket",
      boundParams: { priority: true },
      exposedParams: {
        title: { description: "Ticket title", slotBinding: "title", required: true },
      },
      declaredOutcomes: ["completed", "failed"],
    },
    invocationMode: "routine_named",
    enabled: true,
  });

  expect(mcpConnectionRequests).toContain(
    `POST /agents/${defaultAgentId}/mcp-connections/${mcpConnectionId}/discover`,
  );
  expect(mcpConnectionRequests).toContain(
    `POST /agents/${defaultAgentId}/mcp-connections/${alternateMcpConnectionId}/discover`,
  );

});
