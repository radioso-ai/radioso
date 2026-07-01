import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
  type AgentSkillFixture,
  type SkillCapabilityFixture,
} from "./dashboard-fixtures";

test("Slack channel connects, confirms binding, and disconnects", async ({ page }) => {
  const slackRequests: Array<{ method: string; path: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    slackRequests,
    slackStatus: { status: "not_configured" },
    slackBinding: { channelId: null, answeringAgentId: null, escalationChannelId: null, gapEscalationEnabled: false },
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=slack-channel`);

  // Scope to the Slack channel card's own heading (the channels page also has a "Slack" page heading).
  await expect(page.getByRole("heading", { name: "Slack", level: 3 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to Slack" })).toBeVisible();

  await page.getByRole("button", { name: "Add to Slack" }).click();
  await expect(page).toHaveURL(/\/oauth\/connections\/callback\?status=authorized&provider=slack/);

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=slack-channel`);

  await expect(page.getByText("Connected to Radioso Test").first()).toBeVisible();
  await expect(page.getByLabel("Default agent")).toContainText("Marta");
  await expect(page.getByText("Answers DMs and channels with no specific agent.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Channels this agent answers" })).toBeVisible();
  await page.getByLabel("Channel ID").fill("#support");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText("#support").first()).toBeVisible();
  await expect.poll(() =>
    slackRequests.some((request) =>
      request.method === "PUT" &&
      request.path === `/workspaces/${workspaceId}/slack/binding` &&
      JSON.stringify(request.body) === JSON.stringify({
        channelId: "#support",
        answeringAgentId: defaultAgentId,
      }),
    ),
  ).toBe(true);

  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("No channel-specific bindings for this agent.")).toBeVisible();
  await expect.poll(() =>
    slackRequests.some((request) =>
      request.method === "DELETE" &&
      request.path === `/workspaces/${workspaceId}/slack/binding` &&
      JSON.stringify(request.body) === JSON.stringify({ channelId: "#support" }),
    ),
  ).toBe(true);

  await expect(page.getByText("Where the agent posts handoffs and escalations.")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Auto-escalate when the agent has no grounded answer" })).not.toBeChecked();
  await page.getByLabel("Escalation channel").fill("#support");
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() =>
    slackRequests.some((request) =>
      request.method === "PUT" &&
      request.path === `/workspaces/${workspaceId}/slack/binding` &&
      JSON.stringify(request.body) === JSON.stringify({
        channelId: null,
        answeringAgentId: defaultAgentId,
        escalationChannelId: "#support",
        gapEscalationEnabled: false,
      }),
    ),
  ).toBe(true);

  await page.getByRole("switch", { name: "Auto-escalate when the agent has no grounded answer" }).click();
  await expect.poll(() =>
    slackRequests.some((request) =>
      request.method === "PUT" &&
      request.path === `/workspaces/${workspaceId}/slack/binding` &&
      JSON.stringify(request.body) === JSON.stringify({
        channelId: null,
        answeringAgentId: defaultAgentId,
        escalationChannelId: "#support",
        gapEscalationEnabled: true,
      }),
    ),
  ).toBe(true);

  await expect.poll(() =>
    slackRequests.some((request) =>
      request.method === "POST" &&
      request.path === `/workspaces/${workspaceId}/slack/install/start`,
    ),
  ).toBe(true);

  await page.getByLabel("Default agent").click();
  await page.getByRole("option", { name: "Marta" }).click();

  await expect.poll(() =>
    slackRequests.some((request) =>
      request.method === "PUT" &&
      request.path === `/workspaces/${workspaceId}/slack/binding` &&
      JSON.stringify(request.body) === JSON.stringify({
        channelId: null,
        answeringAgentId: defaultAgentId,
        escalationChannelId: "#support",
        gapEscalationEnabled: true,
      }),
    ),
  ).toBe(true);

  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("button", { name: "Add to Slack" })).toBeVisible();
});

test("Slack self-host setup shows generated manifest and env checklist before connect", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    slackStatus: { status: "not_configured" },
    slackBinding: { channelId: null, answeringAgentId: null, escalationChannelId: null, gapEscalationEnabled: false },
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=slack-channel`);

  await page.getByRole("button", { name: "Self-host setup" }).click();
  await expect(page.getByText("public HTTPS URL")).toBeVisible();
  await expect(page.getByText("https://self-host.example.com/api/v1/oauth/callback/slack")).toBeVisible();
  await expect(page.getByText("https://self-host.example.com/api/connectors/slack/events")).toBeVisible();
  await expect(page.getByText("SLACK_OAUTH_CLIENT_ID")).toBeVisible();
  await expect(page.getByText("SLACK_OAUTH_CLIENT_SECRET")).toBeVisible();
  await expect(page.getByText("SLACK_SIGNING_SECRET")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy manifest" })).toBeVisible();
});

test("Slack install is disabled when backend Slack env is incomplete", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    slackStatus: {
      status: "not_configured",
      readiness: {
        configured: false,
        missingEnvVars: ["SLACK_SIGNING_SECRET"],
      },
    },
    slackBinding: { channelId: null, answeringAgentId: null, escalationChannelId: null, gapEscalationEnabled: false },
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=slack-channel`);

  await expect(page.getByText("Configure SLACK_SIGNING_SECRET")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to Slack" })).toBeDisabled();
});

test("Slack routine skill authoring creates and disables a skill", async ({ page }) => {
  const slackRequests: Array<{ method: string; path: string; body?: unknown }> = [];
  const agentSkillRequests: Array<{ method: string; path: string; body?: unknown }> = [];
  const agentSkills: AgentSkillFixture[] = [];
  const slackPostCapabilities: SkillCapabilityFixture[] = [{
    id: "slack_post",
    storedKind: "slack",
    targetKind: "slack_installation",
    requiresTarget: true,
    inputSchema: { source: "static", schema: { fields: ["channelId", "text", "threadTs"], required: ["channelId", "text"] } },
    settingsFields: [],
    outcomeVocabulary: ["enqueued", "missing_input", "failed"],
    supportedInvocationModes: ["routine_named", "agent_selectable"],
    defaultInvocationMode: "routine_named",
    executorAdapter: "slack",
    targets: [{ id: "99999999-9999-4999-8999-000000000003", label: "Radioso Test", status: "authorized" }],
    available: true,
    unavailableReason: null,
  }];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    slackRequests,
    agentSkills,
    agentSkillRequests,
    skillCapabilities: slackPostCapabilities,
    slackStatus: {
      status: "connected",
      installationId: "99999999-9999-4999-8999-000000000003",
      teamName: "Radioso Test",
      answeringAgentId: defaultAgentId,
    },
    slackBinding: { channelId: null, answeringAgentId: defaultAgentId, escalationChannelId: "#support", gapEscalationEnabled: false },
    slackSkills: [],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);

  await expect(page.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Add new skill" }).click();
  await page.getByRole("button", { name: /Slack Post/i }).click();
  const skillDialog = page.getByRole("dialog", { name: "Configure Slack Post" });
  await expect(skillDialog).toBeVisible();
  await skillDialog.getByLabel("Skill name").fill("post_update_to_slack");
  await skillDialog.getByRole("button", { name: "Advanced" }).click();
  await skillDialog.getByRole("combobox", { name: "channelId" }).click();
  await page.getByRole("option", { name: "Use a fixed value" }).click();
  await skillDialog.locator("input[placeholder='channelId']").fill("#ops");
  await skillDialog.getByLabel("text slot").fill("message");
  await skillDialog.getByRole("button", { name: "Create skill" }).click();

  await expect(page.getByText("@post_update_to_slack", { exact: true })).toBeVisible();
  await expect.poll(() =>
    Boolean(agentSkillRequests.find((request) =>
      request.method === "POST" &&
      request.path === `/agents/${defaultAgentId}/skills`,
    )?.body),
  ).toBe(true);
  const createdSkillBody = agentSkillRequests.find((request) =>
    request.method === "POST" &&
    request.path === `/agents/${defaultAgentId}/skills`,
  )?.body;
  expect(createdSkillBody).toMatchObject({
    name: "post_update_to_slack",
    capability: "slack_post",
    target: { kind: "slack_installation", id: "99999999-9999-4999-8999-000000000003" },
    config: {
      boundInputs: { channelId: "#ops" },
      exposedInputs: { text: { description: "Text", slotBinding: "message", required: true } },
    },
    invocationMode: "routine_named",
    enabled: true,
  });

  await page.getByRole("switch", { name: "Enable post_update_to_slack" }).click();

  await expect.poll(() =>
    agentSkillRequests.some((request) =>
      request.method === "PATCH" &&
      request.path === `/agents/${defaultAgentId}/skills/66666666-6666-4666-8666-000000000001` &&
      JSON.stringify(request.body) === JSON.stringify({ enabled: false }),
    ),
  ).toBe(true);
});
