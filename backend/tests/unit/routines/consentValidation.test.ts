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
    { stableStepId: "ask_pregnant", kind: "chat", instruction: "Ask whether {{slot.pregnant}}.", toolRef: null, ordinal: 1, metadata: {} },
    { stableStepId: "ask_injury", kind: "chat", instruction: "Ask about {{slot.injury}}.", toolRef: null, ordinal: 2, metadata: {} },
  ],
  transitions: [
    { fromStep: "ask_name", toRef: "ask_pregnant", guardKind: "default", guardText: null, ordinal: 0 },
    { fromStep: "ask_pregnant", toRef: "ask_injury", guardKind: "default", guardText: null, ordinal: 1 },
    { fromStep: "ask_injury", toRef: "done", guardKind: "default", guardText: null, ordinal: 2 },
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
      "sensitive_slot_without_consent",
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
      expect.stringContaining('"injury"'),
    ]));
  });
});

type Transition = RoutineDefinition["transitions"][number];
type Step = RoutineDefinition["steps"][number];

const publishFindings = (definition: RoutineDefinition, agentDefaultLocale: string | null = "en"): Array<Pick<RoutineValidationDiagnostic, "code" | "location">> =>
  validateRoutineDefinition(definition, agentDefaultLocale === null ? {} : { agentDefaultLocale }).diagnostics
    .filter((diagnostic) => ["sensitive_slot_without_consent", "consent_step_mixes_fields", "consent_step_needs_default_exit"].includes(diagnostic.code))
    .map(({ code, location }) => ({ code, location }));

/** The intake routine with one step asking for both sensitive fields, as a routine can be authored. */
const intakeAskingHealthTogether = (consents: Consent[], exits: Array<Omit<Transition, "ordinal">> = [
  { fromStep: "ask_health", toRef: "done", guardKind: "default", guardText: null },
]): RoutineDefinition => {
  const base = intake(consents);
  const askHealth: Step = { stableStepId: "ask_health", kind: "chat", instruction: "Ask whether {{slot.pregnant}} and about {{slot.injury}}.", toolRef: null, ordinal: 1, metadata: {} };
  return {
    ...base,
    steps: [base.steps[0], askHealth],
    transitions: [
      { fromStep: "ask_name", toRef: "ask_health", guardKind: "default", guardText: null, ordinal: 0 },
      ...exits.map((exit, index) => ({ ...exit, ordinal: index + 1 })),
    ],
  };
};

describe("consent coverage rules for publishing (#1544)", () => {
  it("names every sensitive field no consent covers", () => {
    expect(publishFindings(intake())).toEqual([
      { code: "sensitive_slot_without_consent", location: "slot:pregnant" },
      { code: "sensitive_slot_without_consent", location: "slot:injury" },
    ]);
    expect(publishFindings(intake([consent()]))).toEqual([
      { code: "sensitive_slot_without_consent", location: "slot:injury" },
    ]);
  });

  it("leaves a field two consents cover to the covered-twice finding", () => {
    expect(publishFindings(intake([
      consent({ slotKeys: ["pregnant", "injury"] }),
      consent({ key: "injury_details", slotKeys: ["injury"] }),
    ]))).toEqual([]);
  });

  it("runs none of these rules without the agent's language, so a routine published before consents keeps compiling and serving", () => {
    const legacy = intakeAskingHealthTogether([consent()], [{ fromStep: "ask_health", toRef: "done", guardKind: "llm", guardText: "The visitor answered." }]);

    expect(publishFindings(intake(), null)).toEqual([]);
    expect(publishFindings(legacy, null)).toEqual([]);
    expect(() => compileRoutineDefinition(intake())).not.toThrow();
    expect(compileRoutineDefinition(intake()).steps.some((step) => step.kind === "consent")).toBe(false);
    expect(() => compileRoutineDefinition(legacy)).not.toThrow();
  });

  it("refuses a continue consent whose collecting step also asks for fields it does not cover", () => {
    const covered = consent({ key: "injury_details", slotKeys: ["injury"], onDecline: "handoff" });

    expect(publishFindings(intakeAskingHealthTogether([consent(), covered]))).toEqual([
      { code: "consent_step_mixes_fields", location: "consent:health.steps.ask_health" },
    ]);
    // A decline that hands off never needs the step skipped, and one consent over both fields
    // leaves nothing else to ask.
    expect(publishFindings(intakeAskingHealthTogether([consent({ onDecline: "handoff" }), covered]))).toEqual([]);
    expect(publishFindings(intakeAskingHealthTogether([consent({ slotKeys: ["pregnant", "injury"] })]))).toEqual([]);
  });

  it("refuses a continue consent whose collecting step has no default exit to skip it by", () => {
    const both = consent({ slotKeys: ["pregnant", "injury"] });
    const judged = intakeAskingHealthTogether([both], [{ fromStep: "ask_health", toRef: "done", guardKind: "llm", guardText: "The visitor answered." }]);

    expect(publishFindings(judged)).toEqual([
      { code: "consent_step_needs_default_exit", location: "consent:health.steps.ask_health" },
    ]);
    expect(publishFindings(intakeAskingHealthTogether([both], [
      { fromStep: "ask_health", toRef: "done", guardKind: "llm", guardText: "The visitor answered." },
      { fromStep: "ask_health", toRef: "done", guardKind: "default", guardText: null },
    ]))).toEqual([]);
    expect(publishFindings(intakeAskingHealthTogether([{ ...both, onDecline: "handoff" }], [
      { fromStep: "ask_health", toRef: "done", guardKind: "llm", guardText: "The visitor answered." },
    ]))).toEqual([]);
  });

  it("gives each a safe message that names the field, consent and step", () => {
    const messages = (definition: RoutineDefinition) =>
      validateRoutineDefinition(definition, { agentDefaultLocale: "en" }).diagnostics
        .filter((diagnostic) => ["sensitive_slot_without_consent", "consent_step_mixes_fields", "consent_step_needs_default_exit"].includes(diagnostic.code))
        .map((diagnostic) => toSafeRoutineValidationDiagnostic(diagnostic).message);

    expect(messages(intake([consent()]))).toEqual([
      'Field "injury" is sensitive, so visitors must agree to a consent before it is collected. Add a consent that covers it.',
    ]);
    expect(messages(intakeAskingHealthTogether([consent(), consent({ key: "injury_details", slotKeys: ["injury"], onDecline: "handoff" })]))).toEqual([
      'Consent "health" continues without its fields on decline, but step "ask_health" also asks for fields it does not cover. Ask those in their own step, or hand off on decline.',
    ]);
    expect(messages(intakeAskingHealthTogether([consent({ slotKeys: ["pregnant", "injury"] })], [{ fromStep: "ask_health", toRef: "done", guardKind: "llm", guardText: "The visitor answered." }]))).toEqual([
      'Consent "health" continues without its fields on decline, but step "ask_health" has no default exit to skip it by. Give the step a default exit, or hand off on decline.',
    ]);
  });
});
