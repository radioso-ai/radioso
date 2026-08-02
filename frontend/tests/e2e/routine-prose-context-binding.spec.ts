import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  type RoutineFixture,
  type RoutineMutationFixture,
  workspaceKey,
} from "./dashboard-fixtures";

type SavedRoutineBody = {
  steps?: Array<{
    stableStepId: string;
    metadata?: {
      inputBindings?: Record<string, unknown>;
    };
  }>;
};

const contextBoundStepMetadata = {
  // Titled steps retain their stable ids across a prose round trip.
  outlineLabel: "Lookup locale",
  inputBindings: {
    locale: { kind: "contextVariableRef" as const, contextVariable: "page_locale" },
  },
  outputAssignments: {},
  mode: "typed" as const,
} satisfies NonNullable<RoutineFixture["steps"][number]["metadata"]> & { outlineLabel: string };

const contextBoundRoutine: RoutineFixture = {
  id: "55555555-5555-4555-9555-000000000701",
  lineageId: "77777777-7777-4777-8777-000000000701",
  agentId: defaultAgentId,
  name: "Use page context",
  activation: {
    triggerDescription: "Visitor asks for localized help.",
    gateRef: null,
    priority: 10,
    reentryMode: "once_per_conversation",
  },
  slots: [],
  steps: [{
    stableStepId: "lookup_locale",
    kind: "tool",
    instruction: "Use the current page locale.",
    toolRef: "web.lookup_locale",
    actionType: null,
    ordinal: 0,
    metadata: contextBoundStepMetadata,
  }],
  transitions: [{
    fromStep: "lookup_locale",
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
    instruction: null,
    ordinal: 0,
  }],
  status: "draft",
  version: 1,
  createdAt: nowIso,
  updatedAt: nowIso,
};

test("saving an unrelated prose edit preserves context variable skill bindings", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    routineUpdates,
    routines: [contextBoundRoutine],
    // The popover renders binding rows against the skill's declared input ports;
    // without this catalog entry the ctx binding has no row to appear in.
    routineSkillCatalog: [
      {
        skillName: "web.lookup_locale",
        displayName: "Lookup locale",
        category: "external_mcp",
        inputs: [{ key: "locale", type: "text", required: true }],
        outcomes: [],
        hasDataOutputs: false,
      },
    ],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/${contextBoundRoutine.id}`);
  await expect(page.getByRole("tab", { name: "Prose" })).toHaveAttribute("data-state", "active");
  await expect(page.locator('[data-routine-chip="skill"]')).toBeVisible();

  await page.locator('[data-routine-chip="skill"]').click();
  await expect(page.getByText("ctx.page_locale")).toBeVisible();

  await page.getByLabel("Completion message").fill("Localized answer finished.");

  await expect.poll(
    () => routineUpdates.filter((update) => update.method === "PATCH").length,
    { timeout: 15_000 },
  ).toBeGreaterThan(0);

  const saved = routineUpdates.find((update) => update.method === "PATCH" && update.routineId === contextBoundRoutine.id);
  const savedBody = saved?.body as SavedRoutineBody | undefined;
  const toolStep = (savedBody?.steps ?? []).find((step) => step.stableStepId === "lookup_locale");
  expect(toolStep?.metadata?.inputBindings?.locale).toEqual({
    kind: "contextVariableRef",
    contextVariable: "page_locale",
  });
});
