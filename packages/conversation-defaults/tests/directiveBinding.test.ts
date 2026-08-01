import { describe, expect, it } from "vitest";

import {
  DEFAULT_DIRECTIVE_PRIORITY,
  directiveMatchConfidence,
  directiveMatchPriority,
  resolveDirectiveBinding,
  type DirectiveMatch,
} from "../src/index.js";

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
    ...(skillName ? { binding: { kind: "skill" as const, skillName } } : {}),
    ...directive,
  },
  selectionMode: "deterministic",
  selectionReason: "always",
  ...rest,
});

describe("directive match ranking primitives", () => {
  it("reads an unset priority as the neutral default rather than zero", () => {
    expect(DEFAULT_DIRECTIVE_PRIORITY).toBe(50);
    expect(directiveMatchPriority(match({ name: "unset" }))).toBe(50);
    expect(directiveMatchPriority(match({ name: "low", directive: { priority: 10 } }))).toBe(10);
    expect(directiveMatchPriority(match({ name: "unset" }))).toBeGreaterThan(
      directiveMatchPriority(match({ name: "low", directive: { priority: 10 } })),
    );
  });

  it("reads deterministic matches as fully confident and unscored probabilistic matches as zero", () => {
    expect(directiveMatchConfidence(match({ name: "always" }))).toBe(1);
    expect(
      directiveMatchConfidence(match({ name: "scored", selectionMode: "probabilistic", selectionConfidence: 0.4 })),
    ).toBe(0.4);
    expect(directiveMatchConfidence(match({ name: "unscored", selectionMode: "probabilistic" }))).toBe(0);
  });
});

describe("resolveDirectiveBinding", () => {
  it("selects a bound matched directive when its skill is registered and enabled", () => {
    const result = resolveDirectiveBinding({
      matches: [match({ name: "order-status", skillName: "order_lookup" })],
      registeredTurnSkillNames: new Set(["order_lookup", "retrieval.answer"]),
      agentSkillStates: new Map([
        ["order_lookup", { enabled: true, turnCapable: true, stagingCapable: false }],
      ]),
    });

    expect(result.winner).toEqual({ directiveName: "order-status", skillName: "order_lookup" });
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

  it("lets authored priority dominate matcher confidence", () => {
    const result = resolveDirectiveBinding({
      matches: [
        match({
          name: "low-priority-certain",
          skillName: "low",
          directive: { priority: 10 },
          selectionMode: "probabilistic",
          selectionConfidence: 1,
        }),
        match({
          name: "high-priority-unsure",
          skillName: "high",
          directive: { priority: 80 },
          selectionMode: "probabilistic",
          selectionConfidence: 0.1,
        }),
      ],
      registeredTurnSkillNames: new Set(["low", "high"]),
    });

    expect(result.winner).toEqual({ directiveName: "high-priority-unsure", skillName: "high" });
    expect(result.losers).toEqual([{ directiveName: "low-priority-certain", skillName: "low" }]);
  });

  it("breaks priority ties with confidence and confidence ties with directive name", () => {
    const result = resolveDirectiveBinding({
      matches: [
        match({
          name: "zulu",
          skillName: "zulu_skill",
          directive: { priority: 80 },
          selectionMode: "deterministic",
        }),
        match({
          name: "bravo",
          skillName: "bravo_skill",
          directive: { priority: 80 },
          selectionMode: "probabilistic",
          selectionConfidence: 0.5,
        }),
        match({
          name: "alpha",
          skillName: "alpha_skill",
          directive: { priority: 80 },
          selectionMode: "deterministic",
        }),
      ],
      registeredTurnSkillNames: new Set(["zulu_skill", "bravo_skill", "alpha_skill"]),
    });

    expect(result.winner).toEqual({ directiveName: "alpha", skillName: "alpha_skill" });
    expect(result.losers.map((loser) => loser.directiveName)).toEqual(["zulu", "bravo"]);
  });

  it("ranks an unprioritised directive above an explicitly low-priority one", () => {
    const result = resolveDirectiveBinding({
      matches: [
        match({ name: "low-priority", skillName: "low", directive: { priority: 10 } }),
        match({ name: "default-priority", skillName: "defaulted" }),
      ],
      registeredTurnSkillNames: new Set(["low", "defaulted"]),
    });

    expect(result.winner).toEqual({ directiveName: "default-priority", skillName: "defaulted" });
    expect(result.losers).toEqual([{ directiveName: "low-priority", skillName: "low" }]);
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
        ["disabled_skill", { enabled: false, turnCapable: true, stagingCapable: false }],
        ["routine_skill", { enabled: true, turnCapable: false, stagingCapable: false }],
      ]),
    });

    expect(result.skipped).toEqual([
      { directiveName: "disabled", skillName: "disabled_skill", reason: "skill_not_enabled" },
      { directiveName: "missing", skillName: "missing_skill", reason: "skill_not_registered" },
      { directiveName: "routine-only", skillName: "routine_skill", reason: "skill_not_turn_capable" },
    ]);
    expect(result.winner).toBeUndefined();
  });

  it("skips bound skills whose required capability the host denies", () => {
    const result = resolveDirectiveBinding({
      matches: [match({ name: "order-status", skillName: "order_lookup" })],
      registeredTurnSkillNames: new Set([]),
      agentSkillStates: new Map([
        ["order_lookup", { enabled: true, turnCapable: true, stagingCapable: false, capabilityDenied: true }],
      ]),
    });

    expect(result.skipped).toEqual([
      { directiveName: "order-status", skillName: "order_lookup", reason: "skill_capability_denied" },
    ]);
    expect(result.winner).toBeUndefined();
  });

  it("leaves staging-capable, non-turn-capable bindings out of terminal selection entirely", () => {
    const result = resolveDirectiveBinding({
      matches: [match({ name: "lookup-docs", skillName: "grounded_search" })],
      registeredTurnSkillNames: new Set(["retrieval.answer"]),
      agentSkillStates: new Map([
        ["grounded_search", { enabled: true, turnCapable: false, stagingCapable: true }],
      ]),
    });

    expect(result).toEqual({ winner: undefined, losers: [], skipped: [] });
  });

  it("populates losers and skipped independently in one resolution", () => {
    const result = resolveDirectiveBinding({
      matches: [
        match({ name: "winner", skillName: "lookup", directive: { priority: 90 } }),
        match({ name: "loser", skillName: "other", directive: { priority: 80 } }),
        match({ name: "duplicate", skillName: "lookup", directive: { priority: 70 } }),
        match({ name: "skipped", skillName: "ghost", directive: { priority: 60 } }),
      ],
      registeredTurnSkillNames: new Set(["lookup", "other"]),
    });

    expect(result.winner).toEqual({ directiveName: "winner", skillName: "lookup" });
    expect(result.losers).toEqual([{ directiveName: "loser", skillName: "other" }]);
    expect(result.skipped).toEqual([
      { directiveName: "skipped", skillName: "ghost", reason: "skill_not_registered" },
    ]);
  });
});
