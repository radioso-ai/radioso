import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

test("agent routines settings create, validate, publish, and persist", async ({ page }) => {
  const routineUpdates: Array<{ method: "POST" | "PATCH" | "DELETE" | "VALIDATE" | "PUBLISH"; routineId?: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);

  await expect(page.getByRole("heading", { name: "Routines", level: 1 })).toBeVisible();
  await expect(page.getByText("No routines yet.")).toBeVisible();

  await page.getByRole("button", { name: "New routine" }).click();
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
  await page.getByLabel("Insert variable").click();
  await page.getByRole("option", { name: "email" }).click();
  await expect(page.getByLabel("Step 1 instruction")).toHaveValue("Ask for {{slot.email}}");
  await page.getByLabel("Step 1 instruction").fill("Ask for {{slot.email}} so the team can follow up.");

  await page.getByRole("button", { name: "Add transition" }).click();
  await page.getByLabel("Transition 1 target").click();
  await page.getByRole("option", { name: "complete" }).click();
  await page.getByLabel("Transition 1 guard").click();
  await page.getByRole("option", { name: "always" }).click();
  await page.getByLabel("Terminal 1 id").fill("complete");
  await page.getByLabel("Terminal 1 instruction").fill("Confirm the request was captured.");

  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.getByText("Validation passed")).toBeVisible();
  await expect.poll(() => routineUpdates.some((update) => update.method === "VALIDATE")).toBe(true);

  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText("published", { exact: true })).toBeVisible();
  await expect(page.getByText("v2", { exact: true })).toBeVisible();
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
        guardKind: "always",
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
});
