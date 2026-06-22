import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  type RoutineFixture,
  type RoutineMutationFixture,
  workspaceKey,
} from "./dashboard-fixtures";

test("author an approval gate in the Form editor, save, and reload", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "New routine" }).click();
  await page.getByRole("tab", { name: "Form" }).click();

  await page.getByLabel("Name").fill("Refund approval");
  await page.getByLabel("Activation trigger").fill("A refund over the limit needs a manager.");

  // Step 1 becomes the approval gate.
  await page.getByLabel("Step 1 id").fill("review");
  await page.getByLabel("Step 1 kind").click();
  await page.getByRole("option", { name: "approval" }).click();
  await page.getByLabel("Step 1 instruction").fill("Have a manager approve or deny the refund.");
  await page.getByLabel("Step 1 decision name").fill("refund_decision");

  // A follow-up step one option can branch into.
  await page.getByRole("button", { name: "Add step" }).click();
  await page.getByLabel("Step 2 id").fill("issue");
  await page.getByLabel("Step 2 instruction").fill("Issue the refund.");
  await page.getByRole("button", { name: "Add transition" }).click();
  await page.getByLabel("Transition 1 target").click();
  await page.getByRole("option", { name: "complete", exact: true }).click();

  // The gate seeds Approve + Decline; point each at a branch (and rename the second to Deny).
  // Option 1: Approve → the follow-up step.
  await page.getByLabel("Step 1 option 1 label").fill("Approve");
  await page.getByLabel("Step 1 option 1 id").fill("approve");
  await page.getByLabel("Step 1 option 1 target").click();
  await page.getByRole("option", { name: "issue", exact: true }).click();

  // Option 2: Deny → complete.
  await page.getByLabel("Step 1 option 2 label").fill("Deny");
  await page.getByLabel("Step 1 option 2 id").fill("deny");
  await page.getByLabel("Step 1 option 2 target").click();
  await page.getByRole("option", { name: "complete", exact: true }).click();

  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.getByText("Validation passed")).toBeVisible();

  const created = routineUpdates.find((update) => update.method === "POST");
  const body = created?.body as RoutineFixture | undefined;
  const approvalStep = body?.steps.find((step) => step.kind === "approval");
  expect(approvalStep).toMatchObject({
    stableStepId: "review",
    captureKey: "refund_decision",
    options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }],
  });
  const edges = (body?.transitions ?? []).filter((transition) => transition.fromStep === "review");
  expect(edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ toRef: "issue", guardKind: "field", fieldRef: "refund_decision.id", fieldOp: "equals", fieldValue: "approve" }),
    expect.objectContaining({ toRef: "complete", guardKind: "field", fieldRef: "refund_decision.id", fieldOp: "equals", fieldValue: "deny" }),
  ]));

  // Reload: go back, re-open, and confirm the gate persisted in the Form editor.
  await page.getByRole("button", { name: "Back to routines" }).click();
  await page.getByRole("button", { name: "Edit draft Refund approval" }).click();
  await page.getByRole("tab", { name: "Form" }).click();
  await expect(page.getByLabel("Step 1 decision name")).toHaveValue("refund_decision");
  await expect(page.getByLabel("Step 1 option 1 label")).toHaveValue("Approve");
  await expect(page.getByLabel("Step 1 option 2 label")).toHaveValue("Deny");
});

test("author an approval gate in the Prose editor, save, and reload without Form fallback", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "Write in prose" }).click();

  await page.getByLabel("Name", { exact: true }).fill("Refund approval");
  await page.getByLabel("Trigger", { exact: true }).fill("A refund over the limit needs a manager.");

  const editor = page.getByRole("textbox", { name: "Routine", exact: true });
  await editor.click();
  await editor.pressSequentially("Summarize the refund and get a manager decision. ");

  // Author the decision from scratch via the Decision toolbar button: enter the choices and
  // where each one routes. The dialog seeds Approve + Decline; point each at a branch.
  await page.getByRole("button", { name: "Decision", exact: true }).click();
  await page.getByLabel("Decision name").fill("refund_decision");
  await page.getByLabel("Option 1 label").fill("Approve");
  await page.getByLabel("Option 1 target").selectOption({ label: "End (complete)" });
  await page.getByLabel("Option 2 label").fill("Deny");
  await page.getByLabel("Option 2 target").selectOption({ label: "Handoff" });
  await page.getByRole("button", { name: "Save approval" }).click();

  // The gate renders as conditional prose, not an opaque badge: each choice and where it
  // routes is visible inline, in one decision chip.
  const chip = page.locator('[data-routine-chip="decision"]');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("refund_decision");
  await expect(chip).toContainText("if Approve then End");
  await expect(chip).toContainText("if Deny then Handoff");

  await page.getByRole("button", { name: "Save routine" }).click();
  await expect.poll(() => routineUpdates.filter((update) => update.method === "POST").length).toBeGreaterThan(0);

  const created = routineUpdates.find((update) => update.method === "POST");
  const body = created?.body as RoutineFixture | undefined;
  const approvalStep = body?.steps.find((step) => step.kind === "approval");
  expect(approvalStep).toMatchObject({
    captureKey: "refund_decision",
    options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }],
  });
  const edges = (body?.transitions ?? []).filter((transition) => transition.guardKind === "field");
  expect(edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ toRef: "done", fieldRef: "refund_decision.id", fieldOp: "equals", fieldValue: "approve" }),
    expect.objectContaining({ toRef: "handoff", fieldRef: "refund_decision.id", fieldOp: "equals", fieldValue: "deny" }),
  ]));

  // Reload: the gate round-trips back into Prose as the same inline decision chip (no Form
  // fallback, no opaque block chip), routing still visible.
  await page.getByRole("button", { name: "Back to routines" }).click();
  await page.getByRole("button", { name: "Edit draft Refund approval" }).click();
  await expect(page.getByRole("tab", { name: "Prose" })).toHaveAttribute("data-state", "active");
  const decisionChip = page.locator('[data-routine-chip="decision"]');
  await expect(decisionChip).toBeVisible();
  await expect(decisionChip).toContainText("refund_decision");
  await expect(decisionChip).toContainText("if Approve then End");
  await expect(decisionChip).toContainText("if Deny then Handoff");
});
