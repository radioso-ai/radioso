import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  type RoutineFixture,
  workspaceKey,
} from "./dashboard-fixtures";

// A routine with one of each branch shape: a rule, a judgment the model makes, a plain
// onward path, and an escalation. The map has to tell those apart at a glance.
const mappedRoutine: RoutineFixture = {
  id: "55555555-5555-4555-9555-000000000901",
  lineageId: "77777777-7777-4777-8777-000000000901",
  agentId: defaultAgentId,
  name: "Order return request",
  status: "draft",
  version: 1,
  activation: {
    triggerDescription: "Visitor wants to return something they bought.",
    gateRef: null,
    priority: 60,
    reentryMode: "once_per_conversation",
  },
  slots: [
    { stableSlotId: "order_number", key: "order_number", type: "text", required: true, description: "Order number", ordinal: 0 },
    { stableSlotId: "email", key: "email", type: "email", required: true, description: "Visitor email", ordinal: 1 },
  ],
  steps: [
    { stableStepId: "ask_order", kind: "chat", instruction: "Ask for {{slot.order_number}} from the receipt.", toolRef: null, actionType: null, ordinal: 0, metadata: {} },
    { stableStepId: "ask_reason", kind: "chat", instruction: "Ask what is wrong with the item.", toolRef: null, actionType: null, ordinal: 1, metadata: {} },
  ],
  transitions: [
    { fromStep: "ask_order", toRef: "ask_reason", guardKind: "slot_filled", guardText: "{{slot.order_number}}", outcomeStatus: null, counterLimit: null, ordinal: 0 },
    { fromStep: "ask_order", toRef: "escalate", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 1 },
    { fromStep: "ask_reason", toRef: "done", guardKind: "llm", guardText: "the visitor described the problem", outcomeStatus: null, counterLimit: null, ordinal: 0 },
  ],
  terminals: [
    { stableStepId: "done", kind: "complete", instruction: "All set.", ordinal: 0 },
    { stableStepId: "escalate", kind: "handoff", instruction: "Could not identify the order.", ordinal: 1 },
  ],
  createdAt: nowIso,
  updatedAt: nowIso,
};

test("the routine map opens on demand and shows where the model decides", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates: [], routines: [mappedRoutine] });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "Edit draft Order return request" }).click();

  // The editor stays on the document until the map is asked for.
  await expect(page.locator(".react-flow")).toHaveCount(0);
  await page.getByRole("button", { name: "Map", exact: true }).click();

  const map = page.getByRole("dialog", { name: "Map" });
  await expect(map).toBeVisible();
  const canvas = map.locator(".react-flow");
  const edgeLabels = canvas.locator(".react-flow__edge-text");

  // Every step, both endings, and the activation entry are drawn.
  await expect(canvas.getByText("ask_order", { exact: true })).toBeVisible();
  await expect(canvas.getByText("ask_reason", { exact: true })).toBeVisible();
  await expect(canvas.getByText("Starts when", { exact: true })).toBeVisible();
  await expect(canvas.getByText("Hand off", { exact: true })).toBeVisible();
  await expect(canvas.getByText("Finish", { exact: true })).toBeVisible();

  // Only the branch the model decides carries a label. A rule is the expectation, and
  // the plain onward path is not a decision at all, so neither is labelled here.
  await expect(edgeLabels).toHaveText(["AI decides"]);

  // Two branches actually decide something, and one of them is a rule.
  await expect(map.getByText("1 of 2")).toBeVisible();

  // A declared slot no step collects is called out rather than left to be discovered.
  await expect(map).toContainText("never collected");
  await expect(map).toContainText("email");

  // Selecting a step reports where it can go next, in evaluation order.
  await expect(map.getByText("Select a step to inspect it.")).toBeVisible();
  await canvas.getByText("ask_order", { exact: true }).click();
  await expect(map.getByText("Exits · in order")).toBeVisible();
  const exits = map.getByRole("listitem");
  await expect(exits).toHaveCount(2);
  await expect(exits.first()).toContainText("ask_reason");
  await expect(exits.last()).toContainText("escalate");

  // The conditions view names every branch, including the rules.
  await map.getByRole("button", { name: "Show conditions" }).click();
  await expect(edgeLabels.filter({ hasText: /^Rule · / })).toHaveCount(1);

  // Closing it returns the editor to the document.
  await page.keyboard.press("Escape");
  await expect(page.locator(".react-flow")).toHaveCount(0);
});
