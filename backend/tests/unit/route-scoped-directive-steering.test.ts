import { describe, expect, it } from "vitest";

import { createRouteScopedDirectiveSteering } from "../../src/modules/chat/services/routeScopedDirectiveSteering.js";
import {
  conciseReadableFormattingDirective,
  inlineSupportedLinksDirective,
  representOrganizationDirective,
  type Directive,
} from "../../src/modules/directives/public.js";
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

describe("route-scoped directive steering", () => {
  it("lets the chat route choose which registered directives are enacted", async () => {
    const steering = createRouteScopedDirectiveSteering({
      capabilityPolicy: allowAllCapabilities,
      registrations: [
        { directive: directive("global") },
        { directive: directive("retrieval-only"), routes: ["retrieval"] },
        { directive: directive("social-only"), routes: ["social_only"] },
      ],
    });

    const retrieval = await steering.steer({ workspaceId: "w1", turnContext: { route: "retrieval" } });
    const social = await steering.steer({ workspaceId: "w1", turnContext: { route: "social_only" } });

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
    const social = await steering.steer({ workspaceId: "w1", turnContext: { route: "social_only" } });

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

    const social = await steering.steer({ workspaceId: "w1", turnContext: { route: "social_only" } });

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
      turnContext: { route: "social_only" },
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
