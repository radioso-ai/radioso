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
  await expect(page.getByRole("tab", { name: "Prose" })).toHaveAttribute("data-state", "active");
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

test("author an approval gate in the Prose editor, save, and reload without Form fallback", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "New routine" }).click();

  await page.getByLabel("Name", { exact: true }).fill("Refund approval");
  await page.getByLabel("Activation trigger", { exact: true }).fill("A refund over the limit needs a manager.");

  const editor = page.getByRole("textbox", { name: "Routine", exact: true });
  await editor.click();
  await editor.pressSequentially("Summarize the refund and get a manager decision. ");

  // Insert a self-contained approval chip: capture key + option→target table. The dialog
  // seeds Approve + Decline; point each at a branch (and rename the second to Deny).
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Approval" }).click();
  await page.getByLabel("Decision name").fill("refund_decision");
  await page.getByLabel("Option 1 label").fill("Approve");
  await page.getByLabel("Option 1 target").selectOption({ label: "End (complete)" });
  await page.getByLabel("Option 2 label").fill("Deny");
  await page.getByLabel("Option 2 target").selectOption({ label: "Handoff" });
  await page.getByRole("button", { name: "Save approval" }).click();

  // The gate renders as conditional prose, not an opaque badge: each choice and where it
  // routes is visible inline.
  const chip = page.locator('[data-routine-chip="approval"]');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("refund_decision");
  await expect(chip).toContainText("if Approve then End");
  await expect(chip).toContainText("if Deny then Handoff");

  await expect(page.getByRole("status", { name: "Routine valid" })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => routineUpdates.filter((update) => update.method === "POST").length, { timeout: 15_000 }).toBeGreaterThan(0);

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

  // Reload: the approval round-trips back into Prose as the inline decision model — a small
  // `decision` declaration chip plus one editable branch line per choice (no Form fallback,
  // and no opaque block chip).
  await page.getByRole("button", { name: "Back to routines" }).click();
  await page.getByRole("button", { name: "Edit draft Refund approval" }).click();
  await expect(page.getByRole("tab", { name: "Prose" })).toHaveAttribute("data-state", "active");
  const decisionChip = page.locator('[data-routine-chip="decision"]');
  await expect(decisionChip).toBeVisible();
  await expect(decisionChip).toContainText("refund_decision");
  await expect(decisionChip).toContainText("Approve");
  await expect(decisionChip).toContainText("Deny");
  // The branches are ordinary inline condition + target chips now.
  await expect(editor.locator('[data-routine-chip="condition"]').first()).toBeVisible();
  await expect(editor.locator('[data-routine-chip="handoff"]')).toBeVisible();
});

test("author an approval gate by typing the rules in the Prose editor (no buttons)", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "New routine" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Typed approval");
  await page.getByLabel("Activation trigger", { exact: true }).fill("A refund needs a manager.");

  const editor = page.getByRole("textbox", { name: "Routine", exact: true });
  await editor.click();

  // Declare the gate by typing @decision — no toolbar button.
  await editor.pressSequentially("Get a manager decision. ");
  await editor.pressSequentially("@decision");
  await page.getByRole("option", { name: "Decision (a person chooses)" }).click();

  // Type the rules as branch lines: "if decision is Approve → End", "if decision is Deny → Handoff".
  await page.keyboard.press("Enter");
  await editor.pressSequentially("@approve");
  await page.getByRole("option", { name: "If decision is Approve" }).click();
  await editor.pressSequentially("@end");
  await page.getByRole("option", { name: "End (complete the routine)" }).click();

  await page.keyboard.press("Enter");
  await editor.pressSequentially("@deny");
  await page.getByRole("option", { name: "If decision is Deny" }).click();
  await editor.pressSequentially("@handoff");
  await page.getByRole("option", { name: "Handoff (escalate to a person)" }).click();

  await expect(page.getByRole("status", { name: "Routine valid" })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => routineUpdates.filter((update) => update.method === "POST").length, { timeout: 15_000 }).toBeGreaterThan(0);

  const body = routineUpdates.find((update) => update.method === "POST")?.body as RoutineFixture | undefined;
  const approvalStep = body?.steps.find((step) => step.kind === "approval");
  expect(approvalStep).toMatchObject({ captureKey: "decision", options: [{ id: "approve" }, { id: "deny" }] });
  const edges = (body?.transitions ?? []).filter((transition) => transition.guardKind === "field");
  expect(edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ toRef: "done", fieldRef: "decision.id", fieldOp: "equals", fieldValue: "approve" }),
    expect.objectContaining({ toRef: "handoff", fieldRef: "decision.id", fieldOp: "equals", fieldValue: "deny" }),
  ]));
});
