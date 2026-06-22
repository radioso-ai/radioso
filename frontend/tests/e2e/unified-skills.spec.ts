import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
  type AgentSkillFixture,
} from "./dashboard-fixtures";

test("unified Skills surface creates an email skill through the shared form", async ({ page }) => {
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
  await page.getByRole("combobox", { name: "subject" }).click();
  await page.getByRole("option", { name: "Bind" }).click();
  await page.locator("input[placeholder='subject']").fill("Follow up");
  await page.getByRole("combobox", { name: "bodyText" }).click();
  await page.getByRole("option", { name: "Expose" }).click();
  await page.getByLabel("bodyText slot").fill("message");
  await page.locator("#skill-extra-config").fill('{"mode":"send"}');
  await page.getByRole("button", { name: "Create skill" }).click();

  await expect(page.getByText("@send_followup_email")).toBeVisible();
  await expect.poll(() =>
    agentSkillRequests.find((request) =>
      request.method === "POST" &&
      request.path === `/agents/${defaultAgentId}/skills`,
    )?.body,
  ).toBeTruthy();
  const createBody = agentSkillRequests.find((request) =>
    request.method === "POST" &&
    request.path === `/agents/${defaultAgentId}/skills`,
  )?.body;
  expect(createBody).toMatchObject({
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
});
