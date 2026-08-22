import { describe, expect, it } from "vitest";

import type { CapabilityCheckInput, CapabilityDecision, CapabilityPolicy } from "../../src/shared/domain/capabilityPolicy.js";
import {
  AlwaysMatchDirectiveMatcher,
  conciseReadableFormattingDirective,
  DirectiveCatalogRegistry,
  DirectiveSteeringService,
  directiveToSteeringRule,
  inlineSupportedLinksDirective,
  type Directive,
  type DirectiveMatch,
  type DirectiveMatcherPort,
} from "../../src/modules/directives/public.js";

const directive = (overrides: Partial<Directive> & Pick<Directive, "name" | "action">): Directive => ({
  condition: { kind: "always" },
  ...overrides,
});

class StubCapabilityPolicy implements CapabilityPolicy {
  constructor(private readonly denied: Set<string> = new Set()) {}
  async can(input: CapabilityCheckInput): Promise<CapabilityDecision> {
    return this.denied.has(String(input.capability))
      ? { allowed: false, reason: "capability_denied" }
      : { allowed: true };
  }
}

const matchAllDirectives: DirectiveMatcherPort = {
  async match({ directives }) {
    return directives.map((candidate) => ({
      directive: candidate,
      selectionMode: "probabilistic" as const,
      selectionReason: "test match",
      selectionConfidence: 1,
    }));
  },
};

describe("DirectiveCatalogRegistry", () => {
  it("registers, lists, and gets directives; rejects duplicates", () => {
    const registry = new DirectiveCatalogRegistry([directive({ name: "be-concise", action: "be concise" })]);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("be-concise")?.action).toBe("be concise");
    expect(() => registry.register(directive({ name: "be-concise", action: "x" }))).toThrow(/already registered/);
  });
});

describe("AlwaysMatchDirectiveMatcher", () => {
  it("matches `always` directives deterministically and skips `contextual` ones", async () => {
    const matcher = new AlwaysMatchDirectiveMatcher();
    const matches = await matcher.match({
      turnContext: {},
      directives: [
        directive({ name: "standing", action: "always do X" }),
        directive({ name: "conditional", action: "do Y", condition: { kind: "contextual", description: "when angry" } }),
      ],
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]!.directive.name).toBe("standing");
    expect(matches[0]!.selectionMode).toBe("deterministic");
    expect(matches[0]!.selectionReason).toBeTruthy();
  });
});

describe("directiveToSteeringRule", () => {
  it("maps a match to a directive-sourced, response-lifespan SteeringRule", () => {
    const match: DirectiveMatch = {
      directive: directive({ name: "d", action: "slow down", priority: 3 }),
      selectionMode: "deterministic",
      selectionReason: "always",
    };
    const rule = directiveToSteeringRule(match);
    expect(rule).toMatchObject({ action: "slow down", priority: 3, source: "directive", lifespan: "response" });
  });

  it("carries a contextual condition's description onto the rule", () => {
    const rule = directiveToSteeringRule({
      directive: directive({ name: "d", action: "escalate", condition: { kind: "contextual", description: "refund dispute" } }),
      selectionMode: "probabilistic",
      selectionReason: "matched",
    });
    expect(rule.condition).toBe("refund dispute");
  });
});

describe("DirectiveSteeringService", () => {
  const build = (directives: Directive[], denied = new Set<string>()) =>
    new DirectiveSteeringService({
      registry: new DirectiveCatalogRegistry(directives),
      matcher: new AlwaysMatchDirectiveMatcher(),
      capabilityPolicy: new StubCapabilityPolicy(denied),
    });

  it("produces ordered steering rules and matches for the trace", async () => {
    const service = build([
      directive({ name: "low", action: "low", priority: 1 }),
      directive({ name: "high", action: "high", priority: 9 }),
    ]);
    const result = await service.steer({ workspaceId: "w1" });
    expect(result.rules.map((r) => r.action)).toEqual(["high", "low"]);
    expect(result.rules.map((r) => ({ id: r.id, directiveName: r.directiveName }))).toEqual([
      { id: "d1", directiveName: "high" },
      { id: "d2", directiveName: "low" },
    ]);
    expect(result.matches).toHaveLength(2);
    expect(result.omissions).toHaveLength(0);
  });

  it("lets an authored directive supersede a built-in even when the built-in priority is higher", async () => {
    const service = build([
      directive({ name: "built-in-higher-priority", action: "Use the default behavior.", priority: 90 }),
    ]);
    const authored = directive({
      name: "authored-replacement",
      action: "Use the operator-authored replacement.",
      priority: 50,
      excludes: ["built-in-higher-priority"],
    });

    const result = await service.steer({
      workspaceId: "w1",
      additionalDirectives: [authored],
    });

    expect(result.matches.map((candidate) => candidate.directive.name)).toEqual(["authored-replacement"]);
    expect(result.rules.map((rule) => rule.action)).toEqual(["Use the operator-authored replacement."]);
    expect(result.omissions).toEqual([{
      directiveName: "built-in-higher-priority",
      reason: "excluded_by:authored-replacement",
    }]);
  });

  it("omits a directive whose required capability is denied and records the omission", async () => {
    const service = build(
      [
        directive({ name: "gated", action: "do gated", requiredCapabilities: ["assistant.chat"] }),
        directive({ name: "open", action: "do open" }),
      ],
      new Set(["assistant.chat"]),
    );
    const result = await service.steer({ workspaceId: "w1" });
    expect(result.rules.map((r) => r.action)).toEqual(["do open"]);
    expect(result.omissions).toEqual([{ directiveName: "gated", reason: "capability_denied" }]);
  });

  it("returns empty steering for an empty standing set (behavior-preserving default)", async () => {
    const result = await build([]).steer({ workspaceId: "w1" });
    expect(result).toEqual({ rules: [], matches: [], omissions: [], bounded: [] });
  });

  it("bounds the rendered set to top-k while keeping the full matched set and logging the drop", async () => {
    const debug: Array<{ payload: Record<string, unknown>; message: string }> = [];
    const service = new DirectiveSteeringService({
      registry: new DirectiveCatalogRegistry([
        directive({ name: "high", action: "high", priority: 90, condition: { kind: "contextual", description: "high" } }),
        directive({ name: "mid", action: "mid", priority: 50, condition: { kind: "contextual", description: "mid" } }),
        directive({ name: "low", action: "low", priority: 10, condition: { kind: "contextual", description: "low" } }),
      ]),
      matcher: matchAllDirectives,
      capabilityPolicy: new StubCapabilityPolicy(),
      steeringBound: { maxRenderedDirectives: 2, renderedTokenBudget: 1_000_000 },
      logger: {
        debug: (payload, message) => debug.push({ payload, message }),
        warn: () => {},
      },
    });

    const result = await service.steer({ workspaceId: "w1" });

    expect(result.rules.map((r) => r.action)).toEqual(["high", "mid"]);
    // The full matched set is preserved for skill binding and the trace.
    expect(result.matches).toHaveLength(3);
    expect(result.bounded).toEqual([{ directiveName: "low", reason: "top_k" }]);
    expect(debug).toHaveLength(1);
    expect(debug[0]!.payload).toMatchObject({ event: "directive_steering_bounded", workspaceId: "w1" });
  });

  it("preserves registration order for equal-priority directives when nothing is dropped", async () => {
    // Both default priority: the steering prompt gives earlier rules precedence,
    // so an unbounded turn must render them in registration order, not re-ranked.
    const service = build([
      directive({ name: "z", action: "z" }),
      directive({ name: "a", action: "a" }),
    ]);
    const result = await service.steer({ workspaceId: "w1" });
    expect(result.rules.map((r) => r.action)).toEqual(["z", "a"]);
    expect(result.bounded).toEqual([]);
  });

  it("does not render a dependent whose dependency was bounded out of the rendered set", async () => {
    const service = new DirectiveSteeringService({
      registry: new DirectiveCatalogRegistry([
        directive({ name: "expert", action: "expert", priority: 10, condition: { kind: "contextual", description: "expert" } }),
        directive({ name: "detail", action: "detail", priority: 90, dependsOn: ["expert"], condition: { kind: "contextual", description: "detail" } }),
      ]),
      matcher: matchAllDirectives,
      capabilityPolicy: new StubCapabilityPolicy(),
      steeringBound: { maxRenderedDirectives: 1, renderedTokenBudget: 1_000_000 },
    });

    const result = await service.steer({ workspaceId: "w1" });
    // `detail` outranks `expert`, but rendering it without its dependency would
    // break the dependsOn invariant, so neither renders.
    expect(result.rules).toEqual([]);
    expect(result.bounded).toEqual([
      { directiveName: "expert", reason: "top_k" },
      { directiveName: "detail", reason: "unmet_dependency" },
    ]);
  });

  it("does not log when nothing is bounded", async () => {
    const debug: unknown[] = [];
    const service = new DirectiveSteeringService({
      registry: new DirectiveCatalogRegistry([directive({ name: "only", action: "only" })]),
      matcher: new AlwaysMatchDirectiveMatcher(),
      capabilityPolicy: new StubCapabilityPolicy(),
      logger: { debug: () => debug.push(1), warn: () => {} },
    });
    const result = await service.steer({ workspaceId: "w1" });
    expect(result.bounded).toEqual([]);
    expect(debug).toHaveLength(0);
  });
});

describe("default answer directives", () => {
  it("preserves the extracted formatting and link behavior from answer prompts", () => {
    expect(conciseReadableFormattingDirective.action).toContain("Prefer short paragraphs");
    expect(conciseReadableFormattingDirective.action).toContain("Do not add headings unless");
    expect(conciseReadableFormattingDirective.action).toContain("Do not use tables unless");
    expect(inlineSupportedLinksDirective.action).toContain("link it inline with Markdown");
    expect(inlineSupportedLinksDirective.action).toContain("within the sentence that mentions it");
    expect(inlineSupportedLinksDirective.action).toContain("Prefer linking each named resource");
    expect(inlineSupportedLinksDirective.action).toContain("If the user asks for a link");
    expect(inlineSupportedLinksDirective.action).toContain("human-readable link text");
    expect(inlineSupportedLinksDirective.action).toContain("Never print a bare/raw URL");
    expect(inlineSupportedLinksDirective.description).toBe("Use available source URLs as inline links in grounded answers.");
    expect(inlineSupportedLinksDirective.action).toContain("has a URL in the retrieved findings");
    expect(inlineSupportedLinksDirective.action).not.toContain("draw a teaching or fact");
    expect(inlineSupportedLinksDirective.action).not.toContain("rather than only a bare citation marker");
    // Link text must be the resource's own name, not a generic tail phrase, and a
    // supported URL must never be replaced by a citation marker or parenthetical gesture.
    expect(inlineSupportedLinksDirective.action).toContain("The link text must be the resource's own name");
    expect(inlineSupportedLinksDirective.action).toContain("not a generic pointer phrase");
    expect(inlineSupportedLinksDirective.action).toContain(
      "never substitute a citation marker or a parenthetical gesture",
    );
    // Reconciled link rules: inline-only, never a trailing/semicolon list or a block
    // following a citation marker, and never a link or marker alone on its own line.
    expect(inlineSupportedLinksDirective.action).toContain("Never gather links into a trailing list");
    expect(inlineSupportedLinksDirective.action).toContain("separated by semicolons");
    expect(inlineSupportedLinksDirective.action).toContain("follows a citation marker");
    expect(inlineSupportedLinksDirective.action).toContain("alone on its own line");
  });
});

describe("Directive contract — steer, not act", () => {
  it("has no execution descriptor or dispatch channel", () => {
    // Structural guard mirroring SC-002: a Directive carries condition/action +
    // steering metadata only. If someone adds an executor, this fails.
    const d = directive({ name: "d", action: "x" });
    expect(d).not.toHaveProperty("execution");
    expect(d).not.toHaveProperty("dispatch");
    expect(d).not.toHaveProperty("outputs");
  });
});
