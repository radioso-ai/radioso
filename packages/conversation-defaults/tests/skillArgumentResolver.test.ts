import { describe, expect, it } from "vitest";

import { resolveSkillArguments, resolveUntypedSkillArguments } from "../src/index.js";

describe("resolveSkillArguments", () => {
  it("records each argument's origin alongside its value", () => {
    const resolved = resolveSkillArguments(
      {
        intro: { kind: "literal", value: "<p>Thanks for writing in.</p>" },
        note: { kind: "variableRef", ref: "visitorNote" },
        page: { kind: "contextVariableRef", contextVariable: "page_title" },
      },
      { visitorNote: "<b>please call</b>" },
      { page_title: "Checkout" },
    );

    expect(resolved).toEqual({
      values: { intro: "<p>Thanks for writing in.</p>", note: "<b>please call</b>", page: "Checkout" },
      origins: { intro: "literal", note: "slot", page: "context" },
    });
  });

  it("counts a routine variable a skill output fills as a slot, since extraction can write any variable name", () => {
    const resolved = resolveSkillArguments(
      { body: { kind: "variableRef", ref: "draftHtml" } },
      { draftHtml: "<p>Drafted by a tool</p>" },
    );

    expect(resolved.origins).toEqual({ body: "slot" });
  });

  it("omits a binding that resolves to undefined from both values and origins", () => {
    const resolved = resolveSkillArguments(
      {
        present: { kind: "variableRef", ref: "present" },
        missingSlot: { kind: "variableRef", ref: "missing" },
        undefinedSlot: { kind: "variableRef", ref: "undefinedValue" },
        missingContext: { kind: "contextVariableRef", contextVariable: "missing" },
      },
      { present: "yes", undefinedValue: undefined },
      {},
    );

    expect(resolved).toEqual({ values: { present: "yes" }, origins: { present: "slot" } });
  });

  it("resolves no bindings to empty values and origins", () => {
    expect(resolveSkillArguments(undefined, { message: "hello" })).toEqual({ values: {}, origins: {} });
  });
});

describe("resolveUntypedSkillArguments", () => {
  it("passes every routine variable through as a slot", () => {
    expect(resolveUntypedSkillArguments({ email: "sam@example.com", note: "<i>hi</i>" })).toEqual({
      values: { email: "sam@example.com", note: "<i>hi</i>" },
      origins: { email: "slot", note: "slot" },
    });
  });
});
