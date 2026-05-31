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
      directive: directive({ name: "d", action: "slow down", priority: 3, criticality: "high" }),
      selectionMode: "deterministic",
      selectionReason: "always",
    };
    const rule = directiveToSteeringRule(match);
    expect(rule).toMatchObject({ action: "slow down", priority: 3, criticality: "high", source: "directive", lifespan: "response" });
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
    expect(result.matches).toHaveLength(2);
    expect(result.omissions).toHaveLength(0);
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
    expect(result).toEqual({ rules: [], matches: [], omissions: [] });
  });
});

describe("default answer directives", () => {
  it("preserves the extracted formatting and link behavior from answer prompts", () => {
    expect(conciseReadableFormattingDirective.action).toContain("Prefer short paragraphs");
    expect(conciseReadableFormattingDirective.action).toContain("Do not add headings unless");
    expect(conciseReadableFormattingDirective.action).toContain("Do not use tables unless");
    expect(inlineSupportedLinksDirective.action).toContain("link it inline with Markdown");
    expect(inlineSupportedLinksDirective.action).toContain("every time you mention such a resource");
    expect(inlineSupportedLinksDirective.action).toContain("Provide ample inline links");
    expect(inlineSupportedLinksDirective.action).toContain("If the user asks for a link");
    expect(inlineSupportedLinksDirective.action).toContain("human-readable link text");
    expect(inlineSupportedLinksDirective.action).toContain("Never print a bare/raw URL");
    expect(inlineSupportedLinksDirective.action).toContain("Do not collect links in a separate reference list");
    expect(inlineSupportedLinksDirective.action).toContain("For resource lists or closing paths");
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
