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
  await expect(page.getByRole("tab", { name: "Document" })).toHaveAttribute("data-state", "active");
  await page.getByRole("tab", { name: "Form" }).click();
  await expect(page.getByRole("tab", { name: "Form" })).toHaveAttribute("data-state", "active");

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

  await expect.poll(() => routineUpdates.some((update) => update.method === "POST"), { timeout: 15_000 }).toBe(true);

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

test("author an approval gate in the Document editor, save, and publish", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "New routine" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Refund approval");

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await expect(documentEditor).toBeVisible();
  await documentEditor.getByRole("button", { name: "Starts when", exact: true }).click();
  await documentEditor.getByLabel("Activation trigger", { exact: true }).fill("A refund over the limit needs a manager.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  // Adding an approval step synthesizes one decision edge per option; the instruction editor
  // opens because the new step has no question yet.
  await documentEditor.getByRole("button", { name: "Step", exact: true }).click();
  await page.getByRole("menuitem", { name: "Approval" }).click();
  await documentEditor.getByRole("button", { name: "Approval", exact: true }).click();
  const question = documentEditor.getByLabel("Step 1 instruction");
  await question.click();
  await question.pressSequentially("Summarize the refund and get a manager decision.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  // Each option's edge reads as an ordinary rule row; route the decline edge to a hand-off.
  const approvalStep = documentEditor.getByRole("button", { name: "Approval", exact: true }).locator("xpath=ancestor::li[1]");
  await expect(approvalStep.getByText("A person chooses:")).toBeVisible();
  await expect(approvalStep.getByText("decision.id is approve")).toBeVisible();
  await approvalStep.getByRole("button", { name: "Rule", exact: true }).nth(1).click();
  await approvalStep.getByRole("button", { name: "New hand-off" }).click();
  await approvalStep.getByLabel("Ending message").fill("A manager will take over.");
  await approvalStep.getByRole("button", { name: "Done", exact: true }).click();

  await expect.poll(() => routineUpdates.filter((update) => update.method === "POST").length, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(page.getByRole("status", { name: "Routine valid" })).toBeVisible({ timeout: 15_000 });

  const created = routineUpdates.find((update) => update.method === "POST");
  const body = created?.body as RoutineFixture | undefined;
  const approval = body?.steps.find((step) => step.kind === "approval");
  expect(approval).toMatchObject({
    captureKey: "decision",
    options: [{ id: "approve", label: "Approve" }, { id: "decline", label: "Decline" }],
  });
  const edges = (body?.transitions ?? []).filter((transition) => transition.guardKind === "field");
  expect(edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ fieldRef: "decision.id", fieldOp: "equals", fieldValue: "approve" }),
    expect.objectContaining({ fieldRef: "decision.id", fieldOp: "equals", fieldValue: "decline" }),
  ]));

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("published v1 (read-only)", { exact: true })).toBeVisible();

  // The locked reader shows the question, the choices, and where each decision routes.
  const reader = page.getByRole("article", { name: "Routine document" });
  await expect(reader).toContainText("Summarize the refund and get a manager decision.");
  await expect(reader).toContainText("A person chooses:");
  await expect(reader).toContainText("decision.id is approve");
  await expect(reader).toContainText("A manager will take over.");
});
