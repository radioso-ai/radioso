import { describe, expect, it, vi } from "vitest";

import {
  AlwaysMatchDirectiveMatcher,
  CompositeDirectiveMatcher,
  DirectiveCatalogRegistry,
  ModelDirectiveMatchGateway,
  ProbabilisticDirectiveMatcher,
  directiveToSteeringRule,
  parseDirectiveClassifications,
  parseScopeTag,
  resolveDirectiveRelationships,
  scopeTag,
  type Directive,
  type DirectiveMatch,
  type DirectiveMatchGateway,
} from "../src/index.js";

const directive = (overrides: Partial<Directive> & Pick<Directive, "name" | "action">): Directive => ({
  condition: { kind: "always" },
  ...overrides,
});

const contextual = (name: string, description: string, action = name): Directive =>
  directive({ name, action, condition: { kind: "contextual", description } });

const match = (candidate: Directive): DirectiveMatch => ({
  directive: candidate,
  selectionMode: "deterministic",
  selectionReason: "always",
});

describe("directive defaults", () => {
  it("registers, lists, and gets directives; rejects duplicates", () => {
    const registry = new DirectiveCatalogRegistry([directive({ name: "be-concise", action: "be concise" })]);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("be-concise")?.action).toBe("be concise");
    expect(() => registry.register(directive({ name: "be-concise", action: "x" }))).toThrow(/already registered/);
  });

  it("matches `always` directives deterministically and skips contextual ones", async () => {
    const matches = await new AlwaysMatchDirectiveMatcher().match({
      turnContext: {},
      directives: [
        directive({ name: "standing", action: "always do X" }),
        contextual("conditional", "when angry", "do Y"),
      ],
    });

    expect(matches.map((candidate) => candidate.directive.name)).toEqual(["standing"]);
    expect(matches[0]?.selectionMode).toBe("deterministic");
    expect(matches[0]?.selectionReason).toBeTruthy();
  });

  it("parses model classifications from prose and clamps confidence", () => {
    const raw = "Here:\n```json\n[{\"name\":\"escalate\",\"confidence\":1.7},{\"name\":\"unknown\",\"confidence\":0.9}]\n```";
    expect(parseDirectiveClassifications(raw, ["escalate"])).toEqual([{ name: "escalate", confidence: 1 }]);
    expect(parseDirectiveClassifications("no json here", ["escalate"])).toEqual([]);
  });

  it("maps contextual classifications above the threshold to probabilistic matches", async () => {
    const gateway: DirectiveMatchGateway = {
      match: vi.fn().mockResolvedValue([
        { name: "escalate", confidence: 0.9, reason: "angry customer" },
        { name: "be-gentle", confidence: 0.3 },
      ]),
    };
    const matcher = new ProbabilisticDirectiveMatcher({ gateway, confidenceThreshold: 0.5 });
    const matches = await matcher.match({
      turnContext: { query: "this is unacceptable" },
      directives: [contextual("escalate", "customer is angry"), contextual("be-gentle", "customer seems new")],
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      selectionMode: "probabilistic",
      selectionConfidence: 0.9,
      selectionReason: "angry customer",
    });
    expect(matches[0]?.directive.name).toBe("escalate");
  });

  it("concatenates deterministic and probabilistic matcher results", async () => {
    const gateway: DirectiveMatchGateway = { match: vi.fn().mockResolvedValue([{ name: "ctx", confidence: 0.9 }]) };
    const matches = await new CompositeDirectiveMatcher([
      new AlwaysMatchDirectiveMatcher(),
      new ProbabilisticDirectiveMatcher({ gateway, confidenceThreshold: 0.5 }),
    ]).match({
      turnContext: {},
      directives: [directive({ name: "standing", action: "x" }), contextual("ctx", "when X")],
    });

    expect(matches.map((candidate) => candidate.directive.name).sort()).toEqual(["ctx", "standing"]);
  });

  it("renders the model gateway prompt and parses the structured response", async () => {
    const complete = vi.fn().mockResolvedValue({ text: '[{"name":"escalate","confidence":0.7}]' });
    const gateway = new ModelDirectiveMatchGateway({ complete });
    const result = await gateway.match({
      turnContext: { query: "I want a refund now" },
      directives: [contextual("escalate", "customer demands a refund")],
    });

    expect(result).toEqual([{ name: "escalate", confidence: 0.7 }]);
    const request = complete.mock.calls[0]?.[0];
    expect(request?.systemPrompt).toContain("Return a JSON array");
    expect(request?.prompt).toContain("escalate");
    expect(request?.temperature).toBe(0);
  });

  it("maps matches to steering and resolves relationships", () => {
    const concise = directive({ name: "concise", action: "be concise", priority: 9, excludes: ["verbose"] });
    const verbose = directive({ name: "verbose", action: "be verbose" });
    const { kept, omissions } = resolveDirectiveRelationships([match(concise), match(verbose)]);

    expect(kept.map((candidate) => candidate.directive.name)).toEqual(["concise"]);
    expect(omissions).toEqual([{ directiveName: "verbose", reason: "excluded_by:concise" }]);
    expect(directiveToSteeringRule(match(concise))).toMatchObject({
      action: "be concise",
      source: "directive",
      lifespan: "response",
    });
  });

  it("builds and parses routine and step scope tags", () => {
    expect(scopeTag.routine("routine_1")).toBe("routine:routine_1");
    expect(scopeTag.step("routine_1", "step_1")).toBe("step:routine_1:step_1");

    expect(parseScopeTag(scopeTag.routine("routine_1"))).toEqual({
      kind: "routine",
      routineId: "routine_1",
    });
    expect(parseScopeTag(scopeTag.step("routine_1", "step_1"))).toEqual({
      kind: "step",
      routineId: "routine_1",
      stepId: "step_1",
    });
    expect(parseScopeTag("foo")).toEqual({ kind: "other" });
  });
});
