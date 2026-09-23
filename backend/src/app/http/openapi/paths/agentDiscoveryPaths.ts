import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { z } from "zod";

import type { OpenApiSchemas } from "../openApiRegistry.js";

/**
 * The public discovery documents. All three are unauthenticated, cacheable reads scoped to
 * one public id, and all three answer 404 identically for an id that is unknown, switched
 * off, unpublished, or deleted.
 */
export const registerAgentDiscoveryPaths = (registry: OpenAPIRegistry, schemas: OpenApiSchemas) => {
  const json = (schema: z.ZodTypeAny) => ({ "application/json": { schema } });
  const notFound = {
    description: "No public document for this id",
    content: json(schemas.ErrorResponseSchema),
  };

  const document = (input: {
    path: string;
    operationId: string;
    summary: string;
    schema: z.ZodTypeAny;
  }) => {
    registry.registerPath({
      method: "get",
      path: input.path,
      tags: ["Agent discovery"],
      summary: input.summary,
      operationId: input.operationId,
      request: { params: schemas.AgentPublicIdParamsSchema },
      responses: {
        200: {
          description: "Public document served",
          content: json(input.schema),
        },
        304: { description: "Document unchanged since the caller's ETag" },
        404: notFound,
        429: {
          description: "Discovery read rate limit exceeded",
          content: json(schemas.ErrorResponseSchema),
        },
      },
    });
  };

  document({
    path: "/.well-known/agent-card/{publicId}.json",
    operationId: "getAgentCard",
    summary: "Read an agent's A2A Agent Card",
    schema: schemas.A2aAgentCardSchema,
  });
  document({
    path: "/.well-known/mcp/server-card/{publicId}.json",
    operationId: "getAgentMcpServerCard",
    summary: "Read an agent's MCP server card",
    schema: schemas.McpServerCardSchema,
  });
  document({
    path: "/.well-known/ai-catalog/{publicId}.json",
    operationId: "getAgentAiCatalog",
    summary: "Read an agent's catalog entry",
    schema: schemas.AiCatalogSchema,
  });
};
