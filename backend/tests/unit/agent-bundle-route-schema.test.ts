import { describe, expect, it } from "vitest";

import { agentBundleBodySchema } from "../../src/app/http/routes/agentBundleRoutes.js";

const body = () => ({
  bundleVersion: 1,
  agent: { schemaVersion: 3, name: "Procurement Bot", authoredDirectives: [] },
  routines: [{ name: "book-a-demo", version: 2, definition: { name: "book-a-demo" } }],
  contextVariables: [{
    variableName: "plan_tier",
    source: "pushed" as const,
    resolverSkillName: null,
    maxAgeSeconds: null,
    resolverTimeoutMs: null,
    surfacing: "always" as const,
    enabled: true,
  }],
  agentSkills: [{
    name: "notify.ops",
    capability: "notify",
    invocationMode: "routine_named" as const,
    enabled: true,
    config: { tone: "urgent" },
    omittedConfigKeys: ["delivery.recipientEmails", "delivery.webhook.url"],
    target: { kind: "webhook_destination", id: { __ref: "agentSkillTarget" } },
  }],
});

describe("agent bundle body schema", () => {
  // Regression guard. A stripping object schema silently removed omittedConfigKeys,
  // which took the whole skill_config_not_portable report with it over HTTP while
  // every service-level test still passed.
  it("carries omittedConfigKeys through to the import service", () => {
    const parsed = agentBundleBodySchema.parse(body());

    expect(parsed.agentSkills[0].omittedConfigKeys).toEqual([
      "delivery.recipientEmails",
      "delivery.webhook.url",
    ]);
  });

  it("does not drop bundle fields it has no rule for", () => {
    const withFutureFields = body() as Record<string, unknown> & {
      agentSkills: Array<Record<string, unknown>>;
      routines: Array<Record<string, unknown>>;
    };
    withFutureFields.agentSkills[0].somethingAddedLater = { keep: true };
    withFutureFields.routines[0].lineageLabel = "v3";
    withFutureFields.futureCollection = [{ id: 1 }];

    const parsed = agentBundleBodySchema.parse(withFutureFields) as Record<string, unknown> & {
      agentSkills: Array<Record<string, unknown>>;
      routines: Array<Record<string, unknown>>;
    };

    expect(parsed.agentSkills[0].somethingAddedLater).toEqual({ keep: true });
    expect(parsed.routines[0].lineageLabel).toBe("v3");
    expect(parsed.futureCollection).toEqual([{ id: 1 }]);
  });

  it("still refuses a body that is not a bundle", () => {
    expect(() => agentBundleBodySchema.parse({ hello: "world" })).toThrow();
    expect(() => agentBundleBodySchema.parse({ bundleVersion: 1 })).toThrow();
  });

  it("defaults absent collections rather than failing", () => {
    const parsed = agentBundleBodySchema.parse({
      bundleVersion: 1,
      agent: { schemaVersion: 3, name: "Bare" },
    });

    expect(parsed.routines).toEqual([]);
    expect(parsed.contextVariables).toEqual([]);
    expect(parsed.agentSkills).toEqual([]);
  });
});
