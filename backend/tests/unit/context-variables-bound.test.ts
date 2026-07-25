import { describe, expect, it } from "vitest";

import { boundContextVariableFragments } from "../../src/modules/context-variables/public.js";

const fragment = (name: string, value: string, prefix = `- ${name}: `) => ({ name, prefix, value });

describe("boundContextVariableFragments", () => {
  it("preserves input order while clamping individual values before applying caps", () => {
    const result = boundContextVariableFragments(
      [fragment("first", "x".repeat(40)), fragment("second", "ok")],
      { maxRenderedVariables: 10, perValueMaxChars: 20, sectionTokenBudget: 1_000 },
    );

    expect(result.kept.map((entry) => entry.name)).toEqual(["first", "second"]);
    expect(result.kept[0]?.value).toBe("x".repeat(7) + "… [truncated]");
    expect(result.clamped).toEqual([
      { variableName: "first", originalChars: 40, retainedChars: 20 },
    ]);
    expect(result.dropped).toEqual([]);
  });

  it("applies the count cap before the token budget and records held-back names", () => {
    const result = boundContextVariableFragments(
      [fragment("first", "a"), fragment("second", "b"), fragment("third", "c")],
      { maxRenderedVariables: 2, perValueMaxChars: 100, sectionTokenBudget: 1_000 },
    );

    expect(result.kept.map((entry) => entry.name)).toEqual(["first", "second"]);
    expect(result.dropped).toEqual([{ variableName: "third", reason: "count_cap" }]);
  });

  it("greedily fills the token budget in input order and drops overflow plus lower entries whole", () => {
    const result = boundContextVariableFragments(
      [
        fragment("first", "a".repeat(20), ""),
        fragment("second", "b".repeat(20), ""),
        fragment("third", "c", ""),
      ],
      { maxRenderedVariables: 10, perValueMaxChars: 100, sectionTokenBudget: 6 },
    );

    expect(result.kept.map((entry) => entry.name)).toEqual(["first"]);
    expect(result.dropped).toEqual([
      { variableName: "second", reason: "token_budget" },
      { variableName: "third", reason: "token_budget" },
    ]);
  });

  it("keeps the first entry when it alone exceeds the token budget", () => {
    const result = boundContextVariableFragments(
      [fragment("huge", "x".repeat(100), ""), fragment("small", "y", "")],
      { maxRenderedVariables: 10, perValueMaxChars: 100, sectionTokenBudget: 2 },
    );

    expect(result.kept.map((entry) => entry.name)).toEqual(["huge"]);
    expect(result.dropped).toEqual([{ variableName: "small", reason: "token_budget" }]);
  });
});
