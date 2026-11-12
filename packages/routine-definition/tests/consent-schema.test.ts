import { describe, expect, it } from "vitest";

import {
  routineConsentEditingSchema,
  routineConsentSchema,
  routineConsentStoredSchema,
  routineDefinitionDraftEditingInputSchema,
  routineDefinitionDraftInputSchema,
  routineDefinitionDraftUpdateInputSchema,
  routineDefinitionSchema,
  routineValidationCodes,
} from "../src/index.js";

const consent = {
  key: "health",
  slotKeys: ["pregnant"],
  variants: [
    { locale: "en", body: "We ask about your health to book the right session.", agreeLabel: "I agree", declineLabel: "No thanks" },
  ],
  onDecline: "continue",
} as const;

const draft = {
  name: "Intake",
  activation: { triggerDescription: "Book a session", gateRef: null, priority: 0 },
  slots: [{ stableSlotId: "pregnant", key: "pregnant", type: "boolean", required: true, description: null, ordinal: 0, sensitivity: "sensitive" }],
  steps: [{ stableStepId: "ask", kind: "chat", instruction: "Ask whether {{slot.pregnant}}", toolRef: null, actionType: null, captureKey: null, ordinal: 0 }],
  transitions: [{ fromStep: "ask", toRef: "done", guardKind: "default", guardText: null, ordinal: 0 }],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: null, ordinal: 0 }],
} as const;

describe("routine consent schema", () => {
  it("accepts an authored consent and keeps its wording exactly as written", () => {
    const wording = { locale: "de", body: "  Wir fragen nach Ihrer Gesundheit.\n", agreeLabel: " Ja ", declineLabel: "Nein" };
    const parsed = routineConsentSchema.parse({ ...consent, variants: [...consent.variants, wording] });

    expect(parsed.variants[1]).toEqual(wording);
    expect(parsed.onDecline).toBe("continue");
  });

  it("leaves blank wording to validation, so a half-written consent still saves", () => {
    expect(routineConsentSchema.safeParse({
      ...consent,
      variants: [{ locale: "", body: "", agreeLabel: "", declineLabel: "" }],
    }).success).toBe(true);
  });

  it("refuses a consent whose structure is broken", () => {
    const invalid: unknown[] = [
      { ...consent, key: "" },
      { ...consent, key: "health.data" },
      { ...consent, key: "health:data" },
      { ...consent, slotKeys: [] },
      { ...consent, slotKeys: ["pregnant", "pregnant"] },
      { ...consent, slotKeys: ["not a key"] },
      { ...consent, variants: [] },
      { ...consent, variants: [{ locale: "en", body: "x", agreeLabel: "y" }] },
      { ...consent, onDecline: "ignore" },
      { ...consent, extra: true },
    ];
    for (const value of invalid) {
      expect(routineConsentSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it("reads a stored consent a later version wrote with more fields, dropping them and keeping every rule on the rest", () => {
    const stored = { ...consent, reviewedAt: "2027-01-01", variants: [{ ...consent.variants[0], tone: "formal" }] };

    expect(routineConsentStoredSchema.parse(stored)).toEqual(consent);
    const broken: unknown[] = [
      { ...stored, key: "health.data" },
      { ...stored, slotKeys: [] },
      { ...stored, variants: [] },
      { ...stored, variants: [{ locale: "en", body: "x", agreeLabel: "y", tone: "formal" }] },
      { ...stored, onDecline: "ignore" },
    ];
    for (const value of broken) {
      expect(routineConsentStoredSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it("holds any mid-edit consent in the editing schema", () => {
    expect(routineConsentEditingSchema.safeParse({
      key: "",
      slotKeys: [],
      variants: [],
      onDecline: "handoff",
    }).success).toBe(true);
    expect(routineConsentEditingSchema.safeParse({ ...consent, onDecline: "ignore" }).success).toBe(false);
  });

  it("reads a routine without consents back without the field, so stored rows and snapshots parse unchanged", () => {
    const parsed = routineDefinitionDraftInputSchema.parse(draft);

    expect(parsed).not.toHaveProperty("consents");
  });

  it("carries consents on the draft, the editing draft and the stored routine", () => {
    expect(routineDefinitionDraftInputSchema.parse({ ...draft, consents: [consent] }).consents).toEqual([consent]);
    expect(routineDefinitionDraftEditingInputSchema.parse({ ...draft, consents: [{ ...consent, slotKeys: [] }] }).consents)
      .toEqual([{ ...consent, slotKeys: [] }]);
    expect(routineDefinitionSchema.parse({
      ...draft,
      consents: [consent],
      id: "routine_1",
      agentId: "agent_1",
      lineageId: "routine_1",
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).consents).toEqual([consent]);
  });

  it("refuses a stored routine with a broken consent instead of dropping it", () => {
    expect(routineDefinitionDraftInputSchema.safeParse({ ...draft, consents: [{ ...consent, slotKeys: [] }] }).success).toBe(false);
  });

  it("reads an update that leaves consents out as unchanged, and an empty list as cleared", () => {
    expect(routineDefinitionDraftUpdateInputSchema.parse(draft).consents).toBeUndefined();
    expect(routineDefinitionDraftUpdateInputSchema.parse({ ...draft, consents: [] }).consents).toEqual([]);
  });

  it("publishes the authoring shape codes the validator reports", () => {
    expect(routineValidationCodes).toEqual(expect.arrayContaining([
      "consent_slot_unknown",
      "consent_slot_not_sensitive",
      "consent_slot_covered_twice",
      "consent_key_duplicate",
      "consent_missing_default_variant",
      "consent_text_invalid",
    ]));
  });
});
