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
  await page.getByRole("tab", { name: "Form" }).click();
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
});

test("agent routines outline editor preserves data across form toggle and maps validation inline", async ({ page }) => {
  const routineUpdates: Array<{ method: "POST" | "PATCH" | "DELETE" | "VALIDATE" | "PUBLISH"; routineId?: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "New routine" }).click();

  await expect(page.getByRole("tab", { name: "Outline" })).toHaveAttribute("data-state", "active");
  await expect(page.getByLabel("Step 1 kind")).toHaveCount(0);
  await expect(page.getByLabel("Transition 1 guard")).toHaveCount(0);
  await expect(page.getByLabel("Terminal 1 kind")).toHaveCount(0);

  await page.getByLabel("Name").fill("Order support");
  await page.getByLabel("Priority").fill("15");
  await page.getByLabel("Activation trigger").fill("Visitor asks about an order.");

  await page.getByRole("button", { name: "Add variable" }).click();
  await page.getByLabel("Variable 1 key").fill("email");
  await page.getByLabel("Variable 1 type").click();
  await page.getByRole("option", { name: "email" }).click();
  await page.getByLabel("Variable 1 description").fill("Visitor email");
  await page.getByRole("button", { name: "Add variable" }).click();
  await page.getByLabel("Variable 2 key").fill("order_id");
  await page.getByLabel("Variable 2 description").fill("Order number");

  await page.getByLabel("Outline step 1 label").fill("collect_email");
  await page.getByLabel("Outline step 1 instruction").fill("Ask for @email and @order_id.");
  await page.getByRole("button", { name: "Add step" }).click();
  await page.getByLabel("Outline step 2 label").fill("send_contact");
  await page.getByLabel("Outline step 2 instruction").fill("Run ");
  await page.getByLabel("Insert action into outline step 2").click();
  await page.getByRole("option", { name: "Contact Send" }).click();
  await page.getByLabel("Outline step 2 instruction").fill("Run @Contact Send for @email and @order_id.");
  await page.getByRole("button", { name: "Add step" }).click();
  await page.getByLabel("Outline step 3 label").fill("confirm");
  await page.getByLabel("Outline step 3 instruction").fill("Tell them the order was found.");

  await page.getByLabel("End 1 label").fill("done");
  await page.getByLabel("End 1 message").fill("Confirm the request is complete.");
  await page.getByRole("button", { name: "Add end" }).click();
  await page.getByLabel("End 2 label").fill("human_help");
  await page.getByLabel("End 2 message").fill("Hand the visitor to a person.");
  await page.locator("#endHandoff1").click();

  await page.getByRole("button", { name: "Add branch to outline step 1" }).click();
  await page.getByLabel("Outline step 1 branch 1 target").click();
  await page.getByRole("option", { name: "send_contact" }).click();
  await expect(page.getByLabel("Outline step 1 branch 1 outcome status")).toHaveCount(0);

  await page.getByRole("button", { name: "Add branch to outline step 2" }).click();
  await page.getByLabel("Outline step 2 branch 1 target").click();
  await page.getByRole("option", { name: "confirm" }).click();
  await expect(page.getByLabel("Outline step 2 branch 1 outcome status")).toBeVisible();
  await page.getByRole("button", { name: "Add branch to outline step 2" }).click();
  await page.getByLabel("Outline step 2 branch 2 condition").fill("The contact action should be retried");
  await page.getByLabel("Outline step 2 branch 2 target").click();
  await page.getByRole("option", { name: "collect_email" }).click();
  await page.getByLabel("Outline step 2 branch 2 counter limit").fill("2");
  await page.getByRole("button", { name: "Add branch to outline step 2" }).click();
  await page.getByLabel("Outline step 2 branch 3 target").click();
  await page.getByRole("option", { name: "human_help handoff" }).click();

  await page.getByRole("button", { name: "Add branch to outline step 3" }).click();
  await page.getByLabel("Outline step 3 branch 1 target").click();
  await page.getByRole("option", { name: "done" }).click();

  await page.getByRole("button", { name: "Remove end human_help" }).click();
  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.getByText('dangling step reference: transition "send_contact" points at "human_help".')).toBeVisible();

  await page.getByRole("button", { name: "Add end" }).click();
  await page.getByLabel("End 2 label").fill("human_help");
  await page.getByLabel("End 2 message").fill("Hand the visitor to a person.");
  await page.locator("#endHandoff1").click();

  await page.getByRole("tab", { name: "Form" }).click();
  await expect(page.getByLabel("Step 2 action type")).toHaveValue("contact.send");
  await expect(page.getByLabel("Transition 2 counter limit")).toHaveValue("2");
  await expect(page.getByLabel("Terminal 2 kind")).toHaveText("handoff");

  await page.getByRole("tab", { name: "Outline" }).click();
  await expect(page.getByLabel("Outline step 2 instruction")).toHaveValue("Run @Contact Send for @email and @order_id.");
  await expect(page.getByLabel("Outline step 2 branch 2 counter limit")).toHaveValue("2");
  await expect(page.getByLabel("End 2 message")).toHaveValue("Hand the visitor to a person.");

  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.getByText("Validation passed")).toBeVisible();

  const latestSave = [...routineUpdates].reverse().find((update) => update.method === "PATCH" || update.method === "POST");
  expect(latestSave).toMatchObject({
    body: {
      name: "Order support",
      steps: [
        expect.objectContaining({ stableStepId: "collect_email", kind: "chat" }),
        expect.objectContaining({ stableStepId: "send_contact", kind: "action", actionType: "contact.send" }),
        expect.objectContaining({ stableStepId: "confirm", kind: "chat" }),
      ],
      transitions: expect.arrayContaining([
        expect.objectContaining({ fromStep: "send_contact", toRef: "confirm", guardKind: "default" }),
        expect.objectContaining({ fromStep: "send_contact", toRef: "collect_email", guardKind: "counter", counterLimit: 2 }),
        expect.objectContaining({ fromStep: "send_contact", toRef: "human_help", guardKind: "default" }),
      ]),
      terminals: expect.arrayContaining([
        expect.objectContaining({ stableStepId: "human_help", kind: "handoff" }),
      ]),
    },
  });
});

test("agent routines outline editor loads drafting assist proposal for review before save", async ({ page }) => {
  const routineUpdates: Array<{ method: "POST" | "PATCH" | "DELETE" | "VALIDATE" | "PUBLISH" | "ASSIST"; routineId?: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "New routine" }).click();

  await page.getByRole("button", { name: "Draft from procedure" }).click();
  await page.getByLabel("Procedure text for routine drafting assist").fill("Ask for an email, send a contact request, then confirm the request is open.");
  await page.getByRole("button", { name: "Load proposal" }).click();

  await expect(page.getByLabel("Name")).toHaveValue("assisted-contact");
  await expect(page.getByLabel("Activation trigger")).toHaveValue("Visitor asks for a person to follow up.");
  await expect(page.getByLabel("Variable 1 key")).toHaveValue("email");
  await expect(page.getByLabel("Outline step 1 label")).toHaveValue("Collect email");
  await expect(page.getByLabel("Outline step 1 instruction")).toHaveValue("Ask for @email.");
  await expect(page.getByLabel("Outline step 2 label")).toHaveValue("Send contact request");
  await expect(page.getByLabel("Outline step 2 instruction")).toHaveValue("Send the contact request. @Contact Send");
  await expect(page.getByText("Validation passed")).toBeVisible();

  expect(routineUpdates.map((update) => update.method)).toEqual(["ASSIST"]);

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("draft", { exact: true })).toBeVisible();

  const createUpdate = routineUpdates.find((update) => update.method === "POST");
  expect(createUpdate).toMatchObject({
    body: {
      name: "assisted-contact",
      steps: [
        expect.objectContaining({ stableStepId: "collect_email", kind: "chat" }),
        expect.objectContaining({ stableStepId: "send_contact", kind: "action", actionType: "contact.send" }),
      ],
      transitions: [
        expect.objectContaining({ fromStep: "collect_email", toRef: "send_contact", guardKind: "default" }),
        expect.objectContaining({ fromStep: "send_contact", toRef: "done", guardKind: "default" }),
      ],
    },
  });
});
