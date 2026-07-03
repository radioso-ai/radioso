import { describe, expect, it } from "vitest";

import type { DirectiveMatch } from "@radioso/conversation-contract";
import {
  resolveDirectiveBinding,
} from "../../src/modules/chat/services/directiveBindingResolution.js";

type MatchOverrides = Partial<Omit<DirectiveMatch, "directive">> & {
  name: string;
  skillName?: string;
  directive?: Partial<DirectiveMatch["directive"]>;
};

const match = ({ name, skillName, directive, ...rest }: MatchOverrides): DirectiveMatch => ({
  directive: {
    name,
    condition: { kind: "always" },
    action: "Use the bound skill.",
    ...(skillName ? { binding: { kind: "skill", skillName } } : {}),
    ...directive,
  },
  selectionMode: "deterministic",
  selectionReason: "always",
  ...rest,
});

describe("resolveDirectiveBinding", () => {
  it("selects a bound matched directive when its skill is registered and enabled", () => {
    const result = resolveDirectiveBinding({
      matches: [match({ name: "order-status", skillName: "order_lookup" })],
      registeredTurnSkillNames: new Set(["order_lookup", "retrieval.answer"]),
      agentSkillStates: new Map([
        ["order_lookup", { enabled: true, turnCapable: true }],
      ]),
    });

    expect(result.winner).toEqual({
      directiveName: "order-status",
      skillName: "order_lookup",
    });
    expect(result.losers).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("ignores matched directives without bindings", () => {
    const result = resolveDirectiveBinding({
      matches: [match({ name: "tone" })],
      registeredTurnSkillNames: new Set(["retrieval.answer"]),
    });

    expect(result).toEqual({ winner: undefined, losers: [], skipped: [] });
  });

  it("orders conflicts by priority, default priority, confidence, deterministic certainty, and directive name", () => {
    const result = resolveDirectiveBinding({
      matches: [
        match({ name: "low-priority", skillName: "low", directive: { priority: 10 }, selectionMode: "probabilistic", selectionConfidence: 0.99 }),
        match({ name: "default-priority", skillName: "defaulted", directive: { priority: undefined }, selectionMode: "probabilistic", selectionConfidence: 0.99 }),
        match({ name: "high-contextual", skillName: "contextual", directive: { priority: 80 }, selectionMode: "probabilistic", selectionConfidence: 0.9 }),
        match({ name: "high-always", skillName: "always", directive: { priority: 80 }, selectionMode: "deterministic" }),
        match({ name: "alpha", skillName: "alpha_skill", directive: { priority: 80 }, selectionMode: "deterministic" }),
      ],
      registeredTurnSkillNames: new Set(["low", "defaulted", "contextual", "always", "alpha_skill"]),
    });

    expect(result.winner).toEqual({ directiveName: "alpha", skillName: "alpha_skill" });
    expect(result.losers.map((loser) => loser.directiveName)).toEqual([
      "high-always",
      "high-contextual",
      "default-priority",
      "low-priority",
    ]);
  });

  it("does not record a conflict when a lower-ranked directive binds the winning skill", () => {
    const result = resolveDirectiveBinding({
      matches: [
        match({ name: "first", skillName: "lookup", directive: { priority: 80 } }),
        match({ name: "second", skillName: "lookup", directive: { priority: 10 } }),
      ],
      registeredTurnSkillNames: new Set(["lookup"]),
    });

    expect(result.winner).toEqual({ directiveName: "first", skillName: "lookup" });
    expect(result.losers).toEqual([]);
  });

  it("classifies unavailable bound skills as skipped", () => {
    const result = resolveDirectiveBinding({
      matches: [
        match({ name: "missing", skillName: "missing_skill" }),
        match({ name: "disabled", skillName: "disabled_skill" }),
        match({ name: "routine-only", skillName: "routine_skill" }),
      ],
      registeredTurnSkillNames: new Set(["disabled_skill", "routine_skill"]),
      agentSkillStates: new Map([
        ["disabled_skill", { enabled: false, turnCapable: true }],
        ["routine_skill", { enabled: true, turnCapable: false }],
      ]),
    });

    expect(result.skipped).toEqual([
      { directiveName: "disabled", skillName: "disabled_skill", reason: "skill_not_enabled" },
      { directiveName: "missing", skillName: "missing_skill", reason: "skill_not_registered" },
      { directiveName: "routine-only", skillName: "routine_skill", reason: "skill_not_turn_capable" },
    ]);
    expect(result.winner).toBeUndefined();
  });
});
