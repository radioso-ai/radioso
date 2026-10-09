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

test("a notice's fields reference only the slots the routine declares and stop at their length limits", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates, routines: [bookingRoutine] });
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/${bookingRoutine.id}`);

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await documentEditor.getByRole("button", { name: "Toggle details", exact: true }).click();
  await documentEditor.getByRole("button", { name: "Finish ending", exact: true }).click();
  await documentEditor.getByRole("switch", { name: "Notify the team" }).click();

  // The subject stops at its limit, so the draft never carries a subject its save rejects.
  const subject = documentEditor.getByLabel("Subject", { exact: true });
  await subject.click();
  await page.keyboard.insertText("a".repeat(195));
  await subject.pressSequentially("bcdefghij");

  // A paste that would run past the intro's limit is refused whole.
  const intro = documentEditor.getByLabel("Intro", { exact: true });
  await intro.click();
  await intro.pressSequentially("Confirm the room.");
  await page.keyboard.insertText("x".repeat(2000));

  // `@` offers the slots the routine declares, and nothing a notice cannot substitute.
  await intro.pressSequentially(" @");
  await expect(page.getByRole("option", { name: /guest_name/ })).toBeVisible();
  await expect(page.getByRole("option", { name: "Current page" })).toHaveCount(0);
  // A name the routine does not declare stays text: a notice never creates a slot.
  await intro.pressSequentially("room_type");
  await expect(page.getByRole("option", { name: /Create variable/ })).toHaveCount(0);
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  const lastPatch = () => routineUpdates.filter((update) => update.method === "PATCH").at(-1)?.body;
  await expect.poll(
    () => lastPatch()?.terminals?.find((terminal) => terminal.stableStepId === "booked")?.operatorNotice,
    { timeout: 15_000 },
  ).toEqual({ subject: `${"a".repeat(195)}bcdef`, intro: "Confirm the room. @room_type" });
  expect(lastPatch()?.slots?.map((slot) => slot.key)).toEqual(["guest_name"]);
});

test("an ending's notice names the notify skill that sends it, and shows who that reaches", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    routineUpdates,
    routines: [bookingRoutine],
    routineSkillCatalog: [{
      skillName: "notify_bookings",
      displayName: "Notify bookings",
      category: "notify",
      inputs: [{ key: "message", type: "text", required: true }],
      outcomes: [{ name: "delivered", displayName: "Delivered", status: "completed" }],
      hasDataOutputs: false,
    }],
    operatorNoticeDestinations: {
      default: { skillName: null, via: "workspace_owner", recipientEmails: ["owner@ananda.it"], recipientsFromWorkspaceOwner: true, webhookConfigured: false },
      skills: [{ skillName: "notify_bookings", via: "named_skill", recipientEmails: ["francesco@ananda.it"], recipientsFromWorkspaceOwner: false, webhookConfigured: false }],
    },
  });
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/${bookingRoutine.id}`);

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await documentEditor.getByRole("button", { name: "Toggle details", exact: true }).click();
  await documentEditor.getByRole("button", { name: "Hand-off ending", exact: true }).click();

  // The default names where it goes, down to the address.
  const sendWith = documentEditor.getByRole("combobox", { name: "Send with" });
  await expect(sendWith).toContainText("Default (workspace owner)");
  await expect(documentEditor.getByText("Sends to owner@ananda.it (workspace owner)")).toBeVisible();

  await sendWith.click();
  await page.getByRole("option", { name: "Notify bookings" }).click();
  await expect(documentEditor.getByText("Sends to francesco@ananda.it")).toBeVisible();
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await expect.poll(
    () => routineUpdates.filter((update) => update.method === "PATCH").at(-1)?.body?.terminals
      ?.find((terminal) => terminal.stableStepId === "reception")?.operatorNotice,
    { timeout: 15_000 },
  ).toEqual({ subject: null, intro: null, skillName: "notify_bookings" });
});

// A gift stay collects the buyer's address and the recipient's, so the author picks where replies go.
const giftRoutine: RoutineFixture = {
  ...bookingRoutine,
  id: "55555555-5555-4555-9555-000000000502",
  lineageId: "77777777-7777-4777-8777-000000000502",
  name: "Gift a stay",
  slots: [
    { stableSlotId: "guest_name", key: "guest_name", type: "text", required: true, description: "The guest's name", ordinal: 0 },
    { stableSlotId: "buyer_email", key: "buyer_email", type: "email", required: true, description: "Who pays", ordinal: 1 },
    { stableSlotId: "recipient_email", key: "recipient_email", type: "email", required: true, description: "Who stays", ordinal: 2 },
  ],
  steps: [{ ...bookingRoutine.steps[0], instruction: "Ask for {{slot.guest_name}}, {{slot.buyer_email}} and {{slot.recipient_email}}." }],
};

test("replies to an ending's notice go to the email field its author picks, and the choice survives a reload", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates, routines: [giftRoutine] });
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/${giftRoutine.id}`);

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await documentEditor.getByRole("button", { name: "Toggle details", exact: true }).click();
  await documentEditor.getByRole("button", { name: "Hand-off ending", exact: true }).click();

  // Two addresses, so nothing is picked for the author; only email fields are offered.
  const repliesGoTo = documentEditor.getByRole("combobox", { name: "Replies go to" });
  await expect(repliesGoTo).toContainText("No reply-to");
  await repliesGoTo.click();
  await expect(page.getByRole("option", { name: "guest_name" })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "buyer_email" })).toBeVisible();
  await page.getByRole("option", { name: "recipient_email" }).click();
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await expect.poll(
    () => routineUpdates.filter((update) => update.method === "PATCH").at(-1)?.body?.terminals
      ?.find((terminal) => terminal.stableStepId === "reception")?.operatorNotice,
    { timeout: 15_000 },
  ).toEqual({ subject: null, intro: null, replyToSlot: "recipient_email" });

  await page.reload();
  await documentEditor.getByRole("button", { name: "Toggle details", exact: true }).click();
  await documentEditor.getByRole("button", { name: "Hand-off ending", exact: true }).click();
  await expect(documentEditor.getByRole("combobox", { name: "Replies go to" })).toContainText("recipient_email");
});

test("a notice the author turns on replies to the routine's only email field, and an existing notice is left as stored", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];
  const singleAddress: RoutineFixture = {
    ...giftRoutine,
    slots: giftRoutine.slots.filter((slot) => slot.key !== "buyer_email"),
    steps: [{ ...bookingRoutine.steps[0], instruction: "Ask for {{slot.guest_name}} and {{slot.recipient_email}}." }],
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates, routines: [singleAddress] });
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/${singleAddress.id}`);

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await documentEditor.getByRole("button", { name: "Toggle details", exact: true }).click();

  // The stored hand-off has no reply-to, and opening it does not give it one.
  await documentEditor.getByRole("button", { name: "Hand-off ending", exact: true }).click();
  await expect(documentEditor.getByRole("combobox", { name: "Replies go to" })).toContainText("No reply-to");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await documentEditor.getByRole("button", { name: "Finish ending", exact: true }).click();
  await documentEditor.getByRole("switch", { name: "Notify the team" }).click();
  await expect(documentEditor.getByRole("combobox", { name: "Replies go to" })).toContainText("recipient_email");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  const lastPatch = () => routineUpdates.filter((update) => update.method === "PATCH").at(-1)?.body;
  await expect.poll(
    () => lastPatch()?.terminals?.find((terminal) => terminal.stableStepId === "booked")?.operatorNotice,
    { timeout: 15_000 },
  ).toEqual({ subject: null, intro: null, replyToSlot: "recipient_email" });
  expect(lastPatch()?.terminals?.find((terminal) => terminal.stableStepId === "reception")).not.toHaveProperty("operatorNotice");
});

test("an ending whose reply-to field stops being an email field says so", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];
  const replying: RoutineFixture = {
    ...giftRoutine,
    terminals: giftRoutine.terminals.map((terminal) => terminal.stableStepId === "reception"
      ? { ...terminal, operatorNotice: { subject: null, intro: null, replyToSlot: "recipient_email" } }
      : terminal),
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates, routines: [replying] });
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/${replying.id}`);

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await documentEditor.getByRole("button", { name: "Toggle details", exact: true }).click();
  await documentEditor.getByRole("button", { name: "recipient_email", exact: true }).click();
  await documentEditor.getByLabel("Slot recipient_email type").selectOption("text");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await expect(documentEditor.getByText("Replies can only go to an email field. Pick one or choose No reply-to.")).toBeVisible({ timeout: 15_000 });
  await documentEditor.getByRole("button", { name: "Hand-off ending", exact: true }).click();
  await expect(documentEditor.getByRole("combobox", { name: "Replies go to" })).toContainText("recipient_email (not an email field)");
});
