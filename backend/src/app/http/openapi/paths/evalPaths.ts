import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const AgentConfigOverrideSchema = z
  .object({
    name: z.string().optional(),
    customInstruction: z.string().optional(),
    contactRequestsEnabled: z.boolean().optional(),
    webhookExportsEnabled: z.boolean().optional(),
    contactRequestDelivery: z.unknown().optional(),
    logo: z.unknown().nullable().optional(),
    theme: z.record(z.string(), z.unknown()).optional(),
    branding: z.record(z.string(), z.unknown()).optional(),
    greetingInstruction: z.string().optional(),
    assistantDefaultLocale: z.string().nullable().optional(),
    proactiveGreetingEnabled: z.boolean().optional(),
    surfaceSettings: z.record(z.string(), z.unknown()).optional(),
    skillSettings: z.record(z.string(), z.unknown()).optional(),
    chatModelOverride: z
      .object({
        provider: z.enum(["openai", "openai-compatible", "gemini", "claude"]),
        model: z.string(),
      })
      .nullable()
      .optional(),
    authoredDirectives: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .strict();

const EvalRunOverridesSchema = z
  .object({
    modelOverride: z
      .object({
        provider: z.enum(["openai", "openai-compatible", "gemini", "claude"]),
        model: z.string(),
      })
      .optional(),
    assistantInstructionsOverride: z
      .object({
        customInstruction: z.string().optional(),
      })
      .optional(),
    retrievalSettingsOverride: z.record(z.string(), z.unknown()).optional(),
    agentConfigOverride: AgentConfigOverrideSchema.optional(),
    routineStartState: z
      .object({
        routineId: z.string(),
        path: z.array(z.string()).min(1),
        variables: z.record(z.string(), z.unknown()),
        attempts: z.record(z.string(), z.number().int()).optional(),
        status: z.enum(["active", "suspended", "completed", "expired"]),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const EvalOneOffRunRequestSchema = z
  .object({
    snapshotId: z.string().uuid(),
    mode: z.enum(["retrieval_only", "full_assistant"]).default("retrieval_only"),
    overrides: EvalRunOverridesSchema.optional(),
    agentConfigOverride: AgentConfigOverrideSchema.optional(),
  });

const GroundingVerdictSchema = z.enum(["grounded", "degraded", "no_support"]);

const GroundingDiagnosticsSchema = z
  .object({
    protocolVersion: z.union([z.literal(1), z.literal(2), z.null()]),
    parseStatus: z.enum(["valid_v2", "legacy_v1", "missing", "malformed", "invalid_v2"]),
    claimCount: z.number().int(),
    sourcedClaimCount: z.number().int(),
    unsourcedClaimCount: z.number().int(),
    invalidSourceCount: z.number().int(),
    assertionMismatch: z.boolean(),
  });

const EvalWorkbenchReplayRunResponseSchema = z
  .object({
    run: z.unknown(),
    case: z.unknown().nullable(),
    answer: z.string().optional(),
    citations: z.array(z.unknown()).optional(),
    answerSegments: z.array(z.unknown()).optional(),
    groundingVerdict: GroundingVerdictSchema.optional(),
    groundingDiagnostics: GroundingDiagnosticsSchema.optional(),
    turnTrace: z.unknown().optional(),
    resolvedConfig: z.unknown(),
  });

const EvalCaseParamsSchema = z.object({
  id: z.string().uuid(),
});

const EvalSourceMessageParamsSchema = z.object({
  assistantMessageId: z.string().uuid(),
});

const EvalCaseSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  snapshotId: z.string().uuid(),
  name: z.string(),
  assertions: z.array(z.unknown()),
  status: z.enum(["pending", "passing", "failing", "error"]),
  lastRunId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const EvalSnapshotMessageSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  createdAt: z.string().datetime(),
  citations: z.array(z.unknown()).optional(),
  answerSegments: z.array(z.unknown()).optional(),
  groundingSummary: z.unknown().optional(),
  directiveFirings: z.array(z.string()).optional(),
});

const EvalSnapshotSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  sourceConversationId: z.string().uuid(),
  sourceMessageId: z.string().uuid().nullable(),
  replayTarget: z.object({
    userMessageId: z.string().uuid(),
    assistantMessageId: z.string().uuid().nullable(),
  }).nullable(),
  fidelity: z.enum(["full", "messages_only"]),
  messages: z.array(EvalSnapshotMessageSchema),
  originalInstructionBlock: z.string().nullable(),
  originalModelId: z.string().nullable(),
  originalRetrievalSettings: z.unknown().nullable(),
  originalAgent: z.unknown().nullable(),
  originalAgentConfig: z.unknown().nullable(),
  sourceAgentId: z.string().uuid().nullable(),
  originalRoutineState: z.unknown().nullable(),
  originalRetrievalResult: z.array(z.unknown()).nullable(),
  conversationSummary: z.string().optional(),
  capturedAt: z.string().datetime(),
  capturedBy: z.string().uuid().nullable(),
});

const EvalMessageCaseLookupSchema = z.object({
  assistantMessageId: z.string().uuid(),
  case: EvalCaseSchema,
  snapshot: EvalSnapshotSchema,
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
});

export const registerEvalPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const RegisteredEvalMessageCaseLookupSchema = registry.register(
    "EvalMessageCaseLookup",
    EvalMessageCaseLookupSchema,
  );
  const RegisteredEvalMessageCaseMutationResultSchema = registry.register(
    "EvalMessageCaseMutationResult",
    RegisteredEvalMessageCaseLookupSchema.and(z.object({
      created: z.boolean().describe("True only when this request created the association."),
    })),
  );

  registry.registerPath({
    method: "get",
    path: "/api/v1/evals/cases/by-source-message/{assistantMessageId}",
    tags: ["Evals"],
    summary: "Get the Eval case linked to an assistant message",
    description:
      "Returns the linked case and its immutable snapshot in one request. The lookup is workspace-scoped and never scans the case list.",
    operationId: "getEvalCaseBySourceMessage",
    security: [
      { [security.sessionCookieScheme.name]: [], [security.workspaceSelectionScheme.name]: [] },
      { [security.bearerAuthScheme.name]: [] },
    ],
    request: {
      params: EvalSourceMessageParamsSchema,
    },
    responses: {
      200: {
        description: "The linked Eval case and snapshot",
        content: {
          "application/json": {
            schema: RegisteredEvalMessageCaseLookupSchema,
          },
        },
      },
      400: {
        description: "Invalid assistant message id",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      401: {
        description: "Authentication required",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      403: {
        description: "Caller lacks workspace retrieval-query permission",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "No Eval case is linked to this assistant message",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/v1/evals/cases/by-source-message/{assistantMessageId}",
    tags: ["Evals"],
    summary: "Get or create an Eval case from an assistant message",
    description:
      "Atomically captures the source turn and creates its default Eval case, or returns the existing association. Concurrent retries converge on one case.",
    operationId: "getOrCreateEvalCaseBySourceMessage",
    security: [
      { [security.sessionCookieScheme.name]: [], [security.workspaceSelectionScheme.name]: [] },
      { [security.bearerAuthScheme.name]: [] },
    ],
    request: {
      params: EvalSourceMessageParamsSchema,
    },
    responses: {
      200: {
        description: "Existing linked Eval case and snapshot",
        content: {
          "application/json": {
            schema: RegisteredEvalMessageCaseMutationResultSchema,
          },
        },
      },
      201: {
        description: "New linked Eval case and immutable snapshot",
        content: {
          "application/json": {
            schema: RegisteredEvalMessageCaseMutationResultSchema,
          },
        },
      },
      400: {
        description: "Invalid id or source message is not an AI-authored assistant turn",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      401: {
        description: "Authentication required",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      403: {
        description: "Caller lacks workspace retrieval-query permission",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Assistant message not found in this workspace",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/evals/cases/{id}",
    tags: ["Evals"],
    summary: "Delete an eval case",
    operationId: "deleteEvalCase",
    security: [
      { [security.sessionCookieScheme.name]: [], [security.workspaceSelectionScheme.name]: [] },
      { [security.bearerAuthScheme.name]: [] },
    ],
    request: {
      params: EvalCaseParamsSchema,
    },
    responses: {
      204: {
        description: "Eval case deleted. Historical runs are retained without a case association.",
      },
      401: {
        description: "Authentication required",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Eval case not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/evals/runs",
    tags: ["Evals"],
    summary: "Run a one-off eval snapshot replay",
    operationId: "createEvalRun",
    security: [
      { [security.sessionCookieScheme.name]: [], [security.workspaceSelectionScheme.name]: [] },
      { [security.bearerAuthScheme.name]: [] },
    ],
    request: {
      body: {
        content: {
          "application/json": {
            schema: EvalOneOffRunRequestSchema,
          },
        },
      },
    },
    responses: {
      201: {
        description: "Eval run recorded. Workbench replay runs also include answer, citations, turnTrace, and resolvedConfig at the top level.",
        content: {
          "application/json": {
            schema: EvalWorkbenchReplayRunResponseSchema,
          },
        },
      },
      400: {
        description: "Invalid snapshot, mode, or override payload",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      401: {
        description: "Authentication required",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      429: {
        description: "Workbench replay rate limit exceeded",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });
};
