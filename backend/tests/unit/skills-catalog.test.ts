import { describe, expect, it } from "vitest";

import {
  createDefaultSkillCatalogRegistry,
  SkillCatalogService,
  skillDiagnosticFieldNames,
  validateSkillDiagnostic,
} from "../../src/modules/skills/public.js";
import { capabilityNames, StrictCapabilityPolicy } from "../../src/shared/domain/capabilityPolicy.js";

describe("skills catalog", () => {
  it("lists stable built-in skill metadata without generic execution contracts", async () => {
    const service = new SkillCatalogService({
      capabilityPolicy: new StrictCapabilityPolicy({ deniedCapabilities: [] }),
      registry: createDefaultSkillCatalogRegistry(),
    });

    const catalog = await service.list({
      workspaceId: "workspace-1",
      accountId: "account-1",
      userId: "user-1",
    });

    expect(catalog.skills.map((skill) => skill.name)).toEqual([
      "assistant.chat",
      "retrieval.search",
      "retrieval.answer",
      "documents.ingest",
      "documents.search",
      "documents.delete",
      "mcp.describe_capabilities",
    ]);
    expect(catalog.skills.find((skill) => skill.name === "retrieval.answer")).toMatchObject({
      owner: "retrieval",
      executionClass: "interactive",
      availability: { state: "available" },
      supportedCallers: ["retrieval_api", "sdk", "mcp"],
      requiredCapabilities: [capabilityNames.retrieval.answer],
      contractReferences: expect.arrayContaining([
        expect.objectContaining({
          kind: "http",
          method: "POST",
          path: "/api/v1/retrieval/answer",
        }),
      ]),
      diagnostics: {
        defined: true,
        strategyAware: true,
      },
    });
    for (const skill of catalog.skills) {
      expect(skill.contractReferences).not.toContainEqual(expect.objectContaining({
        path: expect.stringContaining("/skills/"),
      }));
    }
  });

  it("marks denied skills as forbidden without removing canonical metadata", async () => {
    const service = new SkillCatalogService({
      capabilityPolicy: new StrictCapabilityPolicy({
        deniedCapabilities: [capabilityNames.documents.delete],
      }),
      registry: createDefaultSkillCatalogRegistry(),
    });

    const skill = await service.get("documents.delete", {
      workspaceId: "workspace-1",
      accountId: "account-1",
      userId: "user-1",
    });

    expect(skill).toMatchObject({
      name: "documents.delete",
      availability: {
        state: "forbidden",
        reason: "capability_denied",
      },
      requiredCapabilities: [capabilityNames.documents.delete],
    });
  });

  it("does not report capability denial for skills whose current contracts do not enforce that policy yet", async () => {
    const service = new SkillCatalogService({
      capabilityPolicy: new StrictCapabilityPolicy({
        deniedCapabilities: [capabilityNames.retrieval.answer],
      }),
      registry: createDefaultSkillCatalogRegistry(),
    });

    const skill = await service.get("retrieval.answer", {
      workspaceId: "workspace-1",
      accountId: "account-1",
      userId: "user-1",
    });

    expect(skill).toMatchObject({
      name: "retrieval.answer",
      availability: {
        state: "available",
      },
      requiredCapabilities: [capabilityNames.retrieval.answer],
    });
  });

  it("returns null for unknown skills", async () => {
    const service = new SkillCatalogService({
      capabilityPolicy: new StrictCapabilityPolicy({ deniedCapabilities: [] }),
      registry: createDefaultSkillCatalogRegistry(),
    });

    await expect(service.get("not.real", {
      workspaceId: "workspace-1",
      accountId: "account-1",
      userId: "user-1",
    })).resolves.toBeNull();
  });

  it("validates deterministic, retrieval, and unsupported diagnostic shapes", () => {
    expect(skillDiagnosticFieldNames).toEqual(expect.arrayContaining([
      "skillName",
      "strategy",
      "selectionMode",
      "capabilityChecks",
      "fallback",
      "outcome",
      "evidence",
    ]));

    expect(validateSkillDiagnostic({
      skillName: "documents.delete",
      selectionMode: "deterministic",
      callerSurface: "dashboard",
      capabilityChecks: [{ capability: capabilityNames.documents.delete, allowed: true }],
      outcome: "success",
    }).success).toBe(true);

    expect(validateSkillDiagnostic({
      skillName: "retrieval.answer",
      strategy: "definition_lookup",
      selectionMode: "probabilistic",
      selectionReason: "query_shape_definition",
      selectionConfidence: 0.86,
      callerSurface: "retrieval_api",
      capabilityChecks: [{ capability: capabilityNames.retrieval.answer, allowed: true }],
      parameters: { topK: 8 },
      outcome: "success",
      evidence: {
        queryShape: "definition_lookup",
        retrievalStrategy: "definition_lookup",
        evidenceStatus: "found",
        supportStatus: "supported",
        groundingOutcome: "grounded_success",
      },
    }).success).toBe(true);

    expect(validateSkillDiagnostic({
      skillName: "retrieval.answer",
      selectionMode: "deterministic",
      callerSurface: "mcp",
      capabilityChecks: [],
      outcome: "unsupported",
      error: { code: "unsupported_query_type" },
      fallback: { used: false },
    }).success).toBe(true);
  });
});
