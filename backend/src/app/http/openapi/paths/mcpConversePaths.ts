import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const mcpConverseSessionRequestSchema = z.object({
  launchToken: z.string().min(1),
  client: z.object({
    name: z.string().min(1),
    version: z.string().min(1).optional(),
  }).optional(),
});

const mcpConverseSessionResponseSchema = z.object({
  sessionToken: z.string(),
  expiresAt: z.string().datetime(),
  resumeToken: z.string().optional(),
  agent: z.object({
    id: z.string().uuid(),
    name: z.string(),
  }),
  conversationId: z.string().uuid(),
});

export const registerMcpConversePaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  _security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "post",
    path: "/api/v1/mcp/converse/session",
    tags: ["MCP Converse"],
    summary: "Exchange an MCP converse launch token for a signed session",
    operationId: "createMcpConverseSession",
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: mcpConverseSessionRequestSchema,
          },
        },
      },
    },
    responses: {
      201: {
        description: "MCP converse session issued",
        content: {
          "application/json": {
            schema: mcpConverseSessionResponseSchema,
          },
        },
      },
      401: {
        description: "Invalid converse grant",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      403: {
        description: "Grant channel or bound agent is not allowed",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });
};
