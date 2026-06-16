import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  type RoutineMutationFixture,
  workspaceKey,
} from "./dashboard-fixtures";

test("author a routine with variable and skill chips, set a type, and save", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await expect(page.getByRole("heading", { name: "Routines", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Write in prose" }).click();
  await expect(page.getByText("Write a routine in plain language")).toBeVisible();

  await page.getByLabel("Name", { exact: true }).fill("Process a refund request");
  await page.getByLabel("Trigger", { exact: true }).fill("When a customer wants a refund or to dispute a charge");

  // The toolbar above the editor offers formatting + chip insertion.
  await expect(page.getByRole("button", { name: "Bold" })).toBeVisible();

  // Author inline; insert a variable chip via @ — no syntax typed.
  const editor = page.getByRole("textbox", { name: "Routine", exact: true });
  await editor.click();
  await editor.pressSequentially("Ask for the order id and the reason. Collect ");
  // Underscore in the name must keep the menu open (regression: it cancelled the popover).
  await editor.pressSequentially("@order_id");
  await expect(page.getByRole("option", { name: /Create variable/ })).toBeVisible();
  await page.keyboard.press("Enter");

  const variableChip = page.locator('[data-routine-chip="variable"]');
  await expect(variableChip).toBeVisible();
  await expect(variableChip).toContainText("@order_id");
  // The type is part of the chip's identity, so it shows on the chip face.
  await expect(variableChip).toContainText("text");
  await expect(editor).not.toContainText("{{");

  // The same @ menu is kind-aware: pick a skill instead of a variable.
  await editor.pressSequentially("then @refund");
  await expect(page.getByRole("option", { name: "Skill: refund" })).toBeVisible();
  await page.getByRole("option", { name: "Skill: refund" }).click();
  await expect(page.locator('[data-routine-chip="skill"]')).toBeVisible();

  // Set the variable's type from its own inline menu (no separate list).
  await variableChip.click();
  await expect(page.getByRole("menuitemradio", { name: "date" })).toBeVisible();
  await page.getByRole("menuitemradio", { name: "date" }).click();
  // The new type is reflected on the chip face.
  await expect(variableChip).toContainText("date");

  await page.screenshot({ path: "demo-screenshots/routine-chip-editor-demo.png", fullPage: true });

  await page.getByRole("button", { name: "Save routine" }).click();

  await expect.poll(() => routineUpdates.filter((update) => update.method === "POST").length).toBeGreaterThan(0);
  const created = routineUpdates.find((update) => update.method === "POST");
  expect(created?.body?.name).toBe("Process a refund request");
  const orderSlot = (created?.body?.slots ?? []).find((slot: { key: string; type: string }) => slot.key === "order_id");
  expect(orderSlot?.type).toBe("date");
});

test("the Bold toolbar button reflects its active state", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates: [] });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "Write in prose" }).click();

  const editor = page.getByRole("textbox", { name: "Routine", exact: true });
  await editor.click();
  await editor.pressSequentially("Step 1");
  await page.keyboard.press("ControlOrMeta+a");

  const bold = page.getByRole("button", { name: "Bold" });
  await expect(bold).toHaveAttribute("aria-pressed", "false");
  await bold.click();
  await expect(bold).toHaveAttribute("aria-pressed", "true");
});

test("the Step toolbar button toggles a heading on/off and renders it larger", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates: [] });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "Write in prose" }).click();

  const editor = page.getByRole("textbox", { name: "Routine", exact: true });
  await editor.click();
  await editor.pressSequentially("First step title");
  await page.keyboard.press("Enter");
  await editor.pressSequentially("Plain body line");

  const step = page.getByRole("button", { name: "Step", exact: true });
  // Caret is on the body line → Step shows as off.
  await expect(step).toHaveAttribute("aria-pressed", "false");

  // Put the caret on the first line and turn it into a step heading.
  await editor.locator("p", { hasText: "First step title" }).click();
  await step.click();
  await expect(step).toHaveAttribute("aria-pressed", "true");
  const heading = editor.locator("h1", { hasText: "First step title" });
  await expect(heading).toBeVisible();
  // The active toggle must be visibly filled, not just aria-pressed — a transparent
  // background here is the exact bug the user reported ("toggle should be highlighted").
  const activeBg = await step.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(activeBg).not.toBe("rgba(0, 0, 0, 0)");
  expect(activeBg).not.toBe("transparent");

  // The heading must read as a heading: visibly larger than body text.
  const headingSize = await heading.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const bodySize = await editor
    .locator("p", { hasText: "Plain body line" })
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(headingSize).toBeGreaterThan(bodySize);

  // Toggling Step again converts the heading back to normal text.
  await heading.click();
  await expect(step).toHaveAttribute("aria-pressed", "true");
  await step.click();
  await expect(step).toHaveAttribute("aria-pressed", "false");
  await expect(editor.locator("h1")).toHaveCount(0);
});

test("a handoff chip on its own line compiles a forking routine", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "Write in prose" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Refund with handoff");
  await page.getByLabel("Trigger", { exact: true }).fill("When a customer wants a refund");

  const editor = page.getByRole("textbox", { name: "Routine", exact: true });
  await editor.click();
  await editor.pressSequentially("Ask for the order id.");
  await page.keyboard.press("Enter");
  // A line carrying a handoff chip is a branch; the prose before it is the condition.
  await editor.pressSequentially("If they refuse to verify, ");
  await editor.pressSequentially("@human");
  await expect(page.getByRole("option", { name: "Handoff: human" })).toBeVisible();
  await page.getByRole("option", { name: "Handoff: human" }).click();
  await expect(page.locator('[data-routine-chip="handoff"]')).toBeVisible();
  await page.keyboard.press("Enter");
  await editor.pressSequentially("Confirm and finish.");

  await page.getByRole("button", { name: "Save routine" }).click();

  await expect.poll(() => routineUpdates.filter((update) => update.method === "POST").length).toBeGreaterThan(0);
  const created = routineUpdates.find((update) => update.method === "POST");
  const terminals = created?.body?.terminals ?? [];
  expect(terminals.some((terminal: { kind: string }) => terminal.kind === "handoff")).toBe(true);
  const transitions = created?.body?.transitions ?? [];
  expect(transitions.some((transition: { guardKind: string; toRef: string }) => transition.guardKind === "llm" && transition.toRef === "handoff")).toBe(true);
});

test("a condition chip compiles a decided-in-code (field) branch", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "Write in prose" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Refund eligibility");
  await page.getByLabel("Trigger", { exact: true }).fill("When a customer wants a refund");

  const editor = page.getByRole("textbox", { name: "Routine", exact: true });
  await editor.click();
  await editor.pressSequentially("Look up the ");
  await editor.pressSequentially("@status");
  await expect(page.getByRole("option", { name: /Create variable/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // new line for the branch

  // Add a handoff target on the branch line.
  await page.keyboard.type("@human");
  await expect(page.getByRole("option", { name: "Handoff: human" })).toBeVisible();
  await page.getByRole("option", { name: "Handoff: human" }).click();
  await expect(page.locator('[data-routine-chip="handoff"]')).toBeVisible();

  // Build a decided-in-code condition via the toolbar dialog.
  await page.getByRole("button", { name: "Condition" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Variable").selectOption({ label: "status" });
  await dialog.getByLabel("Check").selectOption("in");
  await dialog.getByLabel("Values (comma-separated)").fill("final_sale, void");
  await dialog.getByRole("button", { name: "Add check" }).click();
  await expect(page.locator('[data-routine-chip="condition"]')).toBeVisible();
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.screenshot({ path: "demo-screenshots/routine-decided-in-code-demo.png", fullPage: true });

  await page.getByRole("button", { name: "Save routine" }).click();

  await expect.poll(() => routineUpdates.filter((update) => update.method === "POST").length).toBeGreaterThan(0);
  const created = routineUpdates.find((update) => update.method === "POST");
  const transitions = created?.body?.transitions ?? [];
  const fieldBranch = transitions.find((transition: { guardKind: string; toRef: string }) => transition.toRef === "handoff");
  // The branch is decided in code (a field guard), not by the AI (llm).
  expect(fieldBranch).toMatchObject({ guardKind: "field", fieldRef: "status", fieldOp: "in", fieldValues: ["final_sale", "void"] });
});

test("an 'older than 6 months' check compiles a relative-date field guard", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "Write in prose" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Refund window");
  await page.getByLabel("Trigger", { exact: true }).fill("When a customer wants a refund");

  const editor = page.getByRole("textbox", { name: "Routine", exact: true });
  await editor.click();
  await editor.pressSequentially("Look up the ");
  await editor.pressSequentially("@orderdate");
  await expect(page.getByRole("option", { name: /Create variable/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // new branch line

  // Add a handoff target on the branch line.
  await page.keyboard.type("@human");
  await expect(page.getByRole("option", { name: "Handoff: human" })).toBeVisible();
  await page.getByRole("option", { name: "Handoff: human" }).click();

  // Make the variable a date so relative-date comparisons are offered.
  await page.locator('[data-routine-chip="variable"]').click();
  await page.getByRole("menuitemradio", { name: "date" }).click();

  // Build "order date is older than 6 months".
  await page.getByRole("button", { name: "Condition" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Variable").selectOption({ label: "orderdate" });
  await dialog.getByLabel("Check").selectOption("older_than");
  await dialog.getByLabel("Amount").fill("6");
  await dialog.getByLabel("Unit").selectOption("months");
  await dialog.getByRole("button", { name: "Add check" }).click();
  await expect(page.locator('[data-routine-chip="condition"]')).toBeVisible();
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.screenshot({ path: "demo-screenshots/routine-older-than-demo.png", fullPage: true });

  await page.getByRole("button", { name: "Save routine" }).click();

  await expect.poll(() => routineUpdates.filter((update) => update.method === "POST").length).toBeGreaterThan(0);
  const created = routineUpdates.find((update) => update.method === "POST");
  const branch = (created?.body?.transitions ?? []).find((transition: { toRef: string }) => transition.toRef === "handoff");
  expect(branch).toMatchObject({ guardKind: "field", fieldRef: "orderdate", fieldOp: "older_than", fieldValue: 6, fieldUnit: "months" });
});

test("the check dialog surfaces the variable's type so type-specific checks appear", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates: [] });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "Write in prose" }).click();

  const editor = page.getByRole("textbox", { name: "Routine", exact: true });
  await editor.click();
  await editor.pressSequentially("Look up the ");
  await editor.pressSequentially("@orderdate");
  await expect(page.getByRole("option", { name: /Create variable/ })).toBeVisible();
  await page.keyboard.press("Enter");

  await page.getByRole("button", { name: "Condition" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Variable").selectOption({ label: "orderdate" });

  // A text variable offers no relative-date comparison…
  await expect(dialog.getByLabel("Check").getByRole("option", { name: "is older than" })).toHaveCount(0);
  // …until the type is set to date right here in the check dialog (no chip hunt).
  await dialog.getByLabel("Type").selectOption("date");
  await expect(dialog.getByLabel("Check").getByRole("option", { name: "is older than" })).toHaveCount(1);
});

test("a name can't be claimed by a second chip kind", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates: [] });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "Write in prose" }).click();

  const editor = page.getByRole("textbox", { name: "Routine", exact: true });
  await editor.click();
  await editor.pressSequentially("Collect @refund");
  await expect(page.getByRole("option", { name: /Create variable/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-routine-chip="variable"]')).toBeVisible();

  // "refund" now names the variable, so the @ menu won't offer to create a
  // skill or handoff with the same name — only the existing variable.
  await editor.pressSequentially(" then @refund");
  await expect(page.getByRole("option", { name: "@refund" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Skill: refund" })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "Handoff: refund" })).toHaveCount(0);
});

test("a skill chip compiles to a tool step naming the skill", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "Write in prose" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Book a meeting");
  await page.getByLabel("Trigger", { exact: true }).fill("When a visitor wants to book a meeting");

  const editor = page.getByRole("textbox", { name: "Routine", exact: true });
  await editor.click();
  await editor.pressSequentially("Check availability ");
  // The skill is defined elsewhere; the routine references it by name with a skill chip.
  await editor.pressSequentially("@book_meeting");
  await expect(page.getByRole("option", { name: "Skill: book_meeting" })).toBeVisible();
  await page.getByRole("option", { name: "Skill: book_meeting" }).click();
  await expect(page.locator('[data-routine-chip="skill"]')).toBeVisible();

  await page.getByRole("button", { name: "Save routine" }).click();

  await expect.poll(() => routineUpdates.filter((update) => update.method === "POST").length).toBeGreaterThan(0);
  const created = routineUpdates.find((update) => update.method === "POST");
  const toolStep = (created?.body?.steps ?? []).find((step: { kind: string }) => step.kind === "tool");
  // The skill chip compiles to a tool step dispatched through the skill port at runtime.
  expect(toolStep).toMatchObject({ kind: "tool", toolRef: "book_meeting" });
});

test("a step jump loops back to an earlier titled step with a bounded counter", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "Write in prose" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Verify identity");
  await page.getByLabel("Trigger", { exact: true }).fill("When a caller must verify their identity");

  const editor = page.getByRole("textbox", { name: "Routine", exact: true });
  await editor.click();

  // Two titled steps (h1). The Step button names the current line so a jump can target it.
  await editor.pressSequentially("Ask for code");
  await page.getByRole("button", { name: "Step", exact: true }).click();
  await page.keyboard.press("Enter");
  await editor.pressSequentially("Check the code");
  await page.getByRole("button", { name: "Step", exact: true }).click();
  await page.keyboard.press("Enter");

  // A branch that loops back to the first step, capped at 3 — the cap is the counter guard.
  // (exact: the dev-build overlay button's label contains the branch name "088-jumps".)
  await page.getByRole("button", { name: "Jump", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Step").selectOption({ label: "Ask for code" });
  await dialog.getByRole("checkbox").check();
  await dialog.getByLabel("Max times").fill("3");
  await dialog.getByRole("button", { name: "Add jump" }).click();
  await expect(page.locator('[data-routine-chip="step"]')).toBeVisible();

  await page.getByRole("button", { name: "Save routine" }).click();

  await expect.poll(() => routineUpdates.filter((update) => update.method === "POST").length).toBeGreaterThan(0);
  const created = routineUpdates.find((update) => update.method === "POST");
  // Each titled step carries a stable, slug-derived id.
  const stepIds = (created?.body?.steps ?? []).map((step: { stableStepId: string }) => step.stableStepId);
  expect(stepIds).toEqual(["ask_for_code", "check_the_code"]);
  // The backward jump compiles to a counter-guarded loop edge the backend accepts.
  const loop = (created?.body?.transitions ?? []).find(
    (transition: { toRef: string; guardKind: string }) => transition.toRef === "ask_for_code" && transition.guardKind === "counter",
  );
  expect(loop).toMatchObject({ fromStep: "check_the_code", toRef: "ask_for_code", guardKind: "counter", counterLimit: 3 });
});

test("an end chip completes the routine on a decided-in-code branch", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "Write in prose" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Refund check");
  await page.getByLabel("Trigger", { exact: true }).fill("When a customer wants a refund");

  const editor = page.getByRole("textbox", { name: "Routine", exact: true });
  await editor.click();
  await editor.pressSequentially("Look up the ");
  await editor.pressSequentially("@status");
  await expect(page.getByRole("option", { name: /Create variable/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // a branch line

  // Mark this branch as ending (completing) the routine via the toolbar.
  await page.getByRole("button", { name: "End" }).click();
  await expect(page.locator('[data-routine-chip="end"]')).toBeVisible();

  // Decide the branch in code.
  await page.getByRole("button", { name: "Condition" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Variable").selectOption({ label: "status" });
  await dialog.getByLabel("Check").selectOption("equals");
  await dialog.getByLabel("Value").fill("refunded");
  await dialog.getByRole("button", { name: "Add check" }).click();
  await expect(page.locator('[data-routine-chip="condition"]')).toBeVisible();

  await page.getByRole("button", { name: "Save routine" }).click();

  await expect.poll(() => routineUpdates.filter((update) => update.method === "POST").length).toBeGreaterThan(0);
  const created = routineUpdates.find((update) => update.method === "POST");
  const completeId = (created?.body?.terminals ?? []).find((terminal: { kind: string }) => terminal.kind === "complete")?.stableStepId;
  const endBranch = (created?.body?.transitions ?? []).find((transition: { guardKind: string }) => transition.guardKind === "field");
  // The end branch is a decided-in-code transition to the complete terminal.
  expect(endBranch).toMatchObject({ toRef: completeId, guardKind: "field", fieldRef: "status", fieldOp: "equals" });
});
