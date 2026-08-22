import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  type RoutineFixture,
  type RoutineMutationFixture,
  workspaceKey,
} from "./dashboard-fixtures";

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
