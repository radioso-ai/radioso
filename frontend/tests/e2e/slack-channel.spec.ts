import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

test("Slack channel connects, confirms binding, and disconnects", async ({ page }) => {
  const slackRequests: Array<{ method: string; path: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    slackRequests,
    slackStatus: { status: "not_configured" },
    slackBinding: { answeringAgentId: null, escalationChannelId: null },
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels#slack-channel`);

  await expect(page.getByRole("heading", { name: "Slack" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to Slack" })).toBeVisible();

  await page.getByRole("button", { name: "Add to Slack" }).click();
  await expect(page).toHaveURL(/\/oauth\/connections\/callback\?status=authorized&provider=slack/);

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels#slack-channel`);

  await expect(page.getByText("Connected to Radioso Test").first()).toBeVisible();
  await expect(page.getByLabel("Answering agent")).toContainText("Marta");
  await page.getByLabel("Escalation channel").fill("#support");
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() =>
    slackRequests.some((request) =>
      request.method === "PUT" &&
      request.path === `/workspaces/${workspaceId}/agents/${defaultAgentId}/slack/binding` &&
      JSON.stringify(request.body) === JSON.stringify({
        answeringAgentId: defaultAgentId,
        escalationChannelId: "#support",
      }),
    ),
  ).toBe(true);

  await expect.poll(() =>
    slackRequests.some((request) =>
      request.method === "POST" &&
      request.path === `/workspaces/${workspaceId}/agents/${defaultAgentId}/slack/install/start`,
    ),
  ).toBe(true);

  await page.getByLabel("Answering agent").click();
  await page.getByRole("option", { name: "Marta" }).click();

  await expect.poll(() =>
    slackRequests.some((request) =>
      request.method === "PUT" &&
      request.path === `/workspaces/${workspaceId}/agents/${defaultAgentId}/slack/binding` &&
      JSON.stringify(request.body) === JSON.stringify({
        answeringAgentId: defaultAgentId,
        escalationChannelId: "#support",
      }),
    ),
  ).toBe(true);

  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("button", { name: "Add to Slack" })).toBeVisible();
});

test("Slack routine skill authoring creates and disables a skill", async ({ page }) => {
  const slackRequests: Array<{ method: string; path: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    slackRequests,
    slackStatus: {
      status: "connected",
      installationId: "99999999-9999-4999-8999-000000000003",
      teamName: "Radioso Test",
      answeringAgentId: defaultAgentId,
    },
    slackBinding: { answeringAgentId: defaultAgentId, escalationChannelId: "#support" },
    slackSkills: [],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=assistant#assistant-skills`);

  const slackSkills = page.locator("#assistant-slack-skills");
  await expect(slackSkills.getByRole("heading", { name: "Slack skills" })).toBeVisible();
  await slackSkills.getByLabel("Skill name").fill("post_update_to_slack");
  await slackSkills.getByLabel("Fixed channel").fill("#ops");
  await slackSkills.getByLabel("Message slot").fill("message");
  await slackSkills.getByRole("button", { name: "Save Slack skill" }).click();

  await expect(slackSkills.getByText("post_update_to_slack")).toBeVisible();
  await expect(slackSkills.getByText("Posts to #ops")).toBeVisible();
  await expect.poll(() =>
    slackRequests.some((request) =>
      request.method === "POST" &&
      request.path === `/agents/${defaultAgentId}/slack-skills` &&
      JSON.stringify(request.body) === JSON.stringify({
        skillName: "post_update_to_slack",
        installationId: "99999999-9999-4999-8999-000000000003",
        boundInputs: { channelId: "#ops" },
        exposedInputs: { text: { slotBinding: "message", required: true } },
        enabled: true,
      }),
    ),
  ).toBe(true);

  await slackSkills.getByRole("switch").last().click();

  await expect.poll(() =>
    slackRequests.some((request) =>
      request.method === "PATCH" &&
      request.path === `/agents/${defaultAgentId}/slack-skills/77777777-7777-4777-8777-000000000001` &&
      JSON.stringify(request.body) === JSON.stringify({ enabled: false }),
    ),
  ).toBe(true);
});
