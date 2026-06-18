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
        escalationChannelId: null,
      }),
    ),
  ).toBe(true);

  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("button", { name: "Add to Slack" })).toBeVisible();
});
