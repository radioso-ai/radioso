import { describe, expect, it } from "vitest";

import {
  boundSteeringMatches,
  defaultAnswerDirectives,
} from "../../src/modules/directives/public.js";
import type { DirectiveMatch } from "../../src/modules/directives/public.js";
import { DIRECTIVES_BEHAVIOR } from "../../src/shared/domain/behaviorConfig.js";

const match = (
  name: string,
  overrides: {
    priority?: number;
    confidence?: number;
    deterministic?: boolean;
    action?: string;
  } = {},
): DirectiveMatch => ({
  directive: {
    name,
    condition: overrides.deterministic
      ? { kind: "always" }
      : { kind: "contextual", description: `when ${name} applies` },
    action: overrides.action ?? `do ${name}`,
    ...(overrides.priority === undefined ? {} : { priority: overrides.priority }),
  },
  selectionMode: overrides.deterministic ? "deterministic" : "probabilistic",
  selectionReason: "test",
  ...(overrides.confidence === undefined ? {} : { selectionConfidence: overrides.confidence }),
});

const generous = { maxRenderedDirectives: 100, renderedTokenBudget: 1_000_000 };

describe("boundSteeringMatches", () => {
  it("keeps everything and drops nothing when both caps are generous", () => {
    const result = boundSteeringMatches([match("a"), match("b")], generous);
    expect(result.kept.map((m) => m.directive.name).sort()).toEqual(["a", "b"]);
    expect(result.dropped).toEqual([]);
  });

  it("ranks by confidence × priority and caps at top-k, recording the rest", () => {
    const matches = [
      match("low", { priority: 10, confidence: 0.9 }), // score 9
      match("high", { priority: 90, confidence: 0.9 }), // score 81
      match("mid", { priority: 80, confidence: 0.5 }), // score 40
    ];
    const result = boundSteeringMatches(matches, {
      maxRenderedDirectives: 2,
      renderedTokenBudget: 1_000_000,
    });
    expect(result.kept.map((m) => m.directive.name)).toEqual(["high", "mid"]);
    expect(result.dropped).toEqual([{ directiveName: "low", reason: "top_k" }]);
  });

  it("does not count always directives against the contextual top-k cap", () => {
    const matches = [
      match("probable", { priority: 90, confidence: 0.4 }), // score 36
      match("always-a", { priority: 90, deterministic: true }),
      match("always-b", { priority: 80, deterministic: true }),
    ];
    const result = boundSteeringMatches(matches, {
      maxRenderedDirectives: 1,
      renderedTokenBudget: 1_000_000,
    });
    expect(result.kept.map((m) => m.directive.name)).toEqual(["probable", "always-a", "always-b"]);
    expect(result.dropped).toEqual([]);
  });

  it("does not charge always directives to the contextual token budget", () => {
    const matches = [
      match("always", { priority: 90, deterministic: true, action: "a".repeat(4_000) }),
      match("contextual-first", { priority: 80, confidence: 1, action: "x".repeat(160) }),
      match("contextual-second", { priority: 70, confidence: 1, action: "y".repeat(160) }),
    ];
    const result = boundSteeringMatches(matches, {
      maxRenderedDirectives: 100,
      renderedTokenBudget: 55,
    });
    expect(result.kept.map((m) => m.directive.name)).toEqual(["always", "contextual-first"]);
    expect(result.dropped).toEqual([
      { directiveName: "contextual-second", reason: "token_budget" },
    ]);
  });

  it("keeps matched dependencies of always directives outside the contextual caps", () => {
    const dependency = match("contextual-dependency", {
      priority: 1,
      confidence: 1,
      action: "x".repeat(160),
    });
    const mandatory: DirectiveMatch = {
      ...match("always-dependent", { priority: 90, deterministic: true }),
      directive: {
        ...match("always-dependent", { priority: 90, deterministic: true }).directive,
        dependsOn: ["contextual-dependency"],
      },
    };
    const optional = match("higher-ranked-contextual", { priority: 90, confidence: 1 });

    const result = boundSteeringMatches([dependency, mandatory, optional], {
      maxRenderedDirectives: 0,
      renderedTokenBudget: 1,
    });

    expect(result.kept.map((m) => m.directive.name)).toEqual([
      "contextual-dependency",
      "always-dependent",
    ]);
    expect(result.dropped).toEqual([
      { directiveName: "higher-ranked-contextual", reason: "top_k" },
    ]);
  });

  it("defaults an unset priority to a neutral weight rather than zero", () => {
    const matches = [
      match("zeroish", { priority: 1, confidence: 1 }), // score 1
      match("neutral", { confidence: 1 }), // score 50 (default priority)
    ];
    const result = boundSteeringMatches(matches, {
      maxRenderedDirectives: 1,
      renderedTokenBudget: 1_000_000,
    });
    expect(result.kept.map((m) => m.directive.name)).toEqual(["neutral"]);
  });

  it("fills the token budget in rank order and drops overflow as token_budget", () => {
    // ~40 tokens each (160 chars / 4). Budget of 90 fits two, not three.
    const action = "x".repeat(160);
    const matches = [
      match("first", { priority: 90, confidence: 1, action }),
      match("second", { priority: 80, confidence: 1, action }),
      match("third", { priority: 70, confidence: 1, action }),
    ];
    const result = boundSteeringMatches(matches, {
      maxRenderedDirectives: 100,
      renderedTokenBudget: 90,
    });
    expect(result.kept.map((m) => m.directive.name)).toEqual(["first", "second"]);
    expect(result.dropped).toEqual([{ directiveName: "third", reason: "token_budget" }]);
  });

  it("always renders the top-ranked directive even if it alone exceeds the budget", () => {
    const matches = [
      match("huge", { priority: 90, confidence: 1, action: "x".repeat(4000) }),
      match("small", { priority: 80, confidence: 1, action: "y" }),
    ];
    const result = boundSteeringMatches(matches, {
      maxRenderedDirectives: 100,
      renderedTokenBudget: 10,
    });
    expect(result.kept.map((m) => m.directive.name)).toEqual(["huge"]);
    expect(result.dropped).toEqual([{ directiveName: "small", reason: "token_budget" }]);
  });

  it("never bounds always directives, including substantial authored correctness rules", () => {
    const builtIns = defaultAnswerDirectives.map((directive) => ({
      directive,
      selectionMode: "deterministic" as const,
      selectionReason: "built-in always directive",
    }));
    const matches = [
      ...builtIns,
      match("authored-concise-next-step", {
        priority: 70,
        deterministic: true,
        action: "x".repeat(365),
      }),
      match("authored-channel-policy", {
        priority: 70,
        deterministic: true,
        action: "x".repeat(330),
      }),
      match("authored-correctness-guard", {
        priority: 70,
        deterministic: true,
        action: "x".repeat(2_467),
      }),
    ];

    const result = boundSteeringMatches(matches, DIRECTIVES_BEHAVIOR.steeringBound);

    expect(result.kept.map((candidate) => candidate.directive.name)).toEqual(
      matches.map((candidate) => candidate.directive.name),
    );
    expect(result.dropped).toEqual([]);
  });

  it("uses a 2,400-token contextual steering allowance by default", () => {
    expect(DIRECTIVES_BEHAVIOR.steeringBound.renderedTokenBudget).toBe(2_400);
  });

  it("returns survivors in input order so equal-priority ties stay stable", () => {
    // Same default priority and confidence → equal score. Membership ranking must
    // not reorder them: the rendered order must follow registration order [z, a].
    const result = boundSteeringMatches([match("z"), match("a")], generous);
    expect(result.kept.map((m) => m.directive.name)).toEqual(["z", "a"]);
    expect(result.dropped).toEqual([]);
  });

  it("caps equal-score directives by registration order, not name", () => {
    // [z, a] with the same score and a top-1 cap: the earlier-registered `z` must
    // survive; an alphabetical tiebreak would wrongly keep `a`.
    const result = boundSteeringMatches([match("z"), match("a")], {
      maxRenderedDirectives: 1,
      renderedTokenBudget: 1_000_000,
    });
    expect(result.kept.map((m) => m.directive.name)).toEqual(["z"]);
    expect(result.dropped).toEqual([{ directiveName: "a", reason: "top_k" }]);
  });

  it("cascade-drops a survivor whose dependency was bounded out (dependsOn closure)", () => {
    const expert = match("expert", { priority: 10, confidence: 1 }); // low score
    const detail: DirectiveMatch = {
      ...match("detail", { priority: 90, confidence: 1 }), // high score, survives top-k
      directive: { ...match("detail", { priority: 90 }).directive, dependsOn: ["expert"] },
    };
    const result = boundSteeringMatches([expert, detail], {
      maxRenderedDirectives: 1,
      renderedTokenBudget: 1_000_000,
    });
    // `detail` alone would survive the top-1 cap, but its dependency `expert` did
    // not — so `detail` must not render either.
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([
      { directiveName: "expert", reason: "top_k" },
      { directiveName: "detail", reason: "unmet_dependency" },
    ]);
  });

  it("unwinds a broken dependency chain to a fixpoint", () => {
    // a → b → c; c is dropped by the cap, so b then a must also drop.
    const c = match("c", { priority: 5, confidence: 1 });
    const withDep = (name: string, priority: number, dep: string): DirectiveMatch => ({
      ...match(name, { priority, confidence: 1 }),
      directive: { ...match(name, { priority }).directive, dependsOn: [dep] },
    });
    const b = withDep("b", 50, "c");
    const a = withDep("a", 90, "b");
    const result = boundSteeringMatches([c, b, a], {
      maxRenderedDirectives: 2,
      renderedTokenBudget: 1_000_000,
    });
    expect(result.kept).toEqual([]);
    expect(result.dropped.map((d) => d.directiveName).sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps a dependent when its dependency also survives the bound", () => {
    const expert = match("expert", { priority: 90, confidence: 1 });
    const detail: DirectiveMatch = {
      ...match("detail", { priority: 80, confidence: 1 }),
      directive: { ...match("detail", { priority: 80 }).directive, dependsOn: ["expert"] },
    };
    const result = boundSteeringMatches([expert, detail], {
      maxRenderedDirectives: 2,
      renderedTokenBudget: 1_000_000,
    });
    expect(result.kept.map((m) => m.directive.name)).toEqual(["expert", "detail"]);
    expect(result.dropped).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const matches = [match("b", { priority: 10 }), match("a", { priority: 90 })];
    const snapshot = matches.map((m) => m.directive.name);
    boundSteeringMatches(matches, { maxRenderedDirectives: 1, renderedTokenBudget: 1_000_000 });
    expect(matches.map((m) => m.directive.name)).toEqual(snapshot);
  });
});
