import { describe, expect, it } from "vitest";

import {
  contextScopeLadder,
  mayOverwrite,
  type ContextValueWriterKind,
  type ContextVariableOption,
} from "../../src/modules/context-variables/domain.js";
import { validateOptions, validateValue } from "../../src/modules/context-variables/valueValidation.js";

const option = (key: string, archived = false): ContextVariableOption => ({
  key,
  label: key.replace(/_/gu, " "),
  description: null,
  archived,
});

const topic = { valueType: "enum" as const, options: [option("billing"), option("shipping"), option("legacy_plan", true)] };

describe("validateValue", () => {
  it("accepts any JSON for a json variable and only a string for a string variable", () => {
    expect(validateValue({ valueType: "json", options: null }, { items: 2 })).toEqual({ ok: true });
    expect(validateValue({ valueType: "string", options: null }, "gold")).toEqual({ ok: true });
    expect(validateValue({ valueType: "string", options: null }, 3)).toEqual({ ok: false, code: "type_mismatch" });
  });

  it("accepts an enum value only when it is the key of an active option", () => {
    expect(validateValue(topic, "billing")).toEqual({ ok: true });
    expect(validateValue(topic, "Billing")).toEqual({ ok: false, code: "unknown_option" });
    expect(validateValue(topic, "legacy_plan")).toEqual({ ok: false, code: "archived_option" });
    expect(validateValue(topic, { key: "billing" })).toEqual({ ok: false, code: "type_mismatch" });
  });

  it("accepts a JSON boolean for a boolean variable and nothing that only reads like one", () => {
    const flag = { valueType: "boolean" as const, options: null };
    expect(validateValue(flag, true)).toEqual({ ok: true });
    expect(validateValue(flag, false)).toEqual({ ok: true });
    expect(validateValue(flag, "true")).toEqual({ ok: false, code: "type_mismatch" });
    expect(validateValue(flag, 1)).toEqual({ ok: false, code: "type_mismatch" });
  });

  it("accepts a finite JSON number for a number variable", () => {
    const count = { valueType: "number" as const, options: null };
    expect(validateValue(count, 3)).toEqual({ ok: true });
    expect(validateValue(count, -2.5)).toEqual({ ok: true });
    expect(validateValue(count, "3")).toEqual({ ok: false, code: "type_mismatch" });
    expect(validateValue(count, Number.POSITIVE_INFINITY)).toEqual({ ok: false, code: "type_mismatch" });
    expect(validateValue(count, Number.NaN)).toEqual({ ok: false, code: "type_mismatch" });
  });

  it("accepts an ISO calendar date for a date variable, never a time or an impossible day", () => {
    const day = { valueType: "date" as const, options: null };
    expect(validateValue(day, "2026-11-24")).toEqual({ ok: true });
    expect(validateValue(day, "2028-02-29")).toEqual({ ok: true });
    expect(validateValue(day, "2026-02-30")).toEqual({ ok: false, code: "type_mismatch" });
    expect(validateValue(day, "2026-11-24T10:00:00Z")).toEqual({ ok: false, code: "type_mismatch" });
    expect(validateValue(day, "24/11/2026")).toEqual({ ok: false, code: "type_mismatch" });
    expect(validateValue(day, 20261124)).toEqual({ ok: false, code: "type_mismatch" });
  });
});

describe("validateOptions", () => {
  it("requires options for an enum and refuses them for any other type", () => {
    expect(validateOptions("enum", [option("billing")], null)).toEqual({ ok: true });
    expect(validateOptions("enum", null, null)).toEqual({ ok: false, code: "options_required" });
    expect(validateOptions("enum", [], null)).toEqual({ ok: false, code: "options_required" });
    expect(validateOptions("string", [option("billing")], null)).toEqual({ ok: false, code: "options_not_allowed" });
    expect(validateOptions("json", null, null)).toEqual({ ok: true });
  });

  it("holds keys to a letter then letters, digits and underscores, once each, within the option limit", () => {
    expect(validateOptions("enum", [option("needs help")], null)).toEqual({ ok: false, code: "invalid_option_key" });
    expect(validateOptions("enum", [option("9lives")], null)).toEqual({ ok: false, code: "invalid_option_key" });
    expect(validateOptions("enum", [option("_internal")], null)).toEqual({ ok: false, code: "invalid_option_key" });
    expect(validateOptions("enum", [option("tier_2")], null)).toEqual({ ok: true });
    expect(validateOptions("enum", [option("billing"), option("billing")], null))
      .toEqual({ ok: false, code: "duplicate_option_key" });
    // Keys differing only in case would read as one option to a person, so they cannot coexist.
    expect(validateOptions("enum", [option("billing"), option("Billing")], null))
      .toEqual({ ok: false, code: "duplicate_option_key" });
    const many = Array.from({ length: 51 }, (_, index) => option(`option_${index}`));
    expect(validateOptions("enum", many, null)).toEqual({ ok: false, code: "too_many_options" });
    expect(validateOptions("enum", many.slice(0, 50), null)).toEqual({ ok: true });
  });

  it("requires a label and bounds the label and description", () => {
    expect(validateOptions("enum", [{ ...option("billing"), label: " " }], null))
      .toEqual({ ok: false, code: "invalid_option_label" });
    expect(validateOptions("enum", [{ ...option("billing"), label: "x".repeat(121) }], null))
      .toEqual({ ok: false, code: "invalid_option_label" });
    expect(validateOptions("enum", [{ ...option("billing"), description: "x".repeat(301) }], null))
      .toEqual({ ok: false, code: "option_description_too_long" });
    expect(validateOptions("enum", [{ ...option("billing"), description: "x".repeat(300) }], null)).toEqual({ ok: true });
  });

  it("needs at least one option that is not archived, so a value can still be written", () => {
    expect(validateOptions("enum", [option("billing", true)], null)).toEqual({ ok: false, code: "active_option_required" });
    expect(validateOptions("enum", [option("billing", true), option("shipping", true)], [option("billing"), option("shipping")]))
      .toEqual({ ok: false, code: "active_option_required" });
    expect(validateOptions("enum", [option("billing", true), option("shipping")], null)).toEqual({ ok: true });
  });

  it("archives options instead of removing them, so every stored key keeps naming one", () => {
    const previous = [option("billing"), option("shipping")];
    expect(validateOptions("enum", [option("billing")], previous)).toEqual({ ok: false, code: "option_removed" });
    expect(validateOptions("enum", [option("billing"), option("shipping", true), option("returns")], previous))
      .toEqual({ ok: true });
    expect(validateOptions("enum", [{ ...option("billing"), label: "Invoices" }, option("shipping")], previous))
      .toEqual({ ok: true });
  });
});

describe("mayOverwrite", () => {
  const writers: ContextValueWriterKind[] = ["api", "operator", "routine", "classifier"];

  it("lets API, operator and routine writes replace any value", () => {
    for (const incoming of ["api", "operator", "routine"] as const) {
      expect(mayOverwrite(null, incoming)).toBe(true);
      for (const existing of writers) expect(mayOverwrite({ kind: existing, ref: null }, incoming)).toBe(true);
    }
  });

  it("lets the classifier write only over nothing or its own value", () => {
    expect(mayOverwrite(null, "classifier")).toBe(true);
    expect(mayOverwrite({ kind: "classifier", ref: "context-classification@1" }, "classifier")).toBe(true);
    expect(mayOverwrite({ kind: "api", ref: null }, "classifier")).toBe(false);
    expect(mayOverwrite({ kind: "operator", ref: "user-1" }, "classifier")).toBe(false);
    expect(mayOverwrite({ kind: "routine", ref: "routine-1:execution-1" }, "classifier")).toBe(false);
  });
});

describe("contextScopeLadder", () => {
  it("reads the conversation first, then the session, the person, the agent and the workspace", () => {
    expect(contextScopeLadder({
      conversationId: "conversation-1",
      chatSessionId: "session-1",
      verifiedCustomerId: "customer-1",
      agentId: "agent-1",
      workspaceId: "workspace-1",
    })).toEqual([
      { type: "conversation", id: "conversation-1" },
      { type: "session", id: "session-1" },
      { type: "customer", id: "customer-1" },
      { type: "agent", id: "agent-1" },
      { type: "workspace", id: "workspace-1" },
    ]);
  });

  it("skips the keys a turn does not have", () => {
    expect(contextScopeLadder({
      conversationId: null,
      chatSessionId: null,
      verifiedCustomerId: null,
      agentId: "agent-1",
      workspaceId: "workspace-1",
    })).toEqual([
      { type: "agent", id: "agent-1" },
      { type: "workspace", id: "workspace-1" },
    ]);
  });
});
