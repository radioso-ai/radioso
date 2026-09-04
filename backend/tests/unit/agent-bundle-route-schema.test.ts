import { readFileSync } from "node:fs";

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

/**
 * The published request contract has to accept everything the import service does.
 * These read the generated artifact rather than the builder, because the artifact is
 * what the SDK is generated from and therefore what a consumer is actually held to.
 */
describe("published agent bundle import contract", () => {
  const openApi = JSON.parse(
    readFileSync(new URL("../../openapi.json", import.meta.url), "utf8"),
  ) as { components: { schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }> } };

  it("does not require agent config fields the accepted older version predates", () => {
    const required = openApi.components.schemas.AgentBundleImportAgentConfig?.required ?? [];

    // SUPPORTED_AGENT_CONFIG_VERSIONS accepts v3, which had neither field. Requiring
    // them here would reject a bundle the backend imports, so an SDK consumer would
    // have to cast around their own published contract.
    expect(required).not.toContain("internalName");
    expect(required).not.toContain("handoffOnRetrievalMiss");
    // Everything a v3 bundle did carry stays required.
    expect(required).toEqual(expect.arrayContaining(["schemaVersion", "name", "customInstruction"]));
  });

  it("does not require collections the route defaults", () => {
    const required = openApi.components.schemas.AgentBundleImportRequest?.required ?? [];

    expect(required).toEqual(expect.arrayContaining(["bundleVersion", "agent"]));
    for (const defaulted of ["routines", "contextVariables", "agentSkills", "portability"]) {
      expect(required).not.toContain(defaulted);
    }
  });

  it("still describes the exported agent exhaustively", () => {
    // The response side is always the current version, so nothing there is optional;
    // this is the guard against the placeholder shape coming back.
    const exported = openApi.components.schemas.AgentBundleAgentConfig;

    expect(Object.keys(exported?.properties ?? {})).toEqual(
      expect.arrayContaining(["name", "customInstruction", "authoredDirectives", "surfaceSettings", "skillSettings"]),
    );
    expect(exported?.required ?? []).toContain("handoffOnRetrievalMiss");
  });
});
