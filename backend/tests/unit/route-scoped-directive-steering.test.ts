import { describe, expect, it, vi } from "vitest";

import { createRouteScopedDirectiveSteering } from "../../src/modules/chat/services/routeScopedDirectiveSteering.js";
import {
  conciseReadableFormattingDirective,
  inlineSupportedLinksDirective,
  representOrganizationDirective,
  type Directive,
} from "../../src/modules/directives/public.js";
import { appendDirectiveSteeringStage } from "../../src/modules/chat/services/directiveTracePresenter.js";
import { composeGroundedAnswerSystemPrompt } from "../../src/modules/chat/services/groundedAnswerPromptComposer.js";
import type { ActivityTrace } from "../../src/modules/retrieval/public.js";
import type { CapabilityPolicy } from "../../src/shared/domain/capabilityPolicy.js";

const allowAllCapabilities: CapabilityPolicy = {
  async can() {
    return { allowed: true };
  },
};

const directive = (name: string, action = `Apply ${name}.`): Directive => ({
  name,
  condition: { kind: "always" },
  action,
});

const basePromptInput = {
  baseSystemPrompt: "You are a helpful assistant.",
  suggestedQuestionsEnabled: false,
  suggestedQuestionsCount: 0,
  hasRetrievedContexts: false,
  conversationIntentSnapshot: { recentTurns: [] },
};

const baseTrace = (): ActivityTrace => ({
  traceId: "trace-1",
  startedAt: "2026-01-01T00:00:00.000Z",
  stages: [{ stageId: "answer", kind: "answer_outcome" as const, label: "Answer outcome", status: "applied" as const }],
  links: [],
});

describe("route-scoped directive steering", () => {
  it("lets the chat route choose which registered directives are enacted", async () => {
    const steering = createRouteScopedDirectiveSteering({
      capabilityPolicy: allowAllCapabilities,
      registrations: [
        { directive: directive("global") },
        { directive: directive("retrieval-only"), routes: ["retrieval"] },
        { directive: directive("social-only"), routes: ["direct"] },
      ],
    });

    const retrieval = await steering.steer({ workspaceId: "w1", turnContext: { route: "retrieval" } });
    const social = await steering.steer({ workspaceId: "w1", turnContext: { route: "direct" } });

    expect(retrieval.matches.map((match) => match.directive.name)).toEqual(["global", "retrieval-only"]);
    expect(social.matches.map((match) => match.directive.name)).toEqual(["global", "social-only"]);
  });

  it("keeps built-in answer directive route policy in the chat engine layer", async () => {
    const steering = createRouteScopedDirectiveSteering({
      capabilityPolicy: allowAllCapabilities,
      registrations: [
        { directive: conciseReadableFormattingDirective },
        { directive: representOrganizationDirective },
        { directive: inlineSupportedLinksDirective },
      ],
    });

    const retrieval = await steering.steer({ workspaceId: "w1", turnContext: { route: "retrieval" } });
    const social = await steering.steer({ workspaceId: "w1", turnContext: { route: "direct" } });

    expect(retrieval.matches.map((match) => match.directive.name)).toEqual([
      "concise-readable-formatting",
      "represent-organization",
      "inline-supported-links",
    ]);
    expect(social.matches.map((match) => match.directive.name)).toEqual(["concise-readable-formatting"]);
  });

  it("threads a composition-provided directive matcher into the per-route steering", async () => {
    const matched: string[] = [];
    const matcher = {
      match: async (input: { directives: Directive[] }) => {
        matched.push(...input.directives.map((candidate) => candidate.name));
        // Return no matches so the result is deterministic; the assertion is that
        // the registered matcher — not the default always-match — was consulted.
        return [];
      },
    };
    const steering = createRouteScopedDirectiveSteering({
      capabilityPolicy: allowAllCapabilities,
      registrations: [{ directive: directive("global") }],
      matcher,
    });

    const result = await steering.steer({ workspaceId: "w1", turnContext: { route: "retrieval" } });

    expect(matched).toContain("global");
    expect(result.matches).toEqual([]);
  });

  it("builds a per-turn contextual matcher from the directive match gateway factory", async () => {
    const contextualDirective: Directive = {
      name: "refund-tone",
      condition: { kind: "contextual", description: "when the customer asks for a refund" },
      action: "Use refund support tone.",
    };
    const gateway = {
      match: vi.fn(async () => [{ name: contextualDirective.name, confidence: 0.92, reason: "refund request" }]),
    };
    const gatewayFactory = {
      create: vi.fn(async () => gateway),
    };
    const steering = createRouteScopedDirectiveSteering({
      capabilityPolicy: allowAllCapabilities,
      registrations: [{ directive: contextualDirective }],
      directiveMatchGatewayFactory: gatewayFactory,
    });

    const result = await steering.steer({
      workspaceId: "w1",
      turnContext: { route: "retrieval", query: "Can I get a refund?" },
      usageContext: {
        workspaceId: "w1",
        conversationId: "conv-1",
        messageId: "msg-1",
        surface: "chat",
        operation: "directive_match",
        attemptKey: "msg-1:directive_match",
      },
    });

    expect(gatewayFactory.create).toHaveBeenCalledWith({
      workspaceContext: { workspaceId: "w1" },
      usageContext: expect.objectContaining({
        workspaceId: "w1",
        conversationId: "conv-1",
        messageId: "msg-1",
        surface: "chat",
        operation: "directive_match",
      }),
    });
    expect(gateway.match).toHaveBeenCalledWith({
      turnContext: { route: "retrieval", query: "Can I get a refund?" },
      directives: [contextualDirective],
    });
    expect(result.rules.map((rule) => rule.action)).toEqual(["Use refund support tone."]);
    expect(result.matches).toEqual([
      expect.objectContaining({
        directive: contextualDirective,
        selectionMode: "probabilistic",
        selectionConfidence: 0.92,
        selectionReason: "refund request",
      }),
    ]);
    const { systemPrompt } = composeGroundedAnswerSystemPrompt({
      ...basePromptInput,
      steering: result.rules,
    });
    expect(systemPrompt).toContain("Use refund support tone.");
    const traced = appendDirectiveSteeringStage(baseTrace(), result);
    expect(traced.stages.at(-1)).toMatchObject({
      stageId: "directive_steering",
      outputs: {
        matched: [expect.objectContaining({ name: contextualDirective.name, selectionMode: "probabilistic" })],
      },
    });
  });

  it("omits contextual directives when the per-turn model classification is below threshold", async () => {
    const contextualDirective: Directive = {
      name: "refund-tone",
      condition: { kind: "contextual", description: "when the customer asks for a refund" },
      action: "Use refund support tone.",
    };
    const gatewayFactory = {
      create: vi.fn(async () => ({
        match: vi.fn(async () => [{ name: contextualDirective.name, confidence: 0.1 }]),
      })),
    };
    const steering = createRouteScopedDirectiveSteering({
      capabilityPolicy: allowAllCapabilities,
      registrations: [
        { directive: directive("always-on", "Always apply.") },
        { directive: contextualDirective },
      ],
      directiveMatchGatewayFactory: gatewayFactory,
    });

    const result = await steering.steer({
      workspaceId: "w1",
      turnContext: { route: "retrieval", query: "Tell me about shipping." },
      usageContext: {
        workspaceId: "w1",
        conversationId: "conv-1",
        messageId: "msg-1",
        surface: "chat",
        operation: "directive_match",
        attemptKey: "msg-1:directive_match",
      },
    });

    expect(result.rules.map((rule) => rule.action)).toEqual(["Always apply."]);
    expect(result.matches.map((match) => match.directive.name)).toEqual(["always-on"]);
    const { systemPrompt } = composeGroundedAnswerSystemPrompt({
      ...basePromptInput,
      steering: result.rules,
    });
    expect(systemPrompt).toContain("Always apply.");
    expect(systemPrompt).not.toContain("Use refund support tone.");
  });

  it("does not apply built-in route policy to unrelated directives with the same name", async () => {
    const customRepresentOrganization = directive(
      representOrganizationDirective.name,
      "Apply custom represent-organization steering.",
    );
    const steering = createRouteScopedDirectiveSteering({
      capabilityPolicy: allowAllCapabilities,
      registrations: [
        { directive: representOrganizationDirective },
        { directive: customRepresentOrganization },
      ],
    });

    const social = await steering.steer({ workspaceId: "w1", turnContext: { route: "direct" } });

    expect(social.matches.map((match) => match.directive.action)).toEqual([
      "Apply custom represent-organization steering.",
    ]);
  });

  it("merges turn-provided authored directives into retrieval and social routes", async () => {
    const authored = directive("agent-tone", "Use this agent's saved tone.");
    const steering = createRouteScopedDirectiveSteering({
      capabilityPolicy: allowAllCapabilities,
      registrations: [
        { directive: conciseReadableFormattingDirective },
        { directive: representOrganizationDirective },
        { directive: inlineSupportedLinksDirective },
      ],
    });

    const retrieval = await steering.steer({
      workspaceId: "w1",
      turnContext: { route: "retrieval" },
      additionalDirectives: [authored],
    });
    const social = await steering.steer({
      workspaceId: "w1",
      turnContext: { route: "direct" },
      additionalDirectives: [authored],
    });

    expect(retrieval.rules.map((rule) => rule.action)).toEqual([
      inlineSupportedLinksDirective.action,
      representOrganizationDirective.action,
      conciseReadableFormattingDirective.action,
      authored.action,
    ]);
    expect(social.rules.map((rule) => rule.action)).toEqual([
      conciseReadableFormattingDirective.action,
      authored.action,
    ]);
  });

  it("orders turn-provided authored directives with a priority-50 steering default", async () => {
    const authored = directive("agent-tone", "Use this agent's saved tone.");
    const steering = createRouteScopedDirectiveSteering({
      capabilityPolicy: allowAllCapabilities,
      registrations: [{ directive: conciseReadableFormattingDirective }],
    });

    const result = await steering.steer({
      workspaceId: "w1",
      turnContext: { route: "retrieval" },
      additionalDirectives: [{ ...authored, priority: 50 }],
    });

    expect(result.rules.map((rule) => rule.action)).toEqual([
      conciseReadableFormattingDirective.action,
      authored.action,
    ]);
  });

  it("resolves authored relationships against the merged directive set", async () => {
    const authored = {
      ...directive("agent-tone", "Use this agent's saved tone."),
      excludes: [conciseReadableFormattingDirective.name],
      priority: 50,
    };
    const steering = createRouteScopedDirectiveSteering({
      capabilityPolicy: allowAllCapabilities,
      registrations: [{ directive: conciseReadableFormattingDirective }],
    });

    const result = await steering.steer({
      workspaceId: "w1",
      turnContext: { route: "retrieval" },
      additionalDirectives: [authored],
    });

    expect(result.rules.map((rule) => rule.action)).toEqual([authored.action]);
    expect(result.omissions).toEqual([{
      directiveName: conciseReadableFormattingDirective.name,
      reason: `excluded_by:${authored.name}`,
    }]);
  });

  it("lets an authored always directive replace a built-in answer directive", async () => {
    const authored = {
      ...directive("agent-inline-links", "Use this agent's custom source-link policy."),
      excludes: [inlineSupportedLinksDirective.name],
    };
    const steering = createRouteScopedDirectiveSteering({
      capabilityPolicy: allowAllCapabilities,
      registrations: [
        { directive: conciseReadableFormattingDirective },
        { directive: representOrganizationDirective },
        { directive: inlineSupportedLinksDirective },
      ],
    });

    const result = await steering.steer({
      workspaceId: "w1",
      turnContext: { route: "retrieval" },
      additionalDirectives: [authored],
    });

    expect(result.matches.map((match) => match.directive.name)).toContain(authored.name);
    expect(result.matches.map((match) => match.directive.name)).not.toContain(inlineSupportedLinksDirective.name);
    expect(result.omissions).toContainEqual({
      directiveName: inlineSupportedLinksDirective.name,
      reason: `excluded_by:${authored.name}`,
    });
  });

  it("scopes contextual authored replacement to turns where the condition matches", async () => {
    const contextualAuthored = {
      ...directive("agent-contextual-links", "Use scoped source-link wording."),
      condition: { kind: "contextual" as const, description: "when answering policy questions" },
      excludes: [inlineSupportedLinksDirective.name],
    };
    const matcher = {
      async match(input: { turnContext: Record<string, unknown>; directives: Directive[] }) {
        return input.directives
          .filter((candidate) =>
            candidate.condition.kind === "always" ||
            (candidate.name === contextualAuthored.name && input.turnContext.contextualOverrideApplies === true)
          )
          .map((candidate) => ({
            directive: candidate,
            selectionMode: candidate.condition.kind === "always" ? "deterministic" as const : "probabilistic" as const,
            selectionReason: "test matcher",
          }));
      },
    };
    const steering = createRouteScopedDirectiveSteering({
      capabilityPolicy: allowAllCapabilities,
      registrations: [{ directive: inlineSupportedLinksDirective }],
      matcher,
    });

    const matched = await steering.steer({
      workspaceId: "w1",
      turnContext: { route: "retrieval", contextualOverrideApplies: true },
      additionalDirectives: [contextualAuthored],
    });
    const unmatched = await steering.steer({
      workspaceId: "w1",
      turnContext: { route: "retrieval", contextualOverrideApplies: false },
      additionalDirectives: [contextualAuthored],
    });

    expect(matched.matches.map((match) => match.directive.name)).toContain(contextualAuthored.name);
    expect(matched.matches.map((match) => match.directive.name)).not.toContain(inlineSupportedLinksDirective.name);
    expect(matched.omissions).toContainEqual({
      directiveName: inlineSupportedLinksDirective.name,
      reason: `excluded_by:${contextualAuthored.name}`,
    });
    expect(unmatched.matches.map((match) => match.directive.name)).toEqual([inlineSupportedLinksDirective.name]);
    expect(unmatched.omissions).toEqual([]);
  });

  it("capability-filters turn-provided authored directives", async () => {
    const authored = {
      ...directive("agent-tone", "Use this agent's saved tone."),
      requiredCapabilities: ["assistant.special"],
    };
    const steering = createRouteScopedDirectiveSteering({
      capabilityPolicy: {
        async can(input) {
          return input.capability === "assistant.special"
            ? { allowed: false, reason: "capability_denied" }
            : { allowed: true };
        },
      },
      registrations: [{ directive: conciseReadableFormattingDirective }],
    });

    const result = await steering.steer({
      workspaceId: "w1",
      turnContext: { route: "retrieval" },
      additionalDirectives: [authored],
    });

    expect(result.rules.map((rule) => rule.action)).toEqual([conciseReadableFormattingDirective.action]);
    expect(result.omissions).toEqual([{ directiveName: authored.name, reason: "capability_denied" }]);
  });
});
