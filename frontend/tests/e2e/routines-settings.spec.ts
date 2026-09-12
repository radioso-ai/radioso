import { expect, test, type Page } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  type RoutineFixture,
  type RoutineMutationFixture,
  workspaceKey,
} from "./dashboard-fixtures";

const baseRoutine: Omit<RoutineFixture, "id" | "enabled" | "version"> = {
  lineageId: "77777777-7777-4777-8777-000000000001",
  agentId: defaultAgentId,
  name: "Collect pricing intake",
  activation: {
    triggerDescription: "Visitor asks about pricing or wants a quote.",
    gateRef: null,
    priority: 20,
    reentryMode: "once_per_conversation",
  },
  slots: [{
    stableSlotId: "email",
    key: "email",
    type: "email",
    required: true,
    description: "Visitor email address",
    ordinal: 0,
  }],
  steps: [{
    stableStepId: "ask_email",
    kind: "chat",
    instruction: "Ask for {{slot.email}} so the team can follow up.",
    toolRef: null,
    actionType: null,
    ordinal: 0,
    metadata: {},
  }],
  transitions: [{
    fromStep: "ask_email",
    toRef: "done",
    guardKind: "default",
    guardText: null,
    outcomeStatus: null,
    counterLimit: null,
    ordinal: 0,
  }],
  terminals: [{
    stableStepId: "done",
    kind: "complete",
    instruction: "All set.",
    ordinal: 0,
  }],
  createdAt: nowIso,
  updatedAt: nowIso,
};

const routinesListUrl = new RegExp(`/w/${workspaceKey}/agents/${defaultAgentId}\\?tab=behavior&anchor=assistant-routines$`);

// A routine row is one button carrying the name and its trigger; the row's own controls are
// labelled by verb, so anchoring on the leading name keeps this off the delete button.
const routineRow = (page: Page, name: string) =>
  page.getByRole("button", { name: new RegExp(`^${name}\\b`) });

const clickBackToRoutines = async (page: Page) => {
  await Promise.all([
    page.waitForURL(routinesListUrl),
    page.getByRole("button", { name: "Back to routines" }).click(),
  ]);
};

test("routine coverage criteria round-trip through the authored API payload", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];
  const routine = {
    ...baseRoutine,
    id: "55555555-5555-4555-9555-000000000114",
    enabled: true,
    version: 1,
    activation: {
      ...baseRoutine.activation,
      coverageCriteria: {
        coverage: ["unanswered" as const],
        reasons: ["insufficient_evidence" as const],
      },
    },
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates, routines: [routine] });
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/${routine.id}`);

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await documentEditor.getByRole("button", { name: "Starts when", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add condition" })).toHaveCount(0);
  await expect(page.getByLabel("Answer coverage condition")).toContainText("Only if");
  await expect(page.getByRole("checkbox", { name: "unanswered" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("checkbox", { name: "insufficient evidence" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("checkbox", { name: "partial" }).click();
  await page.getByRole("checkbox", { name: "unanswered" }).click();
  const insufficient = page.getByRole("checkbox", { name: "insufficient evidence", exact: true });
  const sufficient = page.getByRole("checkbox", { name: "sufficient evidence", exact: true });
  await page.getByRole("checkbox", { name: "answered", exact: true }).click();
  await page.getByRole("checkbox", { name: "partial", exact: true }).click();
  await expect(insufficient).toBeDisabled();
  await expect(insufficient).toHaveAttribute("aria-checked", "false");
  await expect(sufficient).toBeEnabled();
  await sufficient.click();
  await page.getByRole("checkbox", { name: "partial", exact: true }).click();
  await page.getByRole("checkbox", { name: "answered", exact: true }).click();
  await expect(sufficient).toBeDisabled();
  await expect(sufficient).toHaveAttribute("aria-checked", "false");
  await page.getByRole("checkbox", { name: "conflicting evidence", exact: true }).click();

  await expect.poll(() => routineUpdates.some((update) => update.method === "PATCH"), { timeout: 15_000 }).toBe(true);
  const update = routineUpdates.filter((entry) => entry.method === "PATCH").at(-1);
  expect(update).toMatchObject({
    body: {
      activation: {
        coverageCriteria: {
          coverage: ["partial"],
          reasons: ["conflicting_evidence"],
        },
      },
    },
  });

  await page.reload();
  await documentEditor.getByRole("button", { name: "Starts when", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "partial" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("checkbox", { name: "conflicting evidence" })).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: "Remove condition" }).click();
  await expect.poll(() => routineUpdates.filter((entry) => entry.method === "PATCH").at(-1)?.body?.activation?.coverageCriteria, { timeout: 15_000 }).toBeUndefined();
  await page.reload();
  await documentEditor.getByRole("button", { name: "Starts when", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add condition" })).toBeVisible();

  const updateCountBeforeAddingCondition = routineUpdates.filter((entry) => entry.method === "PATCH").length;
  await page.getByRole("button", { name: "Add condition" }).click();
  await page.getByRole("menuitem", { name: "Answer coverage" }).click();
  await expect(page.getByLabel("Answer coverage condition")).toBeVisible();
  await expect.poll(() => routineUpdates.filter((entry) => entry.method === "PATCH").length, { timeout: 1_000 }).toBe(updateCountBeforeAddingCondition);
  await page.getByRole("checkbox", { name: "unanswered" }).click();
  await page.getByRole("checkbox", { name: "insufficient evidence" }).click();
  await expect.poll(() => routineUpdates.filter((entry) => entry.method === "PATCH").at(-1)?.body, { timeout: 15_000 }).toMatchObject({
    activation: {
      coverageCriteria: {
        coverage: ["unanswered"],
        reasons: ["insufficient_evidence"],
      },
    },
  });
});

test("agent routines settings create, validate, and persist", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);

  await expect(page.getByRole("heading", { name: "Routines", level: 1 })).toBeVisible();
  await expect(page.getByText("No routines yet.")).toBeVisible();

  await Promise.all([
    page.waitForURL(new RegExp(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/new$`)),
    page.getByRole("button", { name: "New routine" }).click(),
  ]);
  await expect(page.getByRole("button", { name: "Back to routines" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Routine", level: 1 })).toBeVisible();
  await expect(page.getByText("New routine", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Validate" })).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Routine has validation issues" })).toBeVisible();
  await expect(page.getByText("Name is required.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Collect pricing intake");

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await documentEditor.getByRole("button", { name: "Starts when", exact: true }).click();
  await documentEditor.getByLabel("Activation trigger", { exact: true }).fill("Visitor asks about pricing or wants a quote.");
  await documentEditor.getByLabel("Priority", { exact: true }).fill("20");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  // A step with nothing written in it opens straight into its sentence, so the instruction
  // comes first and the step's other controls follow.
  await documentEditor.getByRole("button", { name: "Chat", exact: true }).click();
  const instruction = documentEditor.getByLabel("Step 1 instruction");
  await instruction.click();
  await instruction.pressSequentially("Ask for @email");
  await page.getByRole("option", { name: /Create variable “email”/ }).click();
  await instruction.pressSequentially("so the team can follow up.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await documentEditor.getByRole("button", { name: "Chat", exact: true }).click();
  await documentEditor.getByRole("button", { name: "Condition", exact: true }).click();
  await documentEditor.getByLabel("Rule kind").selectOption("default");
  await documentEditor.getByLabel("Branch target").selectOption("ending:complete");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await documentEditor.getByRole("button", { name: "Chat", exact: true }).click();
  await documentEditor.getByLabel("Step 1 id").fill("ask_email");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await documentEditor.getByRole("button", { name: "email", exact: true }).click();
  await documentEditor.getByLabel("Slot email type").selectOption("email");
  await documentEditor.getByLabel("Slot email description").fill("Visitor email address");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await documentEditor.getByRole("button", { name: "Finish ending", exact: true }).click();
  await documentEditor.getByLabel("complete message").fill("Confirm the request was captured.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await expect.poll(() => routineUpdates.some((update) => update.method === "POST"), { timeout: 15_000 }).toBe(true);
  await expect(page.getByRole("status", { name: "Routine valid" })).toBeVisible({ timeout: 15_000 });
  expect(routineUpdates.some((update) => update.method === "VALIDATE")).toBe(false);
  // Creating a routine lands it on its own URL without any further step from the author.
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/55555555-5555-4555-8555-000000000001$`));

  // Authoring in the document saves as it goes, so the shape to pin is the last state
  // written, not whichever partial draft the first autosave caught.
  const createUpdate = routineUpdates.filter((update) => update.body).at(-1);
  expect(createUpdate).toMatchObject({
    body: {
      name: "Collect pricing intake",
      activation: {
        triggerDescription: "Visitor asks about pricing or wants a quote.",
        priority: 20,
      },
      slots: [{
        stableSlotId: "email",
        key: "email",
        type: "email",
        required: true,
        description: "Visitor email address",
        ordinal: 0,
      }],
      steps: [{
        stableStepId: "ask_email",
        kind: "chat",
        instruction: "Ask for {{slot.email}} so the team can follow up.",
        toolRef: null,
        ordinal: 0,
        metadata: {},
      }],
      transitions: [{
        fromStep: "ask_email",
        toRef: "complete",
        guardKind: "default",
        guardText: null,
        outcomeStatus: null,
        counterLimit: null,
        ordinal: 0,
      }],
      terminals: [{
        stableStepId: "complete",
        kind: "complete",
        instruction: "Confirm the request was captured.",
        ordinal: 0,
      }],
    },
  });

  await clickBackToRoutines(page);
  await expect(page.getByText("Collect pricing intake")).toBeVisible();
});

test("new routine can be authored from an AI procedure draft", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);

  await Promise.all([
    page.waitForURL(new RegExp(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/new$`)),
    page.getByRole("button", { name: "New routine" }).click(),
  ]);

  await page.getByRole("button", { name: "More routine actions" }).click();
  await page.getByRole("menuitem", { name: "Draft with AI" }).click();
  await expect(page.getByRole("dialog", { name: "Draft with AI" })).toBeVisible();
  await page.getByLabel("Procedure text for routine drafting assist").fill("When the visitor asks for follow-up, collect @email and send the contact request.");
  await page.getByRole("button", { name: "Load proposal" }).click();

  await expect(page.getByRole("dialog", { name: "Draft with AI" })).toHaveCount(0);
  await expect(page.getByLabel("Name")).toHaveValue("assisted-contact");
  // Document mode owns the trigger; the document shows it under Starts when.
  await expect(page.getByRole("article", { name: "Routine document editor" })).toContainText("Visitor asks for a person to follow up.");
  await expect(page.getByRole("status", { name: "Routine valid" })).toBeVisible();

  const assistedDocument = page.getByRole("article", { name: "Routine document editor" });
  await expect(assistedDocument).toContainText("Ask for");
  await expect(assistedDocument).toContainText("Send the contact request");

  expect(routineUpdates).toContainEqual({
    method: "ASSIST",
    body: {
      prose: "When the visitor asks for follow-up, collect @email and send the contact request.",
    },
  });
});

test("an existing routine opens in the Document view", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    routineUpdates: [],
    routines: [{ ...baseRoutine, id: "55555555-5555-4555-9555-000000000301", enabled: true, version: 1 }],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await routineRow(page, "Collect pricing intake").click();

  // The routine's chat step reads as a sentence with its variable as a chip.
  const editor = page.getByRole("article", { name: "Routine document editor" });
  // The document is the only routine editor; no editor-local view switcher remains.
  await expect(editor.getByRole("tab")).toHaveCount(0);
  await expect(editor).toContainText("Ask for");
  await expect(editor).toContainText("so the team can follow up");

  // The variable reads as its name, not as the stored token.
  await expect(editor).toContainText("email");
  await expect(editor).not.toContainText("{{slot.email}}");
});

test("a routine with custom completion copy opens in Document with terminal copy preserved", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    routineUpdates: [],
    routines: [{
      ...baseRoutine,
      id: "55555555-5555-4555-9555-000000000302",
      enabled: true,
      version: 1,
      // A custom completion message; the Document view shows it as the routine's ending.
      terminals: [{ stableStepId: "done", kind: "complete", instruction: "Thanks, we will be in touch.", ordinal: 0 }],
    }],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await routineRow(page, "Collect pricing intake").click();

  await expect(page.getByRole("article", { name: "Routine document editor" })).toContainText("Thanks, we will be in touch.");
});

test("a step changes kind in place in the Document view", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    routineUpdates: [],
    routines: [{ ...baseRoutine, id: "55555555-5555-4555-9555-000000000501", enabled: true, version: 1 }],
    routineSkillCatalog: [{
      skillName: "orders.lookup",
      displayName: "Look up order",
      category: "external_mcp",
      inputs: [],
      outcomes: [],
      hasDataOutputs: false,
    }],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await routineRow(page, "Collect pricing intake").click();

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await documentEditor.getByRole("button", { name: "Chat", exact: true }).click();

  // A step that was written as a question becomes a skill call without being deleted and
  // rebuilt, so the instruction the author wrote survives the change.
  await documentEditor.getByLabel("Step 1 kind").selectOption("tool");
  await documentEditor.getByLabel("ask_email catalog item").selectOption("orders.lookup");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await expect(documentEditor).toContainText("Ask for");

  await documentEditor.getByRole("button", { name: "Look up order", exact: true }).click();
  await expect(documentEditor.getByLabel("Step 1 kind")).toHaveValue("tool");
});

test("a routine already shipped to customers is directly editable, and the edit autosaves", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    routineUpdates,
    // A routine that has been through Review & Publish. There is no revision step in front
    // of it: opening it lands straight in the editor.
    routines: [{
      ...baseRoutine,
      id: "55555555-5555-4555-9555-000000000101",
      enabled: true,
      version: 2,
    }],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await routineRow(page, "Collect pricing intake").click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/55555555-5555-4555-9555-000000000101$`));

  const editor = page.getByRole("article", { name: "Routine document editor" });
  await expect(editor).toContainText("Visitor asks about pricing or wants a quote.");
  await editor.getByRole("button", { name: "Starts when", exact: true }).click();
  await editor.getByLabel("Activation trigger", { exact: true }).fill("Visitor asks about pricing, quotes, or plans.");
  await editor.getByRole("button", { name: "Done", exact: true }).click();

  // The edit lands on the routine that was already published, in place, with no new version.
  await expect.poll(() => routineUpdates.filter((update) => update.method === "PATCH").at(-1), { timeout: 15_000 })
    .toMatchObject({
      routineId: "55555555-5555-4555-9555-000000000101",
      body: { activation: { triggerDescription: "Visitor asks about pricing, quotes, or plans." } },
    });

  await clickBackToRoutines(page);
  await expect(page.getByText("Collect pricing intake")).toHaveCount(1);
  await expect(page.getByText("Visitor asks about pricing, quotes, or plans.")).toBeVisible();
});

test("the routine list toggles a routine off and on through the update endpoint", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    routineUpdates,
    routines: [{
      ...baseRoutine,
      id: "55555555-5555-4555-9555-000000000201",
      enabled: true,
      version: 2,
    }],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  const toggle = page.getByRole("switch", { name: "Enable Collect pricing intake" });
  await expect(toggle).toBeChecked();

  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => routineUpdates.filter((update) => update.method === "PATCH").at(-1))
    .toMatchObject({ routineId: "55555555-5555-4555-9555-000000000201", body: { enabled: false } });

  // The row shows what the server stored, so it survives a reload rather than being a local flip.
  await page.reload();
  await expect(page.getByRole("switch", { name: "Enable Collect pricing intake" })).not.toBeChecked();

  await page.getByRole("switch", { name: "Enable Collect pricing intake" }).click();
  await expect.poll(() => routineUpdates.filter((update) => update.method === "PATCH").at(-1))
    .toMatchObject({ body: { enabled: true } });
  await expect(page.getByRole("switch", { name: "Enable Collect pricing intake" })).toBeChecked();
});

test("the editor disables its enablement switch until a delayed update settles, then rolls back a failure", async ({ page }) => {
  const routine = {
    ...baseRoutine,
    id: "55555555-5555-4555-9555-000000000211",
    enabled: true,
    version: 1,
  };
  let releaseSuccess!: () => void;
  const delayedSuccess = new Promise<void>((resolve) => { releaseSuccess = resolve; });

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routines: [routine] });
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}/routines/${routine.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await delayedSuccess;
    return route.fallback();
  });
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/${routine.id}`);

  const disable = page.getByRole("switch", { name: "Disable routine" });
  await disable.click();
  await expect(page.getByRole("switch", { name: "Enable routine" })).toBeDisabled();
  releaseSuccess();
  await expect(page.getByRole("switch", { name: "Enable routine" })).toBeEnabled();

  let releaseFailure!: () => void;
  const delayedFailure = new Promise<void>((resolve) => { releaseFailure = resolve; });
  await page.unroute(`**/backend/api/v1/agents/${defaultAgentId}/routines/${routine.id}`);
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}/routines/${routine.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await delayedFailure;
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "toggle failed" } }),
    });
  });

  await page.getByRole("switch", { name: "Enable routine" }).click();
  await expect(page.getByRole("switch", { name: "Disable routine" })).toBeDisabled();
  releaseFailure();
  await expect(page.getByRole("switch", { name: "Enable routine" })).not.toBeChecked();
  await expect(page.getByText("toggle failed", { exact: true })).toBeVisible();
});

test("an older routine toggle cannot clear a newer toggle after navigating away and back", async ({ page }) => {
  const first = {
    ...baseRoutine,
    id: "55555555-5555-4555-9555-000000000221",
    enabled: true,
    version: 1,
  };
  const second = {
    ...baseRoutine,
    id: "55555555-5555-4555-9555-000000000222",
    name: "Second routine",
    enabled: false,
    version: 1,
  };
  let releaseOriginal!: () => void;
  const originalToggle = new Promise<void>((resolve) => { releaseOriginal = resolve; });
  let releaseCurrent!: () => void;
  const currentToggle = new Promise<void>((resolve) => { releaseCurrent = resolve; });
  let requestCount = 0;

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routines: [first, second] });
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}/routines/${first.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    requestCount += 1;
    await (requestCount === 1 ? originalToggle : currentToggle);
    return route.fallback();
  });
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/${first.id}`);
  await page.getByRole("switch", { name: "Disable routine" }).click();
  await expect(page.getByRole("switch", { name: "Enable routine" })).toBeDisabled();

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/${second.id}`);
  await expect(page.getByRole("switch", { name: "Enable routine" })).not.toBeChecked();
  await expect(page.getByRole("switch", { name: "Enable routine" })).toBeEnabled();

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/${first.id}`);
  await page.getByRole("switch", { name: "Disable routine" }).click();
  await expect(page.getByRole("switch", { name: "Enable routine" })).toBeDisabled();

  releaseOriginal();
  // The old A request has settled, but the newer A request still owns this editor.
  await expect(page.getByRole("switch", { name: "Enable routine" })).toBeDisabled();
  releaseCurrent();
  await expect(page.getByRole("switch", { name: "Enable routine" })).toBeEnabled();
});

test("agent routine delete requires confirmation", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    routineUpdates,
    routines: [{
      ...baseRoutine,
      id: "55555555-5555-4555-9555-000000000601",
      enabled: true,
      version: 1,
    }],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/55555555-5555-4555-9555-000000000601`);
  await expect(page.getByRole("article", { name: "Routine document editor" })).toBeVisible();

  await page.getByRole("button", { name: "More routine actions" }).click();
  await page.getByRole("menuitem", { name: "Delete routine" }).click();
  await expect(page.getByRole("alertdialog", { name: "Delete routine?" })).toBeVisible();
  await expect.poll(() => routineUpdates.some((update) => update.method === "DELETE")).toBe(false);

  await Promise.all([
    page.waitForURL(routinesListUrl),
    page.getByRole("alertdialog", { name: "Delete routine?" }).getByRole("button", { name: "Delete routine" }).click(),
  ]);
  await expect.poll(() => routineUpdates.some((update) => update.method === "DELETE")).toBe(true);
  await expect(page.getByText("Collect pricing intake")).toHaveCount(0);
});
