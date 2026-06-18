import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const json = (schema: z.ZodTypeAny) => ({
  "application/json": {
    schema,
  },
});

const errorResponse = (description: string, schemas: OpenApiSchemas) => ({
  description,
  content: json(schemas.ErrorResponseSchema),
});

const decisionParamsSchema = z.object({
  agentId: z.string(),
  handle: z.string(),
});

const resolveDecisionRequestSchema = z.object({
  optionId: z.string(),
  payload: z.unknown().optional(),
  contentHash: z.string(),
}).strict();

const resolveDecisionResponseSchema = z.object({
  status: z.literal("resolved"),
  decision: z.enum(["approved", "rejected"]),
  conversationId: z.string(),
  resumed: z.boolean(),
});

export const registerDecisionPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/decisions/{handle}/resolve",
    tags: ["Agents"],
    summary: "Resolve a pending human approval decision",
    operationId: "resolveDecision",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: decisionParamsSchema,
      body: {
        required: true,
        content: json(resolveDecisionRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Decision resolved and routine resume attempted",
        content: json(resolveDecisionResponseSchema),
      },
      400: errorResponse("Request validation failed", schemas),
      401: errorResponse("Authentication required", schemas),
      403: errorResponse("Caller is not an authorized decider", schemas),
      404: errorResponse("Decision not found", schemas),
      409: errorResponse("Decision already resolved, stale, or resolved concurrently", schemas),
      422: errorResponse("Decision option is invalid", schemas),
    },
  });
};
