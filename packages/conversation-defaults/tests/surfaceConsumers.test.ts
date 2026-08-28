import { describe, expect, it } from "vitest";

import { DefaultSteeringResolver } from "@radioso/conversation-engine";
import { resolveDirectiveBinding } from "../src/directiveBinding.js";
import type { Directive, DirectiveMatch, SteeringRule } from "../src/domain.js";

const match = (name: string, overrides: Partial<Directive> = {}): DirectiveMatch => ({
  directive: {
    name,
    condition: { kind: "always" },
    action: `${name} action`,
    binding: { kind: "skill", skillName: "order.lookup" },
    ...overrides,
  } as Directive,
  selectionMode: "deterministic",
  selectionReason: "test",
});

const bindingInput = (matches: DirectiveMatch[]) => ({
  matches,
  registeredTurnSkillNames: new Set(["order.lookup"]),
  agentSkillStates: new Map([
    ["order.lookup", { enabled: true, turnCapable: true, stagingCapable: false }],
  ]),
});

describe("resolveDirectiveBinding — generation surface", () => {
  it("lets a directive addressed to the answer pick the answering skill", () => {
    const resolution = resolveDirectiveBinding(bindingInput([match("answer-scoped")]));

    expect(resolution.winner).toEqual({ directiveName: "answer-scoped", skillName: "order.lookup" });
  });

  it("ignores a directive scoped away from the answer", () => {
    const resolution = resolveDirectiveBinding(
      bindingInput([match("suggestion-scoped", { surfaces: ["suggested_questions"] })]),
    );

    expect(resolution.winner).toBeUndefined();
  });

  it("keeps a directive addressed to the answer among other surfaces", () => {
    const resolution = resolveDirectiveBinding(
      bindingInput([match("both", { surfaces: ["answer", "suggested_questions"] })]),
    );

    expect(resolution.winner).toEqual({ directiveName: "both", skillName: "order.lookup" });
  });
});

describe("steering resolution — generation surface identity", () => {
  const rule = (surfaces?: SteeringRule["surfaces"]): SteeringRule => ({
    action: "Stay concise.",
    source: "directive",
    lifespan: "response",
    ...(surfaces ? { surfaces } : {}),
  });

  const resolve = (rules: SteeringRule[]): SteeringRule[] =>
    new DefaultSteeringResolver().resolve(rules, { turnContext: {} as never });

  it("keeps the same action addressed to two generators as two rules", () => {
    const resolved = resolve([rule(), rule(["suggested_questions"])]);

    expect(resolved).toHaveLength(2);
    expect(resolved.map((entry) => entry.surfaces)).toEqual([undefined, ["suggested_questions"]]);
  });

  it("still collapses the same action at the same effective scope", () => {
    expect(resolve([rule(), rule(["answer"])])).toHaveLength(1);
  });
});
