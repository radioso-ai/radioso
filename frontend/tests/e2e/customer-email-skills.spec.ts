import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  type RoutineMutationFixture,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

test("routine authoring exposes typed customer email skill outcomes", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    routineUpdates,
    emailSkills: [{
      id: "88888888-8888-4888-8888-000000000001",
      workspaceId,
      agentId: defaultAgentId,
      connectionId: "99999999-9999-4999-8999-000000000001",
      skillName: "support_email_customer",
      mode: "send",
      boundInputs: { subject: "Follow-up" },
      exposedInputs: { to: { slotBinding: "email" }, bodyText: { slotBinding: "emailBody" } },
      enabled: true,
      outcomes: ["drafted", "sent", "missing_input", "disabled_connection", "needs_reauth", "provider_rejected", "failed"],
      createdAt: nowIso,
      updatedAt: nowIso,
    }],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/new`);
  await page.getByRole("tab", { name: "Form" }).click();

  await page.getByLabel("Name").fill("Email follow-up");
  await page.getByLabel("Activation trigger").fill("Visitor asks for an email follow-up.");
  await page.getByLabel("Step 1 id").fill("send_email");
  await page.getByLabel("Step 1 kind").click();
  await page.getByRole("option", { name: "tool" }).click();
  await page.getByLabel("Step 1 tool reference").fill("support_email_customer");
  await page.getByLabel("Step 1 instruction").fill("Send the follow-up email.");

  await page.getByRole("button", { name: "Add transition" }).click();
  await page.getByLabel("Transition 1 target").click();
  await page.getByRole("option", { name: "complete" }).click();
  await page.getByLabel("Transition 1 guard").click();
  await page.getByRole("option", { name: "outcome" }).click();
  await page.getByLabel("Transition 1 outcome").click();
  await expect(page.getByRole("option", { name: "Provider rejected" })).toBeVisible();
  await page.getByRole("option", { name: "Provider rejected" }).click();

  await page.getByRole("button", { name: "Validate" }).click();

  await expect.poll(() => routineUpdates.some((update) => update.method === "POST")).toBe(true);
  const createUpdate = routineUpdates.find((update) => update.method === "POST");
  expect(createUpdate).toMatchObject({
    body: {
      steps: [{
        stableStepId: "send_email",
        kind: "tool",
        toolRef: "support_email_customer",
      }],
      transitions: [{
        fromStep: "send_email",
        guardKind: "outcome",
        outcomeStatus: "provider_rejected",
      }],
    },
  });
});
