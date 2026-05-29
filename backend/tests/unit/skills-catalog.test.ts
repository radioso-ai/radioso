import { describe, expect, it } from "vitest";

import {
  createDefaultSkillCatalogRegistry,
  SkillCatalogService,
  skillDiagnosticFieldNames,
  skillExecutionSchema,
  skillIntakeDefinitionSchema,
  validateSkillDiagnostic,
} from "../../src/modules/skills/public.js";
import { capabilityNames, StrictCapabilityPolicy } from "../../src/shared/domain/capabilityPolicy.js";

describe("skills catalog", () => {
  it("lists stable built-in skill metadata with shared intake and execution contracts", async () => {
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
      supportedCallers: ["assistant", "retrieval_api", "sdk", "mcp"],
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
        shapeAware: true,
        strategyAware: true,
      },
      schemaReferences: {
        inputSchemaRef: "RetrievalAnswerRequest",
        settingsSchemaRef: "RetrievalSettingsOverride",
      },
      intake: expect.objectContaining({
        fields: expect.arrayContaining([
          expect.objectContaining({ name: "query", type: "string", required: true }),
        ]),
      }),
      execution: {
        kind: "internal",
        adapter: "retrieval_answer",
        enqueue: false,
      },
      steps: expect.arrayContaining([
        expect.objectContaining({ name: "context_selection", kind: "context_selection" }),
      ]),
      shapes: expect.arrayContaining([
        expect.objectContaining({ name: "definition_lookup" }),
      ]),
      outcomes: expect.arrayContaining([
        expect.objectContaining({ name: "grounded", status: "completed", groundedAnswer: true }),
        expect.objectContaining({ name: "no_context", status: "completed" }),
      ]),
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
      "shapeName",
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
      shapeName: "definition_lookup",
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
        retrievalShape: "definition_lookup",
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

  it("validates shared intake and execution metadata without treating it as a generic endpoint", () => {
    const registry = createDefaultSkillCatalogRegistry([
      {
        name: "appointments.schedule",
        displayName: "Appointment schedule",
        description: "Schedule an appointment through a configured delivery adapter.",
        display: {
          icon: "calendar",
          title: "Book an appointment",
        },
        owner: "platform",
        executionClass: "interactive",
        supportedCallers: ["assistant", "public_embed"],
        requiredCapabilities: [],
        contractReferences: [
          {
            kind: "documentation",
            label: "Appointment scheduling setup",
            path: "docs/appointment-scheduling.md",
          },
        ],
        diagnostics: {
          defined: true,
          shapeAware: false,
          strategyAware: false,
        },
        intake: {
          enabled: true,
          supportedCallers: ["assistant", "public_embed"],
          intent: {
            description: "Schedule an appointment using an email address and preferred date.",
            examples: ["Schedule a demo", "Book an appointment for tomorrow"],
          },
          fields: [
            {
              name: "email",
              displayName: "email address",
              type: "email",
              required: true,
              sensitive: true,
              ttlSeconds: 900,
            },
            {
              name: "preferred_date",
              displayName: "preferred date",
              type: "date",
              required: true,
            },
          ],
          confirmation: "none",
          interruptionPolicy: "pause_and_resume",
        },
        execution: {
          kind: "webhook",
          provider: "make",
          endpointId: "appointment_schedule",
          enqueue: false,
          timeoutMs: 15_000,
        },
      },
    ]);
    const entry = registry.get("appointments.schedule");

    expect(skillIntakeDefinitionSchema.safeParse(entry?.intake).success).toBe(true);
    expect(skillExecutionSchema.safeParse(entry?.execution).success).toBe(true);
    expect(entry?.intake).toMatchObject({
      enabled: true,
      fields: expect.arrayContaining([
        expect.objectContaining({ name: "email", type: "email", sensitive: true }),
        expect.objectContaining({ name: "preferred_date", type: "date" }),
      ]),
    });
    expect(entry?.execution).toMatchObject({
      kind: "webhook",
      provider: "make",
      endpointId: "appointment_schedule",
      enqueue: false,
      timeoutMs: 15_000,
    });
    expect(entry?.display).toEqual({
      icon: "calendar",
      title: "Book an appointment",
    });
    expect(entry?.contractReferences).not.toContainEqual(expect.objectContaining({
      path: expect.stringContaining("/skills/"),
    }));
  });

  it("uses the same interface for retrieval and contact-style skill definitions", () => {
    const retrieval = createDefaultSkillCatalogRegistry().get("retrieval.answer");

    expect(retrieval).toMatchObject({
      intake: expect.objectContaining({
        fields: expect.arrayContaining([
          expect.objectContaining({ name: "query", required: true }),
        ]),
      }),
      execution: {
        kind: "internal",
        adapter: "retrieval_answer",
        enqueue: false,
      },
    });
  });
});
