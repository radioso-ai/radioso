import { describe, expect, it } from "vitest";

import { authoredDirectiveToDirective } from "../../src/modules/agents/authoredDirectiveMapper.js";
import { authoredDirectiveInputSchema } from "../../src/modules/agents/authoredDirectives.js";

const parse = (input: Record<string, unknown>) =>
  authoredDirectiveInputSchema.parse({
    name: "no-price-suggestions",
    condition: { kind: "always" },
    action: "Never suggest a follow-up question about price.",
    ...input,
  });

describe("authored directive surface scope", () => {
  it("defaults to an empty scope, which the renderer reads as the answering voice", () => {
    expect(parse({}).surfaces).toEqual([]);
  });

  it("accepts the generation surfaces an operator can address", () => {
    expect(parse({ surfaces: ["suggested_questions"] }).surfaces).toEqual(["suggested_questions"]);
    expect(parse({ surfaces: ["answer", "suggested_questions"] }).surfaces).toEqual([
      "answer",
      "suggested_questions",
    ]);
  });

  it("deduplicates a repeated surface", () => {
    expect(parse({ surfaces: ["answer", "answer"] }).surfaces).toEqual(["answer"]);
  });

  it("rejects a surface outside the vocabulary", () => {
    expect(() => parse({ surfaces: ["greeting"] })).toThrow();
  });

  it("carries the scope onto the directive the engine matches", () => {
    const directive = authoredDirectiveToDirective(parse({ surfaces: ["suggested_questions"] }));

    expect(directive.surfaces).toEqual(["suggested_questions"]);
  });

  it("leaves the scope off the directive when none is authored", () => {
    expect(authoredDirectiveToDirective(parse({})).surfaces).toBeUndefined();
  });
});
