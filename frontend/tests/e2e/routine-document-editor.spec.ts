import { expect, test, type Locator, type Page } from "@playwright/test";

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
  // Collected information and Endings live inside the collapsed "Endings & information" disclosure.
  await documentEditor.getByRole("button", { name: "Toggle details", exact: true }).click();
  await documentEditor.getByRole("button", { name: "order_total", exact: true }).click();
  await documentEditor.getByLabel("Slot order_total type").selectOption("number");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await documentEditor.getByRole("button", { name: "Step", exact: true }).click();
  await page.getByRole("menuitem", { name: "Check eligibility" }).first().click();
  const skillStep = documentEditor.getByRole("button", { name: "Check eligibility", exact: true }).locator("xpath=ancestor::li[1]");
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
  // The uses/sets summary lives in the step editor the step's own token opens, not as a
  // line that hovers into view on the row itself.
  await expect(skillStep.getByText("uses nothing → sets nothing")).toBeVisible();
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

  await documentEditor.getByRole("button", { name: "Finish ending", exact: true }).filter({ hasText: "Confirm completion." }).click();
  await documentEditor.getByLabel("complete message").fill("Eligibility check finished.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  // What was authored reads back in the document itself: the skill step, the rule branch
  // that hands off, and the judgment branch beside it.
  await expect(documentEditor).toContainText("Check eligibility");
  await expect(documentEditor).toContainText("Hand this order to the billing team.");
  await expect(documentEditor).toContainText("The customer needs a nuanced eligibility explanation.");
  // Both non-default branches read as an "IF" box on the rail, the rule and the AI judgment
  // alike; only the plain onward path skips it.
  await expect(documentEditor.getByText("If", { exact: true }).first()).toBeVisible();

  await expect.poll(
    () => routineUpdates.some((update) => update.method === "POST"),
    { timeout: 15_000 },
  ).toBe(true);
  await expect(page.getByRole("status", { name: "Routine valid" })).toBeVisible({ timeout: 15_000 });

  const editableRestText = await documentEditor.innerText();
  const documentLines = [
    "Ask for @order_total",
    "Check eligibility for the order.",
    "order_total is less than 50",
    "The customer needs a nuanced eligibility explanation.",
    "Hand off: Hand this order to the billing team.",
    "Finish: Eligibility check finished.",
  ];
  for (const line of documentLines) expect(editableRestText).toContain(line);

  // Authoring saves as it goes, with no publish step in between, so what the server returns
  // on a reload is the same document — still editable.
  await page.reload();
  const reloadedEditor = page.getByRole("article", { name: "Routine document editor" });
  await expect(reloadedEditor).toBeVisible();
  const reloadedText = await reloadedEditor.innerText();
  for (const line of documentLines) expect(reloadedText).toContain(line);
  await expect(reloadedEditor.getByRole("button", { name: "Step", exact: true })).toBeVisible();

  // Creating a routine replaces the /new route. Going back and starting another one must not
  // restore the just-created document from new-draft recovery storage.
  await page.getByRole("button", { name: "Back to routines" }).click();
  await page.getByRole("button", { name: "New routine" }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
  await expect(page.getByRole("article", { name: "Routine document editor" })).not.toContainText("Check order eligibility");
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

test("exposes a routine as a tool, shows the name diagnostic, and saves the corrected name", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await expect(page.getByRole("heading", { name: "Routines", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "New routine" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Start a return");

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await documentEditor.getByRole("button", { name: "Starts when", exact: true }).click();
  await documentEditor.getByLabel("Activation trigger", { exact: true }).fill("a customer wants to return an order.");
  // The exposure controls sit inside the "Starts when" editor; the name and description
  // fields only appear once the switch is on.
  await expect(documentEditor.getByLabel("Tool name")).toHaveCount(0);
  await documentEditor.getByRole("switch", { name: "Expose as a tool" }).click();
  await documentEditor.getByLabel("Tool name").fill("Start Return");
  await documentEditor.getByLabel("Tool description").fill("Start a return for an order.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await documentEditor.getByRole("button", { name: "Step", exact: true }).click();
  await page.getByRole("menuitem", { name: "Chat" }).click();
  await documentEditor.getByRole("button", { name: "Chat", exact: true }).click();
  const instruction = documentEditor.getByLabel("Step 1 instruction");
  await instruction.click();
  await instruction.pressSequentially("Ask for the order number.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  // The reader line names the tool, and the saved draft carries the block as typed: the
  // grammar is a validator diagnostic, not a refused save.
  await expect(documentEditor.getByRole("button", { name: "Starts when", exact: true })).toContainText("Start Return");
  await expect.poll(
    () => routineUpdates.find((update) => update.method === "POST")?.body?.exposure,
    { timeout: 15_000 },
  ).toEqual({ enabled: true, toolName: "Start Return", description: "Start a return for an order." });
  await expect(page.getByText(/invalid tool name: "Start Return"/u)).toBeVisible({ timeout: 15_000 });

  await documentEditor.getByRole("button", { name: "Starts when", exact: true }).click();
  await documentEditor.getByLabel("Tool name").fill("start_return");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await expect.poll(
    () => routineUpdates.filter((update) => update.method === "PATCH").at(-1)?.body?.exposure,
    { timeout: 15_000 },
  ).toEqual({ enabled: true, toolName: "start_return", description: "Start a return for an order." });
  await expect(page.getByText(/invalid tool name/u)).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Routine valid" })).toBeVisible({ timeout: 15_000 });
});

const addChatStep = async (page: Page, documentEditor: Locator, text: string) => {
  await documentEditor.getByRole("button", { name: "Step", exact: true }).click();
  await page.getByRole("menuitem", { name: "Chat" }).click();
  await documentEditor.getByRole("button", { name: "Chat", exact: true }).last().click();
  const instruction = documentEditor.getByLabel(/Step \d+ instruction/).last();
  await instruction.click();
  await instruction.pressSequentially(text);
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();
};

test("reorders a step from its collapsed row, with no editor panel open", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await expect(page.getByRole("heading", { name: "Routines", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "New routine" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Reorder from the collapsed row");

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await documentEditor.getByRole("button", { name: "Starts when", exact: true }).click();
  await documentEditor.getByLabel("Activation trigger", { exact: true }).fill("a visitor opens a conversation.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await addChatStep(page, documentEditor, "First step text");
  await addChatStep(page, documentEditor, "Second step text");

  // Both rows are collapsed now — no step editor panel is open. The boundary controls are
  // disabled from the start.
  await expect(documentEditor.getByRole("button", { name: "Move step 1 up" })).toBeDisabled();
  await expect(documentEditor.getByRole("button", { name: "Move step 2 down" })).toBeDisabled();

  await documentEditor.getByRole("button", { name: "Move step 1 down" }).click();

  const afterMove = await documentEditor.innerText();
  expect(afterMove.indexOf("Second step text")).toBeLessThan(afterMove.indexOf("First step text"));
  await expect(documentEditor.getByRole("button", { name: "Move step 1 up" })).toBeDisabled();
  await expect(documentEditor.getByRole("button", { name: "Move step 2 down" })).toBeDisabled();

  await expect.poll(
    () => routineUpdates.find((update) => update.method === "POST")?.body,
    { timeout: 15_000 },
  ).toMatchObject({
    steps: [{ instruction: "Second step text" }, { instruction: "First step text" }],
  });
});

test("inserts a step between two existing rows", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await expect(page.getByRole("heading", { name: "Routines", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "New routine" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Insert between two rows");

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await documentEditor.getByRole("button", { name: "Starts when", exact: true }).click();
  await documentEditor.getByLabel("Activation trigger", { exact: true }).fill("a visitor opens a conversation.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await addChatStep(page, documentEditor, "First step text");
  await addChatStep(page, documentEditor, "Second step text");

  // The insert control between the two rows offers the same step-kind choices as the top
  // "+ Step" control, but splices the new step in after step 1 instead of appending it.
  await documentEditor.getByRole("button", { name: "Insert step after step 1" }).click();
  await page.getByRole("menuitem", { name: "Ask or tell" }).click();

  // The new step lands at position 2, between the two original rows: last position, and the
  // original order of the two authored steps is undisturbed around it.
  const newStepInstructionButton = documentEditor.getByRole("button", { name: "Instruction" }).filter({ hasText: "Write what this step should do…" });
  await expect(newStepInstructionButton).toBeVisible();
  await expect(documentEditor.getByRole("button", { name: "Move step 1 up" })).toBeDisabled();
  await expect(documentEditor.getByRole("button", { name: "Move step 3 down" })).toBeDisabled();
  const afterInsert = await documentEditor.innerText();
  expect(afterInsert.indexOf("First step text")).toBeLessThan(afterInsert.indexOf("Second step text"));

  // Give the inserted step an instruction so the routine is valid again, then confirm the
  // save carries the full, correctly ordered three-step document.
  await newStepInstructionButton.click();
  const newStepEditor = documentEditor.getByLabel("Step 2 instruction");
  await newStepEditor.click();
  await newStepEditor.pressSequentially("Inserted step text");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await expect.poll(
    () => routineUpdates.find((update) => update.method === "POST")?.body,
    { timeout: 15_000 },
  ).toMatchObject({
    steps: [{ instruction: "First step text" }, { instruction: "Inserted step text" }, { instruction: "Second step text" }],
  });
});

test("a step instruction offers only the variable menu, never a skill or flow-target menu", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    routineUpdates,
    routineSkillCatalog: [{
      skillName: "orders.check_eligibility",
      displayName: "Check eligibility",
      category: "external_mcp",
      inputs: [],
      outcomes: [],
      hasDataOutputs: false,
    }],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await expect(page.getByRole("heading", { name: "Routines", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "New routine" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Step text stays plain");

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await documentEditor.getByRole("button", { name: "Starts when", exact: true }).click();
  await documentEditor.getByLabel("Activation trigger", { exact: true }).fill("a visitor opens a conversation.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await documentEditor.getByRole("button", { name: "Step", exact: true }).click();
  await page.getByRole("menuitem", { name: "Chat" }).click();
  await documentEditor.getByRole("button", { name: "Chat", exact: true }).click();

  // A step's instruction is stored as text plus slot references only, so `#` — the skill
  // trigger everywhere else in a routine — must not open a menu here: a skill is called
  // through a tool step, never through step text.
  const instruction = documentEditor.getByLabel("Step 1 instruction");
  await instruction.click();
  await instruction.pressSequentially("Ask via #ananda_edizioni_mcp");
  await expect(page.getByRole("listbox")).toHaveCount(0);

  // `@` still opens the variable menu, undisturbed by `#` finding nothing.
  await instruction.pressSequentially(" then @order_total");
  await expect(page.getByRole("listbox", { name: "Insert a variable" })).toBeVisible();
  await page.getByRole("option", { name: /Create variable “order_total”/ }).click();

  // The same menu offers what the agent already knows about the visitor. "Current page"
  // places a context chip the step reads — it is not a slot the visitor is asked for, so
  // nothing new appears under Information.
  await instruction.pressSequentially(" on @Current");
  await page.getByRole("option", { name: "Current page", exact: true }).click();
  await expect(instruction.locator('[data-routine-chip="context"]')).toHaveCount(1);
  await expect(instruction.locator('[data-routine-chip="variable"]')).toHaveCount(1);
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  // The `#` text was never converted to a chip: it reads back exactly as typed.
  await expect(documentEditor).toContainText("Ask via #ananda_edizioni_mcp then @order_total on Current page");
});

test("a variable chip is clickable and selectable, and either selection path removes it as a whole", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "New routine" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Chip selection");

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await documentEditor.getByRole("button", { name: "Starts when", exact: true }).click();
  await documentEditor.getByLabel("Activation trigger", { exact: true }).fill("a visitor opens a conversation.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await documentEditor.getByRole("button", { name: "Step", exact: true }).click();
  await page.getByRole("menuitem", { name: "Chat" }).click();
  await documentEditor.getByRole("button", { name: "Chat", exact: true }).click();
  const instruction = documentEditor.getByLabel("Step 1 instruction");
  await instruction.click();
  await instruction.pressSequentially("Ask for @order_total");
  await page.getByRole("option", { name: /Create variable “order_total”/ }).click();

  const chip = instruction.locator('[data-routine-chip="variable"]');
  await expect(chip).toHaveCount(1);

  // A click selects the chip and opens its existing editing affordance in the same action —
  // the caret does not have to be placed on it first.
  await chip.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");

  // The click's selection survives the menu closing: Backspace now acts on the whole selected
  // chip, not a character of the surrounding text.
  await page.keyboard.press("Backspace");
  await expect(chip).toHaveCount(0);
  await expect(instruction).toContainText("Ask for");
  await expect(instruction).not.toContainText("order_total");

  // A second chip, reached by caret instead of a click: Shift+ArrowLeft from just past it
  // extends the selection across it as one unit (Lexical's own decorator-node caret
  // behaviour, not the click path above), and Backspace removes it the same way.
  await documentEditor.getByRole("button", { name: "Step", exact: true }).click();
  await page.getByRole("menuitem", { name: "Chat" }).click();
  await documentEditor.getByRole("button", { name: "Chat", exact: true }).last().click();
  const secondInstruction = documentEditor.getByLabel("Step 2 instruction");
  await secondInstruction.click();
  await secondInstruction.pressSequentially("@order_total");
  await page.getByRole("option", { name: "@order_total" }).click();

  const secondChip = secondInstruction.locator('[data-routine-chip="variable"]');
  await expect(secondChip).toHaveCount(1);
  await secondInstruction.press("End");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Backspace");
  await expect(secondChip).toHaveCount(0);
  await expect(secondInstruction).not.toContainText("order_total");
});

test("double-clicking a variable chip drops it to editable text, and re-resolving round-trips the same persisted slot reference", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "New routine" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Chip re-resolve");

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await documentEditor.getByRole("button", { name: "Starts when", exact: true }).click();
  await documentEditor.getByLabel("Activation trigger", { exact: true }).fill("a visitor opens a conversation.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await documentEditor.getByRole("button", { name: "Step", exact: true }).click();
  await page.getByRole("menuitem", { name: "Chat" }).click();
  await documentEditor.getByRole("button", { name: "Chat", exact: true }).click();
  const instruction = documentEditor.getByLabel("Step 1 instruction");
  await instruction.click();
  await instruction.pressSequentially("Ask for @order_total");
  await page.getByRole("option", { name: /Create variable “order_total”/ }).click();

  const chip = instruction.locator('[data-routine-chip="variable"]');
  await expect(chip).toHaveCount(1);

  // A double-click drops the chip back to its raw "@name" text and reopens the typeahead at
  // that position, so a mistyped or abandoned edit resolves as ordinary text — never a
  // broken-looking bound chip.
  await chip.dblclick();
  await expect(chip).toHaveCount(0);
  await expect(page.getByRole("listbox", { name: "Insert a variable" })).toBeVisible();
  await expect(instruction).toContainText("@order_total");

  // Re-picking the same variable from the reopened menu re-resolves it to a bound chip, and
  // the persisted instruction is exactly what it would have been without the round trip.
  await page.getByRole("option", { name: "@order_total" }).click();
  await expect(chip).toHaveCount(1);
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await expect.poll(
    () => routineUpdates.find((update) => update.method === "POST")?.body?.steps?.[0]?.instruction,
    { timeout: 15_000 },
  ).toBe("Ask for {{slot.order_total}} ");
});

test("leaving a chip's raw text unresolved persists as plain step text, not a broken chip", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "New routine" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Chip left unresolved");

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await documentEditor.getByRole("button", { name: "Starts when", exact: true }).click();
  await documentEditor.getByLabel("Activation trigger", { exact: true }).fill("a visitor opens a conversation.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await documentEditor.getByRole("button", { name: "Step", exact: true }).click();
  await page.getByRole("menuitem", { name: "Chat" }).click();
  await documentEditor.getByRole("button", { name: "Chat", exact: true }).click();
  const instruction = documentEditor.getByLabel("Step 1 instruction");
  await instruction.click();
  await instruction.pressSequentially("Ask for @order_total");
  await page.getByRole("option", { name: /Create variable “order_total”/ }).click();

  const chip = instruction.locator('[data-routine-chip="variable"]');
  await chip.dblclick();
  await expect(chip).toHaveCount(0);
  await expect(page.getByRole("listbox", { name: "Insert a variable" })).toBeVisible();

  // Walk away from the reopened menu without picking anything — the raw text stays exactly
  // that: text, not a slot reference, so the routine still saves cleanly. The variable it
  // was going to bind stays declared with nothing referencing it, which is a real (and
  // separately surfaced) validation diagnostic, not a save failure or a broken chip.
  await page.keyboard.press("Escape");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await expect.poll(
    () => routineUpdates.find((update) => update.method === "POST")?.body?.steps?.[0]?.instruction,
    { timeout: 15_000 },
  ).toBe("Ask for @order_total ");
  await expect(page.getByRole("status", { name: "Routine has validation issues" })).toBeVisible({ timeout: 15_000 });
});

test("Backspace on an empty step deletes it and focuses the previous step", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "New routine" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Backspace deletes an empty step");

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await documentEditor.getByRole("button", { name: "Starts when", exact: true }).click();
  await documentEditor.getByLabel("Activation trigger", { exact: true }).fill("a visitor opens a conversation.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await addChatStep(page, documentEditor, "First step text");

  // A second step, created but left empty — no text, no chips.
  await documentEditor.getByRole("button", { name: "Step", exact: true }).click();
  await page.getByRole("menuitem", { name: "Chat" }).click();
  await documentEditor.getByRole("button", { name: "Chat", exact: true }).last().click();
  const secondInstruction = documentEditor.getByLabel("Step 2 instruction");
  await expect(secondInstruction).toBeVisible();
  await secondInstruction.click();

  await page.keyboard.press("Backspace");

  // The empty step is gone, and typing lands in the previous step's editor, at its end —
  // continuing its sentence rather than overwriting the start of it.
  await expect(documentEditor.getByLabel("Step 2 instruction")).toHaveCount(0);
  const firstInstruction = documentEditor.getByLabel("Step 1 instruction");
  await expect(firstInstruction).toBeVisible();
  await page.keyboard.type(" continued");
  await expect(firstInstruction).toContainText("First step text continued");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await expect.poll(
    () => routineUpdates.find((update) => update.method === "POST")?.body?.steps,
    { timeout: 15_000 },
  ).toMatchObject([{ instruction: "First step text continued" }]);
});

test("Backspace on an empty first step is a no-op — nothing before it to focus", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {});

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "New routine" }).click();
  await page.getByLabel("Name", { exact: true }).fill("First step Backspace is a no-op");

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await documentEditor.getByRole("button", { name: "Starts when", exact: true }).click();
  await documentEditor.getByLabel("Activation trigger", { exact: true }).fill("a visitor opens a conversation.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await documentEditor.getByRole("button", { name: "Step", exact: true }).click();
  await page.getByRole("menuitem", { name: "Chat" }).click();
  await documentEditor.getByRole("button", { name: "Chat", exact: true }).click();
  const firstInstruction = documentEditor.getByLabel("Step 1 instruction");
  await expect(firstInstruction).toBeVisible();
  await firstInstruction.click();

  await page.keyboard.press("Backspace");

  // Still there — an empty first step has no previous step to remove it in favor of.
  await expect(documentEditor.getByLabel("Step 1 instruction")).toBeVisible();
  await expect(documentEditor.getByRole("button", { name: "Add step" })).toBeVisible();
});

test("the gutter's hover trash deletes a step and persists the removal through autosave", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "New routine" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Hover trash deletes a step");

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await documentEditor.getByRole("button", { name: "Starts when", exact: true }).click();
  await documentEditor.getByLabel("Activation trigger", { exact: true }).fill("a visitor opens a conversation.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await addChatStep(page, documentEditor, "First step text");
  await addChatStep(page, documentEditor, "Second step text");

  const firstRow = documentEditor.getByRole("button", { name: "Instruction" }).filter({ hasText: "First step text" }).locator("xpath=ancestor::li[1]");
  await firstRow.hover();
  // Disambiguated from the step editor panel's own "Remove step" trash — both can be on
  // screen at once, so the gutter one needs its own name.
  await firstRow.getByRole("button", { name: "Delete step", exact: true }).click();

  await expect(documentEditor).not.toContainText("First step text");
  await expect(documentEditor).toContainText("Second step text");

  await expect.poll(
    () => routineUpdates.find((update) => update.method === "POST")?.body?.steps,
    { timeout: 15_000 },
  ).toMatchObject([{ instruction: "Second step text" }]);
});
