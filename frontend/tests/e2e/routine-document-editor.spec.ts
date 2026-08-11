import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  type RoutineMutationFixture,
  workspaceKey,
} from "./dashboard-fixtures";

test("author, validate, and read a routine through the Document tab", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    routineUpdates,
    routineSkillCatalog: [{
      skillName: "orders.check_eligibility",
      displayName: "Check eligibility",
      category: "external_mcp",
      inputs: [{ key: "order_total", type: "number", required: true }],
      outcomes: [{ name: "approved", displayName: "Approved", status: "approved" }],
      hasDataOutputs: false,
    }],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await expect(page.getByRole("heading", { name: "Routines", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "New routine" }).click();

  await page.getByLabel("Name", { exact: true }).fill("Check order eligibility");
  await page.getByLabel("Activation trigger", { exact: true }).fill("When a customer asks whether an order is eligible.");
  await page.getByRole("tab", { name: "Document" }).click();

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await expect(documentEditor).toBeVisible();
  await documentEditor.getByLabel("Activation trigger", { exact: true }).fill("Starts when a customer asks whether an order is eligible.");

  // The Document view keeps instructions as prose and adds captured values as typed information.
  await documentEditor.getByRole("button", { name: "Step", exact: true }).click();
  await page.getByRole("menuitem", { name: "Chat" }).click();
  const chatInstruction = documentEditor.getByLabel("Step 1 instruction");
  await chatInstruction.click();
  await chatInstruction.pressSequentially("Ask for @order_total");
  await page.getByRole("option", { name: /Create variable “order_total”/ }).click();
  await expect(documentEditor.getByLabel("Slot order_total type")).toBeVisible();
  await documentEditor.getByLabel("Slot order_total type").selectOption("number");

  // Add a catalog skill from the same + Step menu. Its binding line remains visible even
  // before any optional input or output assignments are made.
  await documentEditor.getByRole("button", { name: "Step", exact: true }).click();
  await page.getByRole("menuitem", { name: "Check eligibility" }).first().click();
  const skillStep = documentEditor.getByLabel(/catalog item/).locator("xpath=ancestor::li[1]");
  await expect(skillStep.getByText("uses nothing → sets nothing")).toBeVisible();
  const skillInstruction = documentEditor.getByLabel("Step 2 instruction");
  await skillInstruction.click();
  await skillInstruction.pressSequentially("Check eligibility for the order.");

  // A field comparison goes to a hand-off ending, while a separate judgment branch is
  // retained as an AI-decides route in the reader view.
  await skillStep.getByRole("button", { name: "Condition", exact: true }).click();
  await skillStep.getByLabel("Rule kind").selectOption("field");
  await skillStep.getByLabel("Rule variable").selectOption("order_total");
  await skillStep.getByLabel("Rule operator").selectOption("lt");
  await skillStep.getByLabel("Rule value").fill("50");
  await skillStep.getByRole("button", { name: "New hand-off" }).click();
  await skillStep.getByLabel("Ending message").fill("Hand this order to the billing team.");

  await skillStep.getByRole("button", { name: "Condition", exact: true }).click();
  await skillStep.getByLabel("Decision kind").nth(1).selectOption("llm");
  await skillStep.getByLabel("AI condition").fill("The customer needs a nuanced eligibility explanation.");

  // The original complete terminal is the fall-through ending for the routine.
  await documentEditor.getByLabel("complete message").fill("Eligibility check finished.");
  await expect(documentEditor.getByRole("heading", { name: "Endings" })).toBeVisible();

  // Form receives the projected draft, including the chat instruction, tool step, and both
  // branch guards. Returning to Document keeps the same draft selected.
  await page.getByRole("tab", { name: "Form" }).click();
  await expect(page.getByLabel("Step 1 instruction")).toHaveValue(/Ask for \{\{slot\.order_total\}\}\s*/);
  await expect(page.getByLabel("Step 2 kind")).toContainText("tool");
  // The Form transition model carries no field-guard columns (fieldRef/fieldOp/fieldValue),
  // so a field guard renders an empty kind select there; assert the synced target instead.
  // The Document tab remains the authoring surface for typed comparisons.
  await expect(page.getByLabel("Transition 1 target")).toContainText("handoff_1");
  await expect(page.getByLabel("Transition 2 guard")).toContainText(/llm/i);
  await page.getByRole("tab", { name: "Document" }).click();
  await expect(documentEditor).toBeVisible();

  await expect.poll(
    () => routineUpdates.some((update) => update.method === "POST"),
    { timeout: 15_000 },
  ).toBe(true);
  await expect(page.getByRole("status", { name: "Routine valid" })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("published v1 (read-only)", { exact: true })).toBeVisible();

  // Published routines use the locked reader. It renders the branch decision provenance,
  // the hand-off and finish endings, and no editing controls.
  const documentReader = page.getByRole("article", { name: "Routine document" });
  await expect(documentReader).toContainText("Rule");
  await expect(documentReader).toContainText("AI decides");
  await expect(documentReader).toContainText(/hand off: Hand this order to the billing team\./i);
  await expect(documentReader).toContainText(/finish: Eligibility check finished\.?/i);
  await expect(documentReader.getByText("uses nothing → sets nothing")).toBeVisible();
  await expect(page.getByRole("button", { name: "Step", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Activation", exact: true })).toHaveCount(0);
});
