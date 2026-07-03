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
  await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Form" }).click();
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

  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/55555555-5555-4555-8555-000000000001$`));
  await expect(page.getByText("Validation passed")).toBeVisible();
  await expect.poll(() => routineUpdates.some((update) => update.method === "VALIDATE")).toBe(true);

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

test("an existing routine opens in prose (outline retired) and toggles to form", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    routineUpdates: [],
    routines: [{ ...baseRoutine, id: "55555555-5555-4555-9555-000000000301", status: "draft", version: 1 }],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "Edit draft Collect pricing intake" }).click();

  // Outline is retired; a prose-representable routine opens in the Prose tab.
  await expect(page.getByRole("tab", { name: "Outline" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Prose" })).toHaveAttribute("data-state", "active");

  // The routine's chat step loaded as inline prose with its variable as a chip.
  const editor = page.getByRole("textbox", { name: "Routine", exact: true });
  await expect(editor).toContainText("Ask for");
  await expect(editor).toContainText("so the team can follow up");
  await expect(page.locator('[data-routine-chip="variable"]')).toBeVisible();

  // Toggling to the Form tab preserves the step instruction.
  await page.getByRole("tab", { name: "Form" }).click();
  await expect(page.getByLabel("Step 1 instruction")).toHaveValue("Ask for {{slot.email}} so the team can follow up.");
});

test("a routine with custom completion copy opens in Prose with terminal copy preserved", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    routineUpdates: [],
    routines: [{
      ...baseRoutine,
      id: "55555555-5555-4555-9555-000000000302",
      status: "draft",
      version: 1,
      // A custom completion message the prose editor can't show — must edit in Form so it
      // isn't silently overwritten on load+save.
      terminals: [{ stableStepId: "done", kind: "complete", instruction: "Thanks, we will be in touch.", ordinal: 0 }],
    }],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "Edit draft Collect pricing intake" }).click();

  await expect(page.getByRole("tab", { name: "Prose" })).toHaveAttribute("data-state", "active");
  await expect(page.getByLabel("Completion message")).toHaveValue("Thanks, we will be in touch.");
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
  await expect(page.getByText("draft v2", { exact: true })).toBeVisible();
  await expect.poll(() => routineUpdates.some((update) => update.method === "REVISE")).toBe(true);

  await clickBackToRoutines(page);
  await expect(page.getByText("Collect pricing intake")).toHaveCount(1);
  await expect(page.getByText("draft revision")).toBeVisible();

  await page.getByRole("button", { name: "Edit Collect pricing intake" }).click();
  await page.getByLabel("Activation trigger").fill("Visitor asks about pricing, quotes, or plans.");
  await page.getByRole("button", { name: "Publish", exact: true }).click();

  await expect(page.getByText("published v2 (read-only)", { exact: true })).toBeVisible();
  const versionHistory = page.getByText("Version history").locator("..");
  await expect(versionHistory.getByRole("button", { name: /v1/ })).toContainText("superseded");
  await expect(versionHistory.getByRole("button", { name: /v2/ })).toContainText("published");
  await expect.poll(() => routineUpdates.some((update) => update.method === "PUBLISH")).toBe(true);
  const revisionSave = routineUpdates.find((update) => update.method === "PATCH");
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

  await page.getByRole("button", { name: "Archive", exact: true }).click();
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
  await expect(page.getByRole("button", { name: "Delete draft Collect pricing intake" })).toBeVisible();
  await expect.poll(() => routineUpdates.some((update) => update.method === "REVISE")).toBe(true);

  await Promise.all([
    page.waitForURL(routinesListUrl),
    page.getByRole("button", { name: "Archive routine" }).click(),
  ]);
  await expect.poll(() => routineUpdates.some((update) => update.method === "ARCHIVE")).toBe(true);

  await expect(page.getByText("draft revision")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Collect pricing intake published/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Archived routines (1)" }).click();
  await expect(page.getByText("Collect pricing intake")).toBeVisible();
});
