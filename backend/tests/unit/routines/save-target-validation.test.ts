import { describe, expect, it } from "vitest";

import type { AvailableContextVariable } from "../../../src/modules/context-variables/public.js";
import type { RoutineDefinition } from "../../../src/modules/routines/domain.js";
import { toSafeRoutineValidationDiagnostic, validateRoutineDefinition } from "../../../src/modules/routines/validator.js";

type Slot = RoutineDefinition["slots"][number];

const slot = (key: string, type: Slot["type"], extra: Partial<Slot> = {}): Slot => ({
  stableSlotId: `slot_${key}`,
  key,
  type,
  required: true,
  description: null,
  ordinal: 0,
  ...extra,
});

const booking = (slots: Slot[]): RoutineDefinition => ({
  id: "def_1",
  agentId: "agent_1",
  lineageId: "lineage_1",
  name: "booking",
  version: 1,
  enabled: true,
  activation: { triggerDescription: "Book a table.", gateRef: null, priority: 10, reentryMode: "once_per_conversation" },
  slots,
  steps: [{
    stableStepId: "ask",
    kind: "chat",
    instruction: `Ask for ${slots.map((entry) => `{{slot.${entry.key}}}`).join(" and ")}.`,
    toolRef: null,
    ordinal: 0,
    metadata: {},
  }],
  transitions: [{ fromStep: "ask", toRef: "done", guardKind: "default", guardText: null, ordinal: 0 }],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Booked.", ordinal: 0 }],
  createdAt: new Date("2026-11-24T00:00:00.000Z"),
  updatedAt: new Date("2026-11-24T00:00:00.000Z"),
});

const stored = (
  valueType: AvailableContextVariable["valueType"],
  extra: Partial<NonNullable<AvailableContextVariable["stored"]>> = {},
): AvailableContextVariable => ({ valueType, stored: { trustTier: "unverified", sensitivity: "normal", ...extra } });

const attributes = new Map<string, AvailableContextVariable>([
  ["party_size", stored("number")],
  ["guest_note", stored("string")],
  ["member", stored("boolean")],
  ["arrival", stored("date")],
  ["contact_email", stored("string")],
  ["plan", stored("string", { trustTier: "signed" })],
  ["health_note", stored("string", { sensitivity: "sensitive" })],
  ["page_context", { valueType: "json" }],
  ["topic", stored("enum")],
]);

const saveDiagnostics = (slots: Slot[], availableContextVariables: ReadonlyMap<string, AvailableContextVariable> | null = attributes) =>
  validateRoutineDefinition(booking(slots), availableContextVariables ? { availableContextVariables } : {})
    .diagnostics.filter((diagnostic) => diagnostic.code.startsWith("save_to_"));

const conversation = (contextVariable: string) => ({ contextVariable, scope: "conversation" as const });

describe("a slot's save target", () => {
  it("accepts a slot saved to a stored attribute of a matching type", () => {
    expect(saveDiagnostics([
      slot("guests", "number", { saveTo: conversation("party_size") }),
      slot("note", "text", { saveTo: conversation("guest_note") }),
      slot("email", "email", { saveTo: { contextVariable: "contact_email", scope: "person" } }),
      slot("is_member", "boolean", { saveTo: conversation("member") }),
      slot("day", "date", { saveTo: conversation("arrival") }),
    ])).toEqual([]);
  });

  it("refuses an attribute the agent does not have", () => {
    expect(saveDiagnostics([slot("guests", "number", { saveTo: conversation("party") })])).toEqual([
      expect.objectContaining({ code: "save_to_unknown_attribute", location: "slot:guests.saveTo" }),
    ]);
  });

  it("refuses an attribute whose value the agent does not keep, such as a built-in or a page value", () => {
    expect(saveDiagnostics([slot("page", "text", { saveTo: conversation("page_context") })])).toEqual([
      expect.objectContaining({ code: "save_to_attribute_not_stored", location: "slot:page.saveTo" }),
    ]);
  });

  it("refuses a type that does not match: text and email to Text, number, Yes/no and date to their own", () => {
    expect(saveDiagnostics([
      slot("guests", "text", { saveTo: conversation("party_size") }),
      slot("day", "text", { saveTo: conversation("arrival") }),
      slot("is_member", "number", { saveTo: conversation("member") }),
      slot("topic_text", "text", { saveTo: conversation("topic") }),
    ]).map((diagnostic) => [diagnostic.code, diagnostic.location])).toEqual([
      ["save_to_type_mismatch", "slot:guests.saveTo"],
      ["save_to_type_mismatch", "slot:day.saveTo"],
      ["save_to_type_mismatch", "slot:is_member.saveTo"],
      ["save_to_type_mismatch", "slot:topic_text.saveTo"],
    ]);
  });

  it("never saves a picked card", () => {
    expect(saveDiagnostics([slot("table", "item", { saveTo: conversation("guest_note") })]).map((diagnostic) => diagnostic.code))
      .toContain("save_to_type_mismatch");
  });

  it("refuses an attribute treated as proof, since the value is what the visitor typed", () => {
    expect(saveDiagnostics([slot("tier", "text", { saveTo: conversation("plan") })])).toEqual([
      expect.objectContaining({ code: "save_to_attribute_signed", location: "slot:tier.saveTo" }),
    ]);
  });

  it("saves a sensitive slot only to a Private attribute, and any slot to a Private attribute", () => {
    expect(saveDiagnostics([slot("injury", "text", { sensitivity: "sensitive", saveTo: conversation("guest_note") })])).toEqual([
      expect.objectContaining({ code: "save_to_sensitive_slot_not_private", location: "slot:injury.saveTo" }),
    ]);
    expect(saveDiagnostics([
      slot("injury", "text", { sensitivity: "sensitive", saveTo: conversation("health_note") }),
    ])).toEqual([]);
    expect(saveDiagnostics([slot("note", "text", { saveTo: conversation("health_note") })])).toEqual([]);
  });

  it("refuses two slots saving to one attribute and scope, and allows the same attribute at another scope", () => {
    expect(saveDiagnostics([
      slot("note", "text", { saveTo: conversation("guest_note") }),
      slot("other_note", "text", { saveTo: conversation("guest_note") }),
    ])).toEqual([
      expect.objectContaining({ code: "save_to_duplicate_target", location: "slot:other_note.saveTo" }),
    ]);
    expect(saveDiagnostics([
      slot("note", "text", { saveTo: conversation("guest_note") }),
      slot("other_note", "text", { saveTo: { contextVariable: "guest_note", scope: "person" } }),
    ])).toEqual([]);
  });

  it("checks only the duplicate rule where the agent's attributes are not known, as on the compile path", () => {
    expect(saveDiagnostics([slot("guests", "number", { saveTo: conversation("party") })], null)).toEqual([]);
  });

  it("names the slot in the safe message a caller shows, never the attribute's authored text", () => {
    const [diagnostic] = saveDiagnostics([slot("guests", "text", { saveTo: conversation("party_size") })]);
    expect(toSafeRoutineValidationDiagnostic(diagnostic).message).toContain('"guests"');
  });
});
