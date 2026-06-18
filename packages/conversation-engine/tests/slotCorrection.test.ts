import { describe, expect, it } from "vitest";

import type { RoutineSlotSchema } from "@radioso/conversation-contract";

import { verifySlotCorrection } from "../src/index.js";

const slots: RoutineSlotSchema[] = [
  { id: "s_email", key: "email", type: "email", required: true, mutable: true },
  { id: "s_count", key: "count", type: "number", required: false, mutable: true },
  { id: "s_optin", key: "optin", type: "boolean", required: false, mutable: true },
  { id: "s_when", key: "when", type: "date", required: false, mutable: true },
  { id: "s_note", key: "note", type: "text", required: false, mutable: true },
  { id: "s_locked", key: "locked", type: "text", required: true, mutable: false },
  { id: "s_legacy", key: "legacy", type: "text", required: true },
];

describe("verifySlotCorrection", () => {
  it("accepts a valid value for a mutable slot and coerces by type", () => {
    expect(verifySlotCorrection({ slots, slotKey: "email", rawValue: "  new@example.com " }))
      .toEqual({ ok: true, key: "email", value: "new@example.com" });
    expect(verifySlotCorrection({ slots, slotKey: "count", rawValue: "42" }))
      .toEqual({ ok: true, key: "count", value: 42 });
    expect(verifySlotCorrection({ slots, slotKey: "optin", rawValue: "TRUE" }))
      .toEqual({ ok: true, key: "optin", value: true });
    expect(verifySlotCorrection({ slots, slotKey: "optin", rawValue: "false" }))
      .toEqual({ ok: true, key: "optin", value: false });
    expect(verifySlotCorrection({ slots, slotKey: "when", rawValue: "2026-06-18" }))
      .toEqual({ ok: true, key: "when", value: "2026-06-18" });
    expect(verifySlotCorrection({ slots, slotKey: "note", rawValue: "anything goes" }))
      .toEqual({ ok: true, key: "note", value: "anything goes" });
  });

  it("rejects a slot that is not declared", () => {
    expect(verifySlotCorrection({ slots, slotKey: "missing", rawValue: "x" }))
      .toEqual({ ok: false, reason: "unknown_slot" });
  });

  it("rejects an immutable slot, including legacy slots with no mutable flag", () => {
    expect(verifySlotCorrection({ slots, slotKey: "locked", rawValue: "x" }))
      .toEqual({ ok: false, reason: "immutable" });
    expect(verifySlotCorrection({ slots, slotKey: "legacy", rawValue: "x" }))
      .toEqual({ ok: false, reason: "immutable" });
  });

  it("rejects a value that fails its declared type", () => {
    expect(verifySlotCorrection({ slots, slotKey: "email", rawValue: "not-an-email" }))
      .toEqual({ ok: false, reason: "invalid_value" });
    expect(verifySlotCorrection({ slots, slotKey: "count", rawValue: "twelve" }))
      .toEqual({ ok: false, reason: "invalid_value" });
    expect(verifySlotCorrection({ slots, slotKey: "optin", rawValue: "maybe" }))
      .toEqual({ ok: false, reason: "invalid_value" });
    expect(verifySlotCorrection({ slots, slotKey: "when", rawValue: "June 18" }))
      .toEqual({ ok: false, reason: "invalid_value" });
    expect(verifySlotCorrection({ slots, slotKey: "note", rawValue: "   " }))
      .toEqual({ ok: false, reason: "invalid_value" });
  });

  it("checks existence before mutability before value", () => {
    // An immutable slot with an invalid value still reports immutable, not invalid_value.
    expect(verifySlotCorrection({ slots, slotKey: "locked", rawValue: "" }))
      .toEqual({ ok: false, reason: "immutable" });
  });
});
