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

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await expect(documentEditor).toBeVisible();

  // The editor's rest state is the reader rendering. Each piece of document prose opens
  // its existing controls only after the author selects that row.
  await documentEditor.getByRole("button", { name: "Starts when", exact: true }).click();
  await documentEditor.getByLabel("Activation trigger", { exact: true }).fill("a customer asks whether an order is eligible.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await documentEditor.getByRole("button", { name: "Step", exact: true }).click();
  await page.getByRole("menuitem", { name: "Chat" }).click();
  await documentEditor.getByRole("button", { name: "Chat", exact: true }).click();
  const chatInstruction = documentEditor.getByLabel("Step 1 instruction");
  await chatInstruction.click();
  await chatInstruction.pressSequentially("Ask for @order_total");
  await page.getByRole("option", { name: /Create variable “order_total”/ }).click();
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();
  await documentEditor.getByRole("button", { name: "order_total", exact: true }).click();
  await documentEditor.getByLabel("Slot order_total type").selectOption("number");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await documentEditor.getByRole("button", { name: "Step", exact: true }).click();
  await page.getByRole("menuitem", { name: "Check eligibility" }).first().click();
  const skillStep = documentEditor.getByRole("button", { name: "Check eligibility", exact: true }).locator("xpath=ancestor::li[1]");
  await expect(skillStep.getByText("uses nothing → sets nothing")).toBeVisible();
  await skillStep.getByRole("button", { name: "Check eligibility", exact: true }).click();
  await skillStep.getByRole("button", { name: "Done", exact: true }).click();
  await skillStep.getByRole("button", { name: "Check eligibility", exact: true }).click();
  const skillInstruction = documentEditor.getByLabel("Step 2 instruction");
  await skillInstruction.click();
  await skillInstruction.pressSequentially("Check eligibility for the order.");
  await skillStep.getByRole("button", { name: "Done", exact: true }).click();

  // A field comparison goes to a hand-off ending, while a separate judgment branch is
  // retained as an AI-decides route in the reader view.
  await skillStep.getByRole("button", { name: "Check eligibility", exact: true }).click();
  await skillStep.getByRole("button", { name: "Condition", exact: true }).click();
  await skillStep.getByLabel("Rule variable").selectOption("order_total");
  await skillStep.getByLabel("Rule operator").selectOption("lt");
  await skillStep.getByLabel("Rule value").fill("50");
  await skillStep.getByRole("button", { name: "New hand-off" }).click();
  await skillStep.getByLabel("Ending message").fill("Hand this order to the billing team.");
  await skillStep.getByRole("button", { name: "Done", exact: true }).click();

  await skillStep.getByRole("button", { name: "Check eligibility", exact: true }).click();
  await skillStep.getByRole("button", { name: "Condition", exact: true }).click();
  await skillStep.getByLabel("Decision kind").selectOption("llm");
  await skillStep.getByLabel("AI condition").fill("The customer needs a nuanced eligibility explanation.");
  await skillStep.getByRole("button", { name: "Done", exact: true }).click();

  await documentEditor.getByRole("button", { name: "Finish ending", exact: true }).click();
  await documentEditor.getByLabel("complete message").fill("Eligibility check finished.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  // What was authored reads back in the document itself: the skill step, the rule branch
  // that hands off, and the judgment branch beside it.
  await expect(documentEditor).toContainText("Check eligibility");
  await expect(documentEditor).toContainText("Hand this order to the billing team.");
  await expect(documentEditor).toContainText("The customer needs a nuanced eligibility explanation.");

  await expect.poll(
    () => routineUpdates.some((update) => update.method === "POST"),
    { timeout: 15_000 },
  ).toBe(true);
  await expect(page.getByRole("status", { name: "Routine valid" })).toBeVisible({ timeout: 15_000 });

  const editableRestText = await documentEditor.innerText();
  const documentLines = [
    "Ask for order_total",
    "Check eligibility for the order.",
    "uses nothing → sets nothing",
    "order_total is less than 50",
    "The customer needs a nuanced eligibility explanation.",
    "Hand off: Hand this order to the billing team.",
    "Finish: Eligibility check finished.",
  ];
  for (const line of documentLines) expect(editableRestText).toContain(line);

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("published v1 (read-only)", { exact: true })).toBeVisible();

  const documentReader = page.getByRole("article", { name: "Routine document" });
  const readerText = await documentReader.innerText();
  for (const line of documentLines) {
    expect(editableRestText).toContain(line);
    expect(readerText).toContain(line);
  }
  await expect(page.getByRole("button", { name: "Step", exact: true })).toHaveCount(0);
});

test("a step instruction keeps the lines its author wrote", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await expect(page.getByRole("heading", { name: "Routines", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "New routine" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Multi-line step");

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await documentEditor.getByRole("button", { name: "Starts when", exact: true }).click();
  await documentEditor.getByLabel("Activation trigger", { exact: true }).fill("a visitor opens a conversation.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await documentEditor.getByRole("button", { name: "Step", exact: true }).click();
  await page.getByRole("menuitem", { name: "Chat" }).click();
  await documentEditor.getByRole("button", { name: "Chat", exact: true }).click();

  const instruction = documentEditor.getByLabel("Step 1 instruction");
  await instruction.click();
  await instruction.pressSequentially("Greet the visitor.");
  await instruction.press("Enter");
  await instruction.pressSequentially("Then ask what they need.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  // The row reads back both lines, and reopening the editor shows the same document.
  const row = documentEditor.getByRole("button", { name: "Instruction" }).first();
  await expect(row).toContainText("Greet the visitor.");
  await expect(row).toContainText("Then ask what they need.");

  await expect.poll(
    () => routineUpdates.find((update) => update.method === "POST")?.body,
    { timeout: 15_000 },
  ).toMatchObject({
    steps: [{ instruction: "Greet the visitor.\nThen ask what they need." }],
  });

  await row.click();
  await expect(documentEditor.getByLabel("Step 1 instruction")).toContainText("Then ask what they need.");
});
