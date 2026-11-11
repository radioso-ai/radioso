import { describe, expect, it } from "vitest";

import { compileRoutineDefinition } from "../../../src/modules/routines/compiler.js";
import type { RoutineDefinition } from "../../../src/modules/routines/domain.js";
import {
  toSafeRoutineValidationDiagnostic,
  validateRoutineDefinition,
  type RoutineValidationDiagnostic,
} from "../../../src/modules/routines/validator.js";

type Consent = NonNullable<RoutineDefinition["consents"]>[number];
type Variant = Consent["variants"][number];

const english: Variant = { locale: "en", body: "We ask about your health to book the right session.", agreeLabel: "I agree", declineLabel: "No thanks" };

const consent = (overrides: Partial<Consent> = {}): Consent => ({
  key: "health",
  slotKeys: ["pregnant"],
  variants: [english],
  onDecline: "continue",
  ...overrides,
});

const intake = (consents?: Consent[]): RoutineDefinition => ({
  id: "def_intake",
  agentId: "agent_1",
  lineageId: "def_intake",
  name: "intake",
  version: 1,
  enabled: true,
  activation: { triggerDescription: "The visitor wants to book a session.", gateRef: null, priority: 0, reentryMode: "once_per_conversation" },
  slots: [
    { stableSlotId: "slot_name", key: "name", type: "text", required: true, description: null, ordinal: 0 },
    { stableSlotId: "slot_pregnant", key: "pregnant", type: "boolean", required: true, description: null, ordinal: 1, sensitivity: "sensitive" },
    { stableSlotId: "slot_injury", key: "injury", type: "text", required: false, description: null, ordinal: 2, sensitivity: "sensitive" },
  ],
  steps: [
    { stableStepId: "ask_name", kind: "chat", instruction: "Ask for {{slot.name}}.", toolRef: null, ordinal: 0, metadata: {} },
    { stableStepId: "ask_health", kind: "chat", instruction: "Ask whether {{slot.pregnant}} and about {{slot.injury}}.", toolRef: null, ordinal: 1, metadata: {} },
  ],
  transitions: [
    { fromStep: "ask_name", toRef: "ask_health", guardKind: "default", guardText: null, ordinal: 0 },
    { fromStep: "ask_health", toRef: "done", guardKind: "default", guardText: null, ordinal: 1 },
  ],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Thank the visitor.", ordinal: 0 }],
  ...(consents ? { consents } : {}),
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  updatedAt: new Date("2026-11-01T00:00:00.000Z"),
});

const consentFindings = (definition: RoutineDefinition, agentDefaultLocale = "en"): Array<Pick<RoutineValidationDiagnostic, "code" | "location">> =>
  validateRoutineDefinition(definition, { agentDefaultLocale }).diagnostics
    .filter((diagnostic) => diagnostic.code.startsWith("consent_"))
    .map(({ code, location }) => ({ code, location }));

describe("consent shape validation (#1544)", () => {
  it("accepts consents that cover sensitive slots with complete wording in the agent's language", () => {
    const result = validateRoutineDefinition(intake([
      consent({ variants: [english, { locale: "de-DE", body: "Wir fragen nach Ihrer Gesundheit.", agreeLabel: "Ja", declineLabel: "Nein" }] }),
      consent({ key: "injury_details", slotKeys: ["injury"], onDecline: "handoff" }),
    ]), { agentDefaultLocale: "en" });

    expect(result).toEqual({ ok: true, diagnostics: [] });
  });

  it("runs no consent rule when the caller does not say the agent's language", () => {
    const broken = intake([consent({ key: "health", slotKeys: ["unknown", "name"], variants: [{ locale: "fr", body: "", agreeLabel: "", declineLabel: "" }] }), consent()]);

    expect(validateRoutineDefinition(broken).diagnostics.filter((diagnostic) => diagnostic.code.startsWith("consent_"))).toEqual([]);
  });

  it("compiles a routine published before consents whose sensitive slot no consent covers", () => {
    const routine = compileRoutineDefinition(intake());

    expect(routine.steps.some((step) => step.kind === "consent")).toBe(false);
    expect(validateRoutineDefinition(intake(), { agentDefaultLocale: "en" }).ok).toBe(true);
  });

  it("names a covered slot the routine does not declare, or one that is not sensitive", () => {
    expect(consentFindings(intake([consent({ slotKeys: ["pregnant", "allergy", "name"] })]))).toEqual([
      { code: "consent_slot_unknown", location: "consent:health.slotKeys.allergy" },
      { code: "consent_slot_not_sensitive", location: "consent:health.slotKeys.name" },
    ]);
  });

  it("names a slot two consents cover, once", () => {
    expect(consentFindings(intake([
      consent(),
      consent({ key: "pregnancy", slotKeys: ["pregnant", "injury"] }),
      consent({ key: "injury_details", slotKeys: ["injury"] }),
    ]))).toEqual([
      { code: "consent_slot_covered_twice", location: "slot:pregnant" },
      { code: "consent_slot_covered_twice", location: "slot:injury" },
    ]);
  });

  it("names a consent key used twice, once", () => {
    expect(consentFindings(intake([
      consent({ slotKeys: ["pregnant"] }),
      consent({ slotKeys: ["injury"] }),
      consent({ slotKeys: ["injury"] }),
    ])).filter((finding) => finding.code === "consent_key_duplicate")).toEqual([
      { code: "consent_key_duplicate", location: "consent:health" },
    ]);
  });

  it("requires wording in the agent's default language, matching its region the way exact words do", () => {
    const german = { locale: "de", body: "Wir fragen nach Ihrer Gesundheit.", agreeLabel: "Ja", declineLabel: "Nein" };

    expect(consentFindings(intake([consent({ variants: [german] })]))).toEqual([
      { code: "consent_missing_default_variant", location: "consent:health.variants" },
    ]);
    expect(consentFindings(intake([consent({ variants: [german] })]), "de")).toEqual([]);
    expect(consentFindings(intake([consent({ variants: [{ ...english, locale: "EN" }] })]), "en")).toEqual([]);
  });

  it("names each field whose text is blank, too long, or otherwise unusable", () => {
    expect(consentFindings(intake([consent({
      variants: [
        english,
        { locale: "de", body: "  ", agreeLabel: "", declineLabel: "Nein" },
        { locale: "fr", body: "x".repeat(8001), agreeLabel: "o".repeat(81), declineLabel: "Non" },
        { locale: "not a locale", body: "Texte", agreeLabel: "Oui", declineLabel: "Non" },
        { locale: "en", body: "Duplicate language", agreeLabel: "Yes", declineLabel: "No" },
        { locale: "es", body: "Hola {{slot.name}}", agreeLabel: "Sí {{context.page}}", declineLabel: "No" },
        { locale: "it", body: "Testo", agreeLabel: "Sì", declineLabel: " sì " },
      ],
    })]))).toEqual([
      { code: "consent_text_invalid", location: "consent:health.variants[1].body" },
      { code: "consent_text_invalid", location: "consent:health.variants[1].agreeLabel" },
      { code: "consent_text_invalid", location: "consent:health.variants[2].body" },
      { code: "consent_text_invalid", location: "consent:health.variants[2].agreeLabel" },
      { code: "consent_text_invalid", location: "consent:health.variants[3].locale" },
      { code: "consent_text_invalid", location: "consent:health.variants[4].locale" },
      { code: "consent_text_invalid", location: "consent:health.variants[5].body" },
      { code: "consent_text_invalid", location: "consent:health.variants[5].agreeLabel" },
      { code: "consent_text_invalid", location: "consent:health.variants[6].declineLabel" },
    ]);
  });

  it("gives every finding a safe message that names the consent or slot, never the wording", () => {
    const diagnostics = validateRoutineDefinition(intake([
      consent({ slotKeys: ["pregnant", "allergy", "name"], variants: [{ locale: "de", body: "Geheimer Text", agreeLabel: "", declineLabel: "Nein" }] }),
      consent({ slotKeys: ["pregnant"] }),
    ]), { agentDefaultLocale: "en" }).diagnostics;
    const messages = diagnostics.map((diagnostic) => toSafeRoutineValidationDiagnostic(diagnostic).message);

    expect(new Set(diagnostics.map((diagnostic) => diagnostic.code))).toEqual(new Set([
      "consent_slot_unknown",
      "consent_slot_not_sensitive",
      "consent_slot_covered_twice",
      "consent_key_duplicate",
      "consent_missing_default_variant",
      "consent_text_invalid",
    ]));
    for (const message of messages) {
      expect(message).not.toBe("The routine structure is not valid for serving.");
      expect(message).not.toContain("Geheimer");
    }
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining('"allergy"'),
      expect.stringContaining('"name"'),
      expect.stringContaining('"pregnant"'),
      expect.stringContaining('"health"'),
    ]));
  });
});
