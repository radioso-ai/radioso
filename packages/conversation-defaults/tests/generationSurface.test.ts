import { describe, expect, it } from "vitest";

import { directiveToSteeringRule, steeringForSurface } from "../src/domain.js";
import type { Directive, DirectiveMatch, SteeringRule } from "../src/domain.js";

const rule = (action: string, surfaces?: SteeringRule["surfaces"]): SteeringRule => ({
  action,
  source: "directive",
  lifespan: "response",
  ...(surfaces ? { surfaces } : {}),
});

const match = (directive: Partial<Directive>): DirectiveMatch => ({
  directive: {
    name: "d",
    condition: { kind: "always" },
    action: "Do the thing.",
    ...directive,
  },
  selectionMode: "deterministic",
  selectionReason: "test",
});

describe("steeringForSurface", () => {
  it("treats an unscoped rule as addressed to the answer body only", () => {
    const rules = [rule("Speak warmly.")];

    expect(steeringForSurface(rules, "answer")).toEqual(rules);
    expect(steeringForSurface(rules, "suggested_questions")).toEqual([]);
  });

  it("treats an empty scope the same as an absent one", () => {
    const rules = [rule("Speak warmly.", [])];

    expect(steeringForSurface(rules, "answer")).toEqual(rules);
    expect(steeringForSurface(rules, "suggested_questions")).toEqual([]);
  });

  it("keeps a rule only for the surfaces it names", () => {
    const rules = [rule("Never suggest a question about price.", ["suggested_questions"])];

    expect(steeringForSurface(rules, "answer")).toEqual([]);
    expect(steeringForSurface(rules, "suggested_questions")).toEqual(rules);
  });

  it("keeps a rule scoped to several surfaces on each of them", () => {
    const rules = [rule("Never mention price.", ["answer", "suggested_questions"])];

    expect(steeringForSurface(rules, "answer")).toEqual(rules);
    expect(steeringForSurface(rules, "suggested_questions")).toEqual(rules);
  });
});

describe("directiveToSteeringRule", () => {
  it("carries the authored surface scope onto the steering rule", () => {
    expect(directiveToSteeringRule(match({ surfaces: ["suggested_questions"] })).surfaces).toEqual([
      "suggested_questions",
    ]);
  });

  it("leaves the scope absent when the directive does not name one", () => {
    expect(directiveToSteeringRule(match({})).surfaces).toBeUndefined();
  });
});
