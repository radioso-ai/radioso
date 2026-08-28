import { describe, expect, it } from "vitest";

import {
  boundSteeringPerSurface,
  resolveRelationshipsPerSurface,
} from "../../src/modules/directives/surfaceScopedResolution.js";
import {
  DirectiveCatalogRegistry,
  DirectiveSteeringService,
} from "../../src/modules/directives/public.js";
import type { Directive, DirectiveMatch } from "../../src/modules/directives/domain.js";

const match = (name: string, overrides: Partial<Directive> = {}): DirectiveMatch => ({
  directive: {
    name,
    condition: { kind: "always" },
    action: `${name} action`,
    ...overrides,
  } as Directive,
  selectionMode: "deterministic",
  selectionReason: "test",
});

const names = (matches: DirectiveMatch[]): string[] => matches.map((m) => m.directive.name);

describe("resolveRelationshipsPerSurface", () => {
  it("still cancels a directive replaced on the generator they share", () => {
    const { kept, omissions } = resolveRelationshipsPerSurface([
      match("replacement", { excludes: ["replaced"] }),
      match("replaced"),
    ]);

    expect(names(kept)).toEqual(["replacement"]);
    expect(omissions.map((o) => o.directiveName)).toEqual(["replaced"]);
  });

  it("does not let a reply directive cancel one addressed to another generator", () => {
    const { kept, omissions } = resolveRelationshipsPerSurface([
      match("answer-rule", { excludes: ["suggestion-rule"] }),
      match("suggestion-rule", { surfaces: ["suggested_questions"] }),
    ]);

    expect(names(kept).sort()).toEqual(["answer-rule", "suggestion-rule"]);
    expect(omissions).toEqual([]);
  });

  it("narrows a directive to the generators it survived on", () => {
    const { kept } = resolveRelationshipsPerSurface([
      match("answer-rule", { excludes: ["both-rule"] }),
      match("both-rule", { surfaces: ["answer", "suggested_questions"] }),
    ]);

    const survivor = kept.find((m) => m.directive.name === "both-rule");
    expect(survivor?.directive.surfaces).toEqual(["suggested_questions"]);
  });

  it("drops a directive whose dependency never reaches its generator", () => {
    const { kept, omissions } = resolveRelationshipsPerSurface([
      match("needs-answer-rule", { surfaces: ["suggested_questions"], dependsOn: ["answer-only"] }),
      match("answer-only"),
    ]);

    expect(names(kept)).toEqual(["answer-only"]);
    expect(omissions[0]).toMatchObject({ directiveName: "needs-answer-rule" });
  });

  it("leaves an unscoped directive's scope untouched when nothing competes", () => {
    const { kept } = resolveRelationshipsPerSurface([match("solo")]);

    expect(kept[0]?.directive.surfaces).toBeUndefined();
  });
});

describe("boundSteeringPerSurface", () => {
  const contextual = (name: string, overrides: Partial<Directive> = {}): DirectiveMatch => ({
    ...match(name, { condition: { kind: "contextual", description: "when asked" }, ...overrides }),
    selectionMode: "probabilistic",
    selectionConfidence: 0.9,
  });

  const bound = { maxRenderedDirectives: 2, renderedTokenBudget: 10_000 };

  it("gives each generator its own budget instead of one shared pool", () => {
    const { rendered } = boundSteeringPerSurface(
      [
        contextual("answer-a"),
        contextual("answer-b"),
        contextual("answer-c"),
        contextual("suggestion-only", { surfaces: ["suggested_questions"] }),
      ],
      bound,
    );

    // The answer block overflows and drops one; the suggestion block has room to spare
    // and keeps its only occupant.
    expect(rendered.map((m) => m.directive.name)).toContain("suggestion-only");
  });

  it("still bounds a single generator that overflows on its own", () => {
    const { rendered, dropped } = boundSteeringPerSurface(
      [contextual("a"), contextual("b"), contextual("c")],
      bound,
    );

    expect(rendered).toHaveLength(2);
    expect(dropped).toHaveLength(1);
  });
});

describe("steering result — post-bound surfaces on matches", () => {
  const contextual = (name: string, surfaces?: Directive["surfaces"]): Directive => ({
    name,
    condition: { kind: "contextual", description: `when ${name}` },
    action: `${name} action`,
    ...(surfaces ? { surfaces } : {}),
  });

  class AllowAll {
    async evaluate() {
      return { allowed: true as const };
    }
  }

  const confidenceMatcher = (byName: Record<string, number>) => ({
    match: async ({ directives }: { directives: Directive[] }) =>
      directives.map((directive) => ({
        directive,
        selectionMode: "probabilistic" as const,
        selectionReason: "matched",
        selectionConfidence: byName[directive.name] ?? 0.5,
      })),
  });

  it("narrows a match to the surfaces that survived bounding, for hosts that rebuild steering", async () => {
    const service = new DirectiveSteeringService({
      registry: new DirectiveCatalogRegistry([
        contextual("answer-a"),
        contextual("answer-b"),
        contextual("both", ["answer", "suggested_questions"]),
      ]),
      matcher: confidenceMatcher({ "answer-a": 0.9, "answer-b": 0.8, both: 0.1 }) as never,
      capabilityPolicy: new AllowAll() as never,
      // The answer block fits two, so the weakest loses that pass; the suggestion
      // block has room and keeps its only occupant.
      steeringBound: { maxRenderedDirectives: 2, renderedTokenBudget: 10_000 },
    });

    const result = await service.steer({ workspaceId: "w1" });
    const both = result.matches.find((match) => match.directive.name === "both");

    // The bound narrowed what renders, so the engine sees `suggested_questions` only…
    expect(both?.renderSurfaces).toEqual(["suggested_questions"]);
    // …while the authored scope is untouched, because a bound is a prompt-size
    // decision. Overwriting it would cost the directive its skill binding, which
    // `resolveDirectiveBinding` grants only to directives addressing the answer.
    expect(both?.directive.surfaces).toEqual(["answer", "suggested_questions"]);
    expect(result.rules.some((rule) => rule.action === "both action")).toBe(true);
  });

  it("keeps a fully bounded match inspectable without allowing an engine host to render it", async () => {
    const service = new DirectiveSteeringService({
      registry: new DirectiveCatalogRegistry([contextual("fully-bounded")]),
      matcher: confidenceMatcher({ "fully-bounded": 0.9 }) as never,
      capabilityPolicy: new AllowAll() as never,
      steeringBound: { maxRenderedDirectives: 0, renderedTokenBudget: 10_000 },
    });

    const result = await service.steer({ workspaceId: "w1" });

    expect(result.rules).toEqual([]);
    expect(result.matches).toEqual([
      expect.objectContaining({
        directive: expect.objectContaining({ name: "fully-bounded" }),
        renderInSteering: false,
      }),
    ]);
    expect(result.bounded).toEqual([{ directiveName: "fully-bounded", reason: "top_k" }]);
  });
  it("keeps a bound-narrowed directive eligible to bind the answering skill", async () => {
    const { resolveDirectiveBinding } = await import("@radioso/conversation-defaults");

    const service = new DirectiveSteeringService({
      registry: new DirectiveCatalogRegistry([
        contextual("answer-a"),
        contextual("answer-b"),
        {
          ...contextual("both", ["answer", "suggested_questions"]),
          binding: { kind: "skill", skillName: "order.lookup" },
        },
      ]),
      matcher: confidenceMatcher({ "answer-a": 0.9, "answer-b": 0.8, both: 0.1 }) as never,
      capabilityPolicy: new AllowAll() as never,
      steeringBound: { maxRenderedDirectives: 2, renderedTokenBudget: 10_000 },
    });

    const result = await service.steer({ workspaceId: "w1" });
    const resolution = resolveDirectiveBinding({
      matches: result.matches,
      registeredTurnSkillNames: new Set(["order.lookup"]),
      agentSkillStates: new Map([
        ["order.lookup", { enabled: true, turnCapable: true, stagingCapable: false }],
      ]),
    });

    // Losing the answer prompt budget must not cost the directive its binding: the
    // bound decides what fits in the prompt, not which skill answers the turn.
    expect(resolution.winner).toEqual({ directiveName: "both", skillName: "order.lookup" });
  });
  it("keeps an unscoped directive renderable after bounding", async () => {
    // The default scope is absent, not ["answer"]. Reading it back through a map that
    // stores raw `surfaces` makes "present with default scope" look identical to
    // "dropped everywhere", which silently removed every historical and built-in
    // answer directive from engine-rebuilt routine and clarification prompts.
    const service = new DirectiveSteeringService({
      registry: new DirectiveCatalogRegistry([contextual("unscoped"), contextual("also-unscoped")]),
      matcher: confidenceMatcher({ unscoped: 0.9, "also-unscoped": 0.8 }) as never,
      capabilityPolicy: new AllowAll() as never,
      steeringBound: { maxRenderedDirectives: 10, renderedTokenBudget: 10_000 },
    });

    const result = await service.steer({ workspaceId: "w1" });

    expect(result.matches.map((match) => match.renderInSteering)).toEqual([undefined, undefined]);
    expect(result.matches.map((match) => match.renderSurfaces)).toEqual([undefined, undefined]);
    expect(result.rules).toHaveLength(2);
  });
});
