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
});
