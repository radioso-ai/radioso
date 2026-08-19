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

const baseRoutine: Omit<RoutineFixture, "id" | "status" | "version"> = {
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

const clickBackToRoutines = async (page: Page) => {
  await Promise.all([
    page.waitForURL(routinesListUrl),
    page.getByRole("button", { name: "Back to routines" }).click(),
  ]);
};

test("agent routines settings create, validate, publish, and persist", async ({ page }) => {
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
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
  await expect(page.getByRole("tab", { name: "Document" })).toHaveAttribute("data-state", "active");
  await page.getByRole("tab", { name: "Form" }).click();
  await expect(page.getByRole("tab", { name: "Form" })).toHaveAttribute("data-state", "active");
  await expect(page.getByLabel("Name")).toBeVisible();
  await page.getByLabel("Name").fill("Collect pricing intake");
  await page.getByLabel("Priority").fill("20");
  await page.getByLabel("Activation trigger").fill("Visitor asks about pricing or wants a quote.");

  await page.getByRole("button", { name: "Add slot" }).click();
  await page.getByLabel("Slot 1 key").fill("email");
  await page.getByLabel("Slot 1 type").click();
  await page.getByRole("option", { name: "email" }).click();
  await page.getByLabel("Slot 1 description").fill("Visitor email address");

  await page.getByLabel("Step 1 id").fill("ask_email");
  await page.getByLabel("Step 1 instruction").fill("Ask for ");
  await page.getByLabel("Insert variable into step 1").click();
  await page.getByRole("option", { name: "email" }).click();
  await expect(page.getByLabel("Step 1 instruction")).toHaveValue("Ask for {{slot.email}}");
  await page.getByLabel("Step 1 instruction").fill("Ask for {{slot.email}} so the team can follow up.");

  await page.getByRole("button", { name: "Add transition" }).click();
  await page.getByLabel("Transition 1 target").click();
  await page.getByRole("option", { name: "complete" }).click();
  await page.getByLabel("Transition 1 guard").click();
  await page.getByRole("option", { name: "default" }).click();
  await page.getByLabel("Terminal 1 id").fill("complete");
  await page.getByLabel("Terminal 1 instruction").fill("Confirm the request was captured.");

  await expect.poll(() => routineUpdates.some((update) => update.method === "POST"), { timeout: 15_000 }).toBe(true);
  await expect(page.getByRole("status", { name: "Routine valid" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeEnabled();
  expect(routineUpdates.some((update) => update.method === "VALIDATE")).toBe(false);

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/55555555-5555-4555-8555-000000000001$`));
  await expect(page.getByText("published v1 (read-only)", { exact: true })).toBeVisible();
  await expect.poll(() => routineUpdates.some((update) => update.method === "PUBLISH")).toBe(true);

  const createUpdate = routineUpdates.find((update) => update.method === "POST");
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
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeEnabled();

  await page.getByRole("tab", { name: "Form" }).click();
  await expect(page.getByLabel("Step 1 instruction")).toHaveValue("Ask for {{slot.email}}.");
  await expect(page.getByLabel("Step 2 action type")).toHaveValue("contact.send");

  expect(routineUpdates).toContainEqual({
    method: "ASSIST",
    body: {
      prose: "When the visitor asks for follow-up, collect @email and send the contact request.",
    },
  });
});

test("an existing routine opens in the Document view and toggles to form", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    routineUpdates: [],
    routines: [{ ...baseRoutine, id: "55555555-5555-4555-9555-000000000301", status: "draft", version: 1 }],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "Edit draft Collect pricing intake" }).click();

  // Prose and Outline are retired; a representable routine opens in the Document view.
  await expect(page.getByRole("tab", { name: "Outline" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Prose" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Document" })).toHaveAttribute("data-state", "active");

  // The routine's chat step reads as a sentence with its variable as a chip.
  const editor = page.getByRole("article", { name: "Routine document editor" });
  await expect(editor).toContainText("Ask for");
  await expect(editor).toContainText("so the team can follow up");

  // Toggling to the Form tab preserves the step instruction.
  await page.getByRole("tab", { name: "Form" }).click();
  await expect(page.getByLabel("Step 1 instruction")).toHaveValue("Ask for {{slot.email}} so the team can follow up.");
});

test("a routine with custom completion copy opens in Document with terminal copy preserved", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    routineUpdates: [],
    routines: [{
      ...baseRoutine,
      id: "55555555-5555-4555-9555-000000000302",
      status: "draft",
      version: 1,
      // A custom completion message; the Document view shows it as the routine's ending.
      terminals: [{ stableStepId: "done", kind: "complete", instruction: "Thanks, we will be in touch.", ordinal: 0 }],
    }],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "Edit draft Collect pricing intake" }).click();

  await expect(page.getByRole("tab", { name: "Document" })).toHaveAttribute("data-state", "active");
  await expect(page.getByRole("article", { name: "Routine document editor" })).toContainText("Thanks, we will be in touch.");
});

test("a published routine opens in the Document reader, not the structural form", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    routineUpdates: [],
    routines: [{
      ...baseRoutine,
      id: "55555555-5555-4555-9555-000000000401",
      status: "published",
      version: 1,
    }],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: /Collect pricing intake published v1/ }).click();

  // Reading a published routine is what the document's rest state is for, so a version that
  // can no longer be edited still opens there rather than dropping to the structural form.
  await expect(page.getByRole("tab", { name: "Document" })).toHaveAttribute("data-state", "active");

  // It renders as the reader: the routine reads as prose, with no editing affordances.
  const reader = page.getByRole("article", { name: "Routine document" });
  await expect(reader).toBeVisible();
  await expect(page.getByRole("article", { name: "Routine document editor" })).toHaveCount(0);
  await expect(reader).toContainText("Ask for");
  await expect(reader).toContainText("so the team can follow up");
});

test("agent routines revise and publish a new version without duplicating the lineage row", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    routineUpdates,
    routines: [{
      ...baseRoutine,
      id: "55555555-5555-4555-9555-000000000101",
      status: "published",
      version: 1,
    }],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  const routineRow = page.getByRole("button", { name: /Collect pricing intake published v1/ });
  await expect(routineRow).toBeVisible();

  await page.getByRole("button", { name: "Edit Collect pricing intake" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/55555555-5555-4555-8555-000000000001$`));
  await expect(page.getByRole("heading", { name: "Routine", level: 1 })).toBeVisible();
  await expect(page.getByText("Collect pricing intake", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("draft v2", { exact: true })).toBeVisible();
  await expect.poll(() => routineUpdates.some((update) => update.method === "REVISE")).toBe(true);

  await clickBackToRoutines(page);
  await expect(page.getByText("Collect pricing intake")).toHaveCount(1);
  await expect(page.getByText("draft revision")).toBeVisible();

  await page.getByRole("button", { name: "Edit Collect pricing intake" }).click();
  // Document mode owns the trigger; edit it through the Starts when row.
  const revisionEditor = page.getByRole("article", { name: "Routine document editor" });
  await expect(revisionEditor).toContainText("Visitor asks about pricing or wants a quote.");
  await revisionEditor.getByRole("button", { name: "Starts when", exact: true }).click();
  await revisionEditor.getByLabel("Activation trigger", { exact: true }).fill("Visitor asks about pricing, quotes, or plans.");
  await revisionEditor.getByRole("button", { name: "Done", exact: true }).click();
  await expect.poll(() => routineUpdates.some((update) => {
    const body = update.body as { activation?: { triggerDescription?: string } } | undefined;
    return update.method === "PATCH" && body?.activation?.triggerDescription === "Visitor asks about pricing, quotes, or plans.";
  }), { timeout: 15_000 }).toBe(true);
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Publish", exact: true }).click();

  await expect(page.getByText("published v2 (read-only)", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "More routine actions" }).click();
  await page.getByRole("menuitem", { name: "Version history" }).click();
  const versionHistory = page.getByRole("dialog", { name: "Version history" });
  await expect(versionHistory).toContainText("v1");
  await expect(versionHistory).toContainText("superseded");
  await expect(versionHistory).toContainText("v2");
  await expect(versionHistory).toContainText("published");
  await page.keyboard.press("Escape");
  await expect(versionHistory).toBeHidden();
  await expect.poll(() => routineUpdates.some((update) => update.method === "PUBLISH")).toBe(true);
  const revisionSave = routineUpdates.find((update) => {
    const body = update.body as { activation?: { triggerDescription?: string } } | undefined;
    return update.method === "PATCH" && body?.activation?.triggerDescription === "Visitor asks about pricing, quotes, or plans.";
  });
  expect(revisionSave).toMatchObject({
    body: {
      activation: {
        triggerDescription: "Visitor asks about pricing, quotes, or plans.",
      },
    },
  });

  await clickBackToRoutines(page);
  await expect(page.getByText("Collect pricing intake")).toHaveCount(1);
  await expect(page.getByText("draft revision")).toHaveCount(0);
  await expect(page.getByText("v2", { exact: true })).toBeVisible();
});

test("agent routines archive and restore from the collapsed archived section", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    routineUpdates,
    routines: [{
      ...baseRoutine,
      id: "55555555-5555-4555-9555-000000000201",
      status: "published",
      version: 2,
    }],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/55555555-5555-4555-9555-000000000201`);
  await expect(page.getByText("published v2 (read-only)", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "More routine actions" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(page.getByText("archived v2 (read-only)", { exact: true })).toBeVisible();
  await expect.poll(() => routineUpdates.some((update) => update.method === "ARCHIVE")).toBe(true);

  await clickBackToRoutines(page);
  await expect(page.getByText("Collect pricing intake")).toBeHidden();
  await page.getByRole("button", { name: "Archived routines (1)" }).click();
  await expect(page.getByText("Collect pricing intake")).toBeVisible();

  await page.getByRole("button", { name: "Restore Collect pricing intake" }).click();
  await expect.poll(() => routineUpdates.some((update) => update.method === "RESTORE")).toBe(true);
  await expect(page.getByText("Collect pricing intake")).toBeVisible();
  await expect(page.getByText("published")).toBeVisible();
});

test("agent routines archive directly from the list without opening the editor", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    routineUpdates,
    routines: [{
      ...baseRoutine,
      id: "55555555-5555-4555-9555-000000000401",
      status: "published",
      version: 1,
    }],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await expect(page.getByRole("button", { name: /Collect pricing intake published v1/ })).toBeVisible();

  await page.getByRole("button", { name: "Archive Collect pricing intake" }).click();
  await expect.poll(() => routineUpdates.some((update) => update.method === "ARCHIVE")).toBe(true);

  await expect(page.getByRole("button", { name: /Collect pricing intake published/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Archived routines (1)" }).click();
  await expect(page.getByText("Collect pricing intake")).toBeVisible();
});

test("agent routines archive from a revision draft without publishing first", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    routineUpdates,
    routines: [{
      ...baseRoutine,
      id: "55555555-5555-4555-9555-000000000501",
      status: "published",
      version: 1,
    }],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "Edit Collect pricing intake" }).click();
  await expect(page.getByText("draft v2", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
  await page.getByRole("button", { name: "More routine actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Delete draft" })).toBeVisible();
  await expect.poll(() => routineUpdates.some((update) => update.method === "REVISE")).toBe(true);

  await Promise.all([
    page.waitForURL(routinesListUrl),
    page.getByRole("menuitem", { name: "Archive" }).click(),
  ]);
  await expect.poll(() => routineUpdates.some((update) => update.method === "ARCHIVE")).toBe(true);

  await expect(page.getByText("draft revision")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Collect pricing intake published/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Archived routines (1)" }).click();
  await expect(page.getByText("Collect pricing intake")).toBeVisible();
});

test("agent routine draft delete requires confirmation", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    routineUpdates,
    routines: [{
      ...baseRoutine,
      id: "55555555-5555-4555-9555-000000000601",
      status: "draft",
      version: 1,
    }],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/55555555-5555-4555-9555-000000000601`);
  await expect(page.getByText("draft v1", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "More routine actions" }).click();
  await page.getByRole("menuitem", { name: "Delete draft" }).click();
  await expect(page.getByRole("alertdialog", { name: "Delete draft?" })).toBeVisible();
  await expect.poll(() => routineUpdates.some((update) => update.method === "DELETE")).toBe(false);

  await Promise.all([
    page.waitForURL(routinesListUrl),
    page.getByRole("alertdialog", { name: "Delete draft?" }).getByRole("button", { name: "Delete draft" }).click(),
  ]);
  await expect.poll(() => routineUpdates.some((update) => update.method === "DELETE")).toBe(true);
  await expect(page.getByText("Collect pricing intake")).toHaveCount(0);
});
