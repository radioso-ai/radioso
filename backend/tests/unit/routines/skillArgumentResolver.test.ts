import { describe, expect, it } from "vitest";

import { resolveSkillArguments } from "../../../src/modules/routines/skillArgumentResolver.js";

describe("resolveSkillArguments", () => {
  it("resolves literal and variableRef input bindings by skill input key", () => {
    const collected = resolveSkillArguments(
      {
        message: { kind: "variableRef", ref: "userMessage" },
        urgent: { kind: "literal", value: true },
        count: { kind: "literal", value: 2 },
      },
      { userMessage: "hello", ignored: "not forwarded" },
    );

    expect(collected).toEqual({ message: "hello", urgent: true, count: 2 });
  });

  it("omits variableRef bindings whose variable is absent or undefined", () => {
    const collected = resolveSkillArguments(
      {
        present: { kind: "variableRef", ref: "present" },
        missing: { kind: "variableRef", ref: "missing" },
        undefinedValue: { kind: "variableRef", ref: "undefinedValue" },
      },
      { present: "yes", undefinedValue: undefined },
    );

    expect(collected).toEqual({ present: "yes" });
  });

  it("returns an empty collected map when there are no input bindings", () => {
    expect(resolveSkillArguments(undefined, { message: "hello" })).toEqual({});
  });
});
