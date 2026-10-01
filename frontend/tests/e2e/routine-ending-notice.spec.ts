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

const bookingRoutine: RoutineFixture = {
  id: "55555555-5555-4555-9555-000000000501",
  lineageId: "77777777-7777-4777-8777-000000000501",
  agentId: defaultAgentId,
  name: "Book accommodation",
  enabled: true,
  version: 1,
  activation: {
    triggerDescription: "A guest wants to book a stay.",
    gateRef: null,
    priority: 10,
    reentryMode: "once_per_conversation",
  },
  slots: [{
    stableSlotId: "guest_name",
    key: "guest_name",
    type: "text",
    required: true,
    description: "The guest's name",
    ordinal: 0,
  }],
  steps: [{
    stableStepId: "ask_name",
    kind: "chat",
    instruction: "Ask for {{slot.guest_name}}.",
    toolRef: null,
    actionType: null,
    ordinal: 0,
    metadata: {},
  }],
  transitions: [{
    fromStep: "ask_name",
    toRef: "booked",
    guardKind: "default",
    guardText: null,
    outcomeStatus: null,
    counterLimit: null,
    ordinal: 0,
  }],
  terminals: [
    { stableStepId: "booked", kind: "complete", instruction: "Confirm the request is in.", ordinal: 0 },
    { stableStepId: "reception", kind: "handoff", instruction: null, ordinal: 1 },
  ],
  createdAt: nowIso,
  updatedAt: nowIso,
};

test("a finish ending notifies the team with the notice its author wrote, and keeps it across a reload", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates, routines: [bookingRoutine] });
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/${bookingRoutine.id}`);

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  // Endings live inside the collapsed "Endings & information" disclosure.
  await documentEditor.getByRole("button", { name: "Toggle details", exact: true }).click();

  // A hand-off always notifies, so its switch is on and cannot be turned off.
  await documentEditor.getByRole("button", { name: "Hand-off ending", exact: true }).click();
  const handoffSwitch = documentEditor.getByRole("switch", { name: "Notify the team" });
  await expect(handoffSwitch).toBeChecked();
  await expect(handoffSwitch).toBeDisabled();
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await documentEditor.getByRole("button", { name: "Finish ending", exact: true }).click();
  const finishSwitch = documentEditor.getByRole("switch", { name: "Notify the team" });
  await expect(finishSwitch).not.toBeChecked();
  await finishSwitch.click();

  const subject = documentEditor.getByLabel("Subject", { exact: true });
  await subject.click();
  await subject.pressSequentially("New booking for @guest_name");
  await page.getByRole("option", { name: /guest_name/ }).first().click();
  const intro = documentEditor.getByLabel("Intro", { exact: true });
  await intro.click();
  await intro.pressSequentially("Please confirm the room.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await expect.poll(
    () => routineUpdates.filter((update) => update.method === "PATCH").at(-1)?.body?.terminals
      ?.find((terminal) => terminal.stableStepId === "booked")?.operatorNotice,
    { timeout: 15_000 },
  ).toEqual({ subject: "New booking for {{slot.guest_name}}", intro: "Please confirm the room." });

  await page.reload();
  await documentEditor.getByRole("button", { name: "Toggle details", exact: true }).click();
  await expect(documentEditor.getByRole("button", { name: "Finish ending", exact: true })).toContainText("notifies the team");
  await documentEditor.getByRole("button", { name: "Finish ending", exact: true }).click();
  await expect(documentEditor.getByRole("switch", { name: "Notify the team" })).toBeChecked();
  await expect(documentEditor.getByLabel("Subject", { exact: true })).toContainText("New booking for");
  await expect(documentEditor.getByLabel("Subject", { exact: true })).toContainText("guest_name");
  await expect(documentEditor.getByLabel("Intro", { exact: true })).toContainText("Please confirm the room.");
});
