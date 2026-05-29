import { describe, expect, it } from "vitest";

import {
  AlwaysMatchDirectiveMatcher,
  DirectiveCatalogRegistry,
  DirectiveSteeringService,
  resolveDirectiveRelationships,
  type Directive,
  type DirectiveMatch,
} from "../../src/modules/directives/public.js";
import type { CapabilityCheckInput, CapabilityDecision, CapabilityPolicy } from "../../src/shared/domain/capabilityPolicy.js";

const directive = (overrides: Partial<Directive> & Pick<Directive, "name">): Directive => ({
  condition: { kind: "always" },
  action: overrides.name,
  ...overrides,
});

const match = (directive: Directive): DirectiveMatch => ({
  directive,
  selectionMode: "deterministic",
  selectionReason: "always",
});

class AllowAllCapabilityPolicy implements CapabilityPolicy {
  async can(_input: CapabilityCheckInput): Promise<CapabilityDecision> {
    return { allowed: true };
  }
}

describe("resolveDirectiveRelationships", () => {
  it("keeps everything when there are no relationships", () => {
    const matches = [match(directive({ name: "a" })), match(directive({ name: "b" }))];
    const { kept, omissions } = resolveDirectiveRelationships(matches);
    expect(kept.map((m) => m.directive.name)).toEqual(["a", "b"]);
    expect(omissions).toEqual([]);
  });

  it("drops a directive excluded by an applying one", () => {
    const matches = [
      match(directive({ name: "concise", excludes: ["verbose"] })),
      match(directive({ name: "verbose" })),
    ];
    const { kept, omissions } = resolveDirectiveRelationships(matches);
    expect(kept.map((m) => m.directive.name)).toEqual(["concise"]);
    expect(omissions).toEqual([{ directiveName: "verbose", reason: "excluded_by:concise" }]);
  });

  it("resolves a mutual exclusion by priority (higher priority wins)", () => {
    const matches = [
      match(directive({ name: "low", priority: 1, excludes: ["high"] })),
      match(directive({ name: "high", priority: 9, excludes: ["low"] })),
    ];
    const { kept } = resolveDirectiveRelationships(matches);
    expect(kept.map((m) => m.directive.name)).toEqual(["high"]);
  });

  it("drops a directive whose dependency did not apply", () => {
    const matches = [match(directive({ name: "detail", dependsOn: ["expert"] }))];
    const { kept, omissions } = resolveDirectiveRelationships(matches);
    expect(kept).toEqual([]);
    expect(omissions).toEqual([{ directiveName: "detail", reason: "unmet_dependency:expert" }]);
  });

  it("cascades: excluding a dependency drops the dependent", () => {
    const matches = [
      match(directive({ name: "killer", priority: 9, excludes: ["expert"] })),
      match(directive({ name: "expert" })),
      match(directive({ name: "detail", dependsOn: ["expert"] })),
    ];
    const { kept, omissions } = resolveDirectiveRelationships(matches);
    expect(kept.map((m) => m.directive.name)).toEqual(["killer"]);
    expect(omissions).toContainEqual({ directiveName: "expert", reason: "excluded_by:killer" });
    expect(omissions).toContainEqual({ directiveName: "detail", reason: "unmet_dependency:expert" });
  });
});

describe("DirectiveSteeringService — relationships", () => {
  it("applies relationships after the capability filter and records all omissions", async () => {
    const service = new DirectiveSteeringService({
      registry: new DirectiveCatalogRegistry([
        directive({ name: "concise", excludes: ["verbose"] }),
        directive({ name: "verbose" }),
      ]),
      matcher: new AlwaysMatchDirectiveMatcher(),
      capabilityPolicy: new AllowAllCapabilityPolicy(),
    });

    const result = await service.steer({ workspaceId: "w1" });
    expect(result.rules.map((rule) => rule.action)).toEqual(["concise"]);
    expect(result.matches.map((m) => m.directive.name)).toEqual(["concise"]);
    expect(result.omissions).toContainEqual({ directiveName: "verbose", reason: "excluded_by:concise" });
  });
});
