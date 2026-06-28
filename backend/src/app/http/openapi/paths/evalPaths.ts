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
  })
  .strict();

const EvalOneOffRunRequestSchema = z
  .object({
    snapshotId: z.string().uuid(),
    mode: z.enum(["retrieval_only", "full_assistant"]).default("retrieval_only"),
    overrides: EvalRunOverridesSchema.optional(),
    agentConfigOverride: AgentConfigOverrideSchema.optional(),
  });

const EvalWorkbenchReplayRunResponseSchema = z
  .object({
    run: z.unknown(),
    case: z.unknown().nullable(),
    answer: z.string().optional(),
    citations: z.array(z.unknown()).optional(),
    answerSegments: z.array(z.unknown()).optional(),
    turnTrace: z.unknown().optional(),
    resolvedConfig: z.unknown(),
  });

const EvalCaseParamsSchema = z.object({
  id: z.string().uuid(),
});

export const registerEvalPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
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
