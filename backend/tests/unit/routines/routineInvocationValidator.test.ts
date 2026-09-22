import { describe, expect, it } from "vitest";

import type { AgentToolDescriptor } from "../../../src/modules/routines/exposure/agentToolDescriptor.js";
import {
  ROUTINE_INVOCATION_MAX_STRING_LENGTH,
  validateRoutineInvocation,
} from "../../../src/modules/routines/exposure/routineInvocationValidator.js";

const descriptor: AgentToolDescriptor = {
  toolName: "start_return",
  description: "Start a return.",
  routineLineageId: "lineage-return",
  inputSchema: {
    type: "object",
    properties: {
      orderId: { type: "string" },
      quantity: { type: "number" },
      gift: { type: "boolean" },
      contact: { type: "string", format: "email" },
      purchasedOn: { type: "string", format: "date" },
    },
    required: ["orderId"],
    additionalProperties: false,
  },
};

describe("validateRoutineInvocation", () => {
  it("accepts a full, well-typed input and returns the typed invocation", () => {
    const result = validateRoutineInvocation(descriptor, {
      orderId: "A-1001",
      quantity: 2,
      gift: false,
      contact: "jo@example.com",
      purchasedOn: "2026-09-01",
    });

    expect(result).toEqual({
      ok: true,
      invocation: {
        toolName: "start_return",
        input: { orderId: "A-1001", quantity: 2, gift: false, contact: "jo@example.com", purchasedOn: "2026-09-01" },
      },
    });
  });

  it("accepts only the required slots", () => {
    const result = validateRoutineInvocation(descriptor, { orderId: "A-1001" });

    expect(result).toMatchObject({ ok: true, invocation: { input: { orderId: "A-1001" } } });
  });

  it("reports a missing required field", () => {
    const result = validateRoutineInvocation(descriptor, { quantity: 1 });

    expect(result).toEqual({ ok: false, errors: [{ path: "orderId", code: "required" }] });
  });

  it("reports type mismatches per field", () => {
    const result = validateRoutineInvocation(descriptor, { orderId: 1001, quantity: "two", gift: "yes" });

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "orderId", code: "type" },
        { path: "quantity", code: "type" },
        { path: "gift", code: "type" },
      ],
    });
  });

  it("reports a malformed email or date as a format error", () => {
    const result = validateRoutineInvocation(descriptor, {
      orderId: "A-1001",
      contact: "not-an-email",
      purchasedOn: "1 Sept 2026",
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "contact", code: "format" },
        { path: "purchasedOn", code: "format" },
      ],
    });
  });

  it("refuses a date that is not a real calendar day", () => {
    const result = validateRoutineInvocation(descriptor, { orderId: "A-1001", purchasedOn: "2026-02-30" });

    expect(result).toEqual({ ok: false, errors: [{ path: "purchasedOn", code: "format" }] });
  });

  it("caps every string value at the exported length and reports the overrun per field", () => {
    const atCap = "x".repeat(ROUTINE_INVOCATION_MAX_STRING_LENGTH);
    const overCap = `${atCap}x`;

    expect(validateRoutineInvocation(descriptor, { orderId: atCap })).toMatchObject({ ok: true });
    expect(validateRoutineInvocation(descriptor, { orderId: overCap, contact: `${overCap}@example.com` })).toEqual({
      ok: false,
      errors: [
        { path: "orderId", code: "too_long" },
        { path: "contact", code: "too_long" },
      ],
    });
    expect(ROUTINE_INVOCATION_MAX_STRING_LENGTH).toBe(2000);
  });

  it("reports fields the descriptor does not declare", () => {
    const result = validateRoutineInvocation(descriptor, { orderId: "A-1001", note: "fragile" });

    expect(result).toEqual({ ok: false, errors: [{ path: "note", code: "unknown_field" }] });
  });

  it("treats a non-object input as every required field missing", () => {
    expect(validateRoutineInvocation(descriptor, "A-1001")).toEqual({
      ok: false,
      errors: [{ path: "orderId", code: "required" }],
    });
    expect(validateRoutineInvocation(descriptor, null)).toEqual({
      ok: false,
      errors: [{ path: "orderId", code: "required" }],
    });
  });

  it("trims string values and refuses a blank required one as missing", () => {
    expect(validateRoutineInvocation(descriptor, { orderId: "  A-1001  " })).toEqual({
      ok: true,
      invocation: { toolName: "start_return", input: { orderId: "A-1001" } },
    });
    expect(validateRoutineInvocation(descriptor, { orderId: "   " })).toEqual({
      ok: false,
      errors: [{ path: "orderId", code: "required" }],
    });
  });

  it("drops a blank optional string instead of prefilling the slot with nothing", () => {
    const result = validateRoutineInvocation(descriptor, { orderId: "A-1001", contact: " " });

    expect(result).toEqual({
      ok: true,
      invocation: { toolName: "start_return", input: { orderId: "A-1001" } },
    });
  });

  it("accepts an empty object for a descriptor with no slots", () => {
    const empty: AgentToolDescriptor = {
      ...descriptor,
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    };

    expect(validateRoutineInvocation(empty, {})).toEqual({
      ok: true,
      invocation: { toolName: "start_return", input: {} },
    });
  });
});
