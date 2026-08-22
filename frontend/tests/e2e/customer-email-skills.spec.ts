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
    // The document offers steps from the skill catalog, which carries the email skill and
    // the typed outcomes a branch can react to.
    routineSkillCatalog: [{
      skillName: "support_email_customer",
      displayName: "Send follow-up email",
      category: "customer_email",
      inputs: [],
      outcomes: [
        { name: "sent", displayName: "Sent", status: "sent" },
        { name: "provider_rejected", displayName: "Provider rejected", status: "provider_rejected" },
      ],
      hasDataOutputs: false,
    }],
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
  await page.getByLabel("Name", { exact: true }).fill("Email follow-up");

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await documentEditor.getByRole("button", { name: "Starts when", exact: true }).click();
  await documentEditor.getByLabel("Activation trigger", { exact: true }).fill("Visitor asks for an email follow-up.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await documentEditor.getByRole("button", { name: "Chat", exact: true }).click();
  const instruction = documentEditor.getByLabel("Step 1 instruction");
  await instruction.click();
  await instruction.pressSequentially("Send the follow-up email.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await documentEditor.getByRole("button", { name: "Chat", exact: true }).click();
  await documentEditor.getByLabel("Step 1 kind").selectOption("tool");
  await documentEditor.getByLabel(/catalog item/).selectOption("support_email_customer");
  await documentEditor.getByLabel("Step 1 id").fill("send_email");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  // The skill's typed outcomes drive the branch, so the routine can react to a rejection.
  await documentEditor.getByRole("button", { name: "Send follow-up email", exact: true }).click();
  await documentEditor.getByRole("button", { name: "Condition", exact: true }).click();
  await documentEditor.getByLabel("Rule kind").selectOption("outcome");
  await expect(documentEditor.getByLabel("Outcome status")).toBeVisible();
  await documentEditor.getByLabel("Outcome status").fill("provider_rejected");
  await documentEditor.getByLabel("Branch target").selectOption("ending:complete");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await expect.poll(() => routineUpdates.some((update) => update.method === "POST"), { timeout: 15_000 }).toBe(true);
  const createUpdate = routineUpdates.filter((update) => update.body).at(-1);
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
