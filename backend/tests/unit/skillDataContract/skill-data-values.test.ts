import { checkSlotValue } from "@radioso/conversation-engine";
import { routineSlotTypes } from "@radioso/routine-definition";
import { describe, expect, it } from "vitest";

import {
  coerceSkillValue,
  skillDataValueTypes,
} from "../../../src/shared/domain/skillDataContract/index.js";

describe("skill data value types", () => {
  it("are the routine slot types without item", () => {
    expect([...skillDataValueTypes].sort()).toEqual(routineSlotTypes.filter((type) => type !== "item").sort());
  });

  it("coerces text from a string as is, and from a finite number or a boolean", () => {
    expect(coerceSkillValue("text", "Lamp", "output")).toEqual({ ok: true, value: "Lamp" });
    expect(coerceSkillValue("text", 12.5, "output")).toEqual({ ok: true, value: "12.5" });
    expect(coerceSkillValue("text", false, "output")).toEqual({ ok: true, value: "false" });
    expect(coerceSkillValue("text", { a: 1 }, "output")).toEqual({ ok: false });
    expect(coerceSkillValue("text", Number.NaN, "output")).toEqual({ ok: false });
  });

  it("coerces a number from a finite number or a plain decimal string", () => {
    expect(coerceSkillValue("number", 3, "input")).toEqual({ ok: true, value: 3 });
    expect(coerceSkillValue("number", "-12", "input")).toEqual({ ok: true, value: -12 });
    expect(coerceSkillValue("number", "12.50", "input")).toEqual({ ok: true, value: 12.5 });
    for (const value of ["1,200", "1e3", "12,5", "0x10", "", "twelve", Number.POSITIVE_INFINITY, true]) {
      expect(coerceSkillValue("number", value, "input"), String(value)).toEqual({ ok: false });
    }
  });

  it("coerces a boolean from a boolean or true/false in any case", () => {
    expect(coerceSkillValue("boolean", true, "output")).toEqual({ ok: true, value: true });
    expect(coerceSkillValue("boolean", "FALSE", "output")).toEqual({ ok: true, value: false });
    expect(coerceSkillValue("boolean", "yes", "output")).toEqual({ ok: false });
    expect(coerceSkillValue("boolean", 1, "output")).toEqual({ ok: false });
  });

  it("normalizes a date to YYYY-MM-DD for an input and keeps a date-time for an output", () => {
    expect(coerceSkillValue("date", "2026-11-21", "input")).toEqual({ ok: true, value: "2026-11-21" });
    expect(coerceSkillValue("date", "2026-11-21T23:30:00+02:00", "input")).toEqual({ ok: true, value: "2026-11-21" });
    expect(coerceSkillValue("date", "2026-11-21", "output")).toEqual({ ok: true, value: "2026-11-21" });
    expect(coerceSkillValue("date", "2026-11-21T23:30:00+02:00", "output")).toEqual({ ok: true, value: "2026-11-21T21:30:00.000Z" });
    for (const value of ["2026-02-30", "21/11/2026", "2026-11-21T25:00:00Z", 1763683200, "tomorrow"]) {
      expect(coerceSkillValue("date", value, "output"), String(value)).toEqual({ ok: false });
    }
  });

  it("trims an email and accepts what the email slot accepts", () => {
    expect(coerceSkillValue("email", "  visitor@example.com ", "input")).toEqual({ ok: true, value: "visitor@example.com" });
    for (const value of ["visitor@example.com", "a.b+c@mail.example.co", "no-at-sign", "a@b", "a b@example.com", "a@example..com"]) {
      expect(coerceSkillValue("email", value, "input").ok, value).toBe(checkSlotValue("email", value).ok);
    }
  });

  it("finds no value in null, undefined or blank text", () => {
    for (const type of skillDataValueTypes) {
      expect(coerceSkillValue(type, null, "input")).toEqual({ ok: false });
      expect(coerceSkillValue(type, undefined, "input")).toEqual({ ok: false });
      expect(coerceSkillValue(type, "   ", "input")).toEqual({ ok: false });
    }
  });
});
