import { describe, expect, it } from "vitest";

import { checkSlotValue } from "../src/index.js";

describe("checkSlotValue (#1374)", () => {
  it("treats null, undefined, and blank strings as not given, for every type", () => {
    for (const type of ["text", "number", "boolean", "email", "date"] as const) {
      for (const value of [null, undefined, "", "   "]) {
        expect(checkSlotValue(type, value)).toEqual({ ok: false, reason: "empty" });
      }
    }
  });

  it("rejects objects and arrays for every type", () => {
    for (const type of ["text", "number", "boolean", "email", "date"] as const) {
      expect(checkSlotValue(type, { count: 2 })).toEqual({ ok: false, reason: "not_scalar" });
      expect(checkSlotValue(type, ["a@b.co"])).toEqual({ ok: false, reason: "not_scalar" });
    }
  });

  it("keeps text trimmed and states a finite number or a boolean as text", () => {
    expect(checkSlotValue("text", "  Giulia Verdi ")).toEqual({ ok: true, value: "Giulia Verdi" });
    expect(checkSlotValue("text", 12)).toEqual({ ok: true, value: "12" });
    expect(checkSlotValue("text", false)).toEqual({ ok: true, value: "false" });
    expect(checkSlotValue("text", Number.NaN)).toEqual({ ok: false, reason: "type_mismatch" });
  });

  it("accepts a finite number and coerces a decimal numeric string", () => {
    expect(checkSlotValue("number", 2)).toEqual({ ok: true, value: 2 });
    expect(checkSlotValue("number", " 2 ")).toEqual({ ok: true, value: 2 });
    expect(checkSlotValue("number", "-3.5")).toEqual({ ok: true, value: -3.5 });
    for (const value of ["two", "1e3", "0x10", "2 adults", Number.POSITIVE_INFINITY, Number.NaN, true]) {
      expect(checkSlotValue("number", value)).toEqual({ ok: false, reason: "type_mismatch" });
    }
  });

  it("accepts a boolean and coerces the canonical true/false tokens", () => {
    expect(checkSlotValue("boolean", true)).toEqual({ ok: true, value: true });
    expect(checkSlotValue("boolean", " TRUE ")).toEqual({ ok: true, value: true });
    expect(checkSlotValue("boolean", "false")).toEqual({ ok: true, value: false });
    for (const value of ["yes", "si", 1, 0]) {
      expect(checkSlotValue("boolean", value)).toEqual({ ok: false, reason: "type_mismatch" });
    }
  });

  it("accepts only a string shaped like an email address", () => {
    expect(checkSlotValue("email", " giulia.verdi@example.com ")).toEqual({ ok: true, value: "giulia.verdi@example.com" });
    for (const value of ["<script>alert(1)</script>", "giulia at example dot com", "a@b", 42]) {
      expect(checkSlotValue("email", value)).toEqual({ ok: false, reason: "type_mismatch" });
    }
  });

  it("accepts only a YYYY-MM-DD string that is a real calendar date", () => {
    expect(checkSlotValue("date", "2026-11-11")).toEqual({ ok: true, value: "2026-11-11" });
    for (const value of ["not-a-date", "2026-02-31", "11/11/2026", "2026-11-11T10:00:00Z", "11 novembre", 20261111]) {
      expect(checkSlotValue("date", value)).toEqual({ ok: false, reason: "type_mismatch" });
    }
  });

  it("returns an accepted value unchanged when checked again", () => {
    const cases = [
      ["text", " Giulia "],
      ["text", 3],
      ["number", "2"],
      ["boolean", "TRUE"],
      ["email", " a@b.co "],
      ["date", "2026-11-11"],
    ] as const;
    for (const [type, raw] of cases) {
      const first = checkSlotValue(type, raw);
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(checkSlotValue(type, first.value)).toEqual(first);
      }
    }
  });
});
