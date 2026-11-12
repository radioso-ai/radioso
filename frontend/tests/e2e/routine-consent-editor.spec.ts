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
  id: "55555555-5555-4555-9555-000000000544",
  lineageId: "77777777-7777-4777-8777-000000000544",
  agentId: defaultAgentId,
  name: "Book a table",
  enabled: true,
  version: 1,
  activation: { triggerDescription: "A guest wants to book a table.", gateRef: null, priority: 10, reentryMode: "once_per_conversation" },
  slots: [
    { stableSlotId: "guest_name", key: "guest_name", type: "text", required: true, description: "The guest's name", ordinal: 0 },
    { stableSlotId: "dietary", key: "dietary", type: "text", required: true, description: "Dietary needs", ordinal: 1 },
  ],
  steps: [
    { stableStepId: "ask_name", kind: "chat", instruction: "Ask for {{slot.guest_name}}.", toolRef: null, actionType: null, ordinal: 0, metadata: {} },
    { stableStepId: "ask_diet", kind: "chat", instruction: "Ask about {{slot.dietary}}.", toolRef: null, actionType: null, ordinal: 1, metadata: {} },
  ],
  transitions: [
    { fromStep: "ask_name", toRef: "ask_diet", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 },
    { fromStep: "ask_diet", toRef: "booked", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 1 },
  ],
  terminals: [{ stableStepId: "booked", kind: "complete", instruction: "Confirm the booking.", ordinal: 0 }],
  createdAt: nowIso,
  updatedAt: nowIso,
};

const english = { locale: "en-US", body: "To prepare your table we ask about your dietary needs. We keep the answer in this conversation only.", agreeLabel: "I agree", declineLabel: "No thanks" };
const italian = { locale: "it", body: "Per preparare il tavolo chiediamo delle tue esigenze alimentari. Teniamo la risposta solo in questa conversazione.", agreeLabel: "Accetto", declineLabel: "No, grazie" };

test("a sensitive field asks for a consent, written in two languages, before the routine publishes (#1544)", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];
  const lastPatch = () => routineUpdates.filter((update) => update.method === "PATCH").at(-1)?.body;
  const uncoveredSensitiveFields = () => {
    const body = lastPatch();
    const covered = new Set((body?.consents ?? []).flatMap((consent) => consent.slotKeys));
    return (body?.slots ?? []).filter((slot) => slot.sensitivity === "sensitive" && !covered.has(slot.key)).map((slot) => slot.key);
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { routineUpdates, routines: [bookingRoutine] });
  // A saved routine edit leaves a draft to publish; publishing refuses a sensitive field no consent
  // covers, the way the backend's release gate does.
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}/revision-state`, async (route) => {
    if (routineUpdates.length === 0) return route.fallback();
    await route.fulfill({
      json: {
        agentId: defaultAgentId,
        status: "draft_dirty",
        draft: { generation: 2, basePublishedRevisionId: "22222222-2222-4222-8222-222222222222", updatedAt: nowIso },
        publishedRevision: { id: "22222222-2222-4222-8222-222222222222", label: "Published", kind: "published", versionNumber: 1, createdAt: "2026-04-26T12:00:00.000Z" },
        canPublish: true,
        proactiveGreetingEnabled: false,
      },
    });
  });
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}/revisions/candidates`, async (route) => {
    const uncovered = uncoveredSensitiveFields();
    if (uncovered.length === 0) return route.fallback();
    await route.fulfill({
      status: 422,
      json: {
        error: {
          code: "revision_invalid",
          message: "The draft contains content that cannot be released.",
          details: { diagnostics: uncovered.map((key) => ({ routineId: bookingRoutine.id, code: "sensitive_slot_without_consent", location: `slot:${key}`, message: `Field "${key}" is sensitive, so visitors must agree to a consent before it is collected. Add a consent that covers it.` })) },
        },
      },
    });
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/${bookingRoutine.id}`);
  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await documentEditor.getByRole("button", { name: "Toggle details", exact: true }).click();

  // Marking the field sensitive asks for a consent right there, before anything is saved.
  await documentEditor.getByRole("button", { name: "dietary", exact: true }).click();
  await documentEditor.getByRole("switch", { name: "Slot dietary sensitive" }).click();
  const prompt = documentEditor.getByText("Needs a consent before publishing.");
  await expect(prompt).toBeVisible();
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();
  await expect(prompt).toBeVisible();
  await expect.poll(() => uncoveredSensitiveFields(), { timeout: 15_000 }).toEqual(["dietary"]);

  // Publishing refuses it and names the field.
  await page.getByRole("button", { name: "Review & publish", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: 'Field "dietary" is sensitive' })).toBeVisible();

  // The prompt adds a consent over the field, in the agent's default language.
  await documentEditor.getByRole("button", { name: "Add consent for dietary", exact: true }).click();
  await expect(prompt).toHaveCount(0);
  const consent = documentEditor.getByRole("group", { name: "Consent dietary" });
  await expect(consent.getByRole("checkbox", { name: "Covers dietary" })).toHaveAttribute("aria-checked", "true");
  await consent.getByLabel("Consent wording (en-US)").fill(english.body);
  await consent.getByLabel("Agree label (en-US)").fill(english.agreeLabel);
  await consent.getByLabel("Decline label (en-US)").fill(english.declineLabel);

  await consent.getByPlaceholder("Add a language").fill("Italian");
  await page.getByRole("option", { name: "Italian" }).click();
  await consent.getByRole("button", { name: "Add", exact: true }).click();
  // The field the wording asks consent for sits beside it, so the text can name it.
  await expect(consent.getByRole("complementary", { name: "Fields this wording covers (Italian)" })).toContainText("dietary");
  await consent.getByLabel("Consent wording (Italian)").fill(italian.body);
  await consent.getByLabel("Agree label (Italian)").fill(italian.agreeLabel);
  await consent.getByLabel("Decline label (Italian)").fill(italian.declineLabel);

  await consent.getByRole("group", { name: "If the visitor declines dietary" }).getByRole("button", { name: "Hand off" }).click();
  await expect(consent.getByText("A person takes over the conversation.")).toBeVisible();

  // The step that collects the field says the consent comes first.
  await expect(documentEditor.getByRole("listitem").filter({ hasText: "Ask about" }).getByText("Asks consent first")).toBeVisible();

  await expect.poll(() => lastPatch()?.consents, { timeout: 15_000 }).toEqual([
    { key: "dietary", slotKeys: ["dietary"], onDecline: "handoff", variants: [english, italian] },
  ]);
  expect(lastPatch()?.slots?.find((slot) => slot.key === "dietary")?.sensitivity).toBe("sensitive");

  // With the field covered, the draft publishes.
  await page.getByRole("button", { name: "Review & publish", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review draft publication" });
  await review.getByRole("button", { name: "Publish revision" }).click();
  await expect(review).toHaveCount(0);
});
