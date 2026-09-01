import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";
import {
  mcpConverseAskRequestSchema,
  mcpConverseAskResponseSchema,
  mcpConverseSessionRequestSchema,
  mcpConverseSessionResponseSchema,
  mcpConverseSessionValidateRequestSchema,
  mcpConverseSessionValidateResponseSchema,
} from "../../schemas/mcpConverseSchemas.js";

export const registerMcpConversePaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const json = <T>(schema: T) => ({ "application/json": { schema } });
  const errorResponse = (description: string) => ({
    description,
    content: json(schemas.ErrorResponseSchema),
  });

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
          ...json(mcpConverseSessionRequestSchema),
        },
      },
    },
    responses: {
      201: {
        description: "MCP converse session issued",
        content: {
          ...json(mcpConverseSessionResponseSchema),
        },
      },
      401: errorResponse("Invalid converse grant"),
      403: errorResponse("Grant channel or bound agent is not allowed"),
      429: errorResponse("MCP converse session rate limit exceeded"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/mcp/converse/session/validate",
    tags: ["MCP Converse"],
    summary: "Validate and re-evaluate an MCP converse session",
    operationId: "validateMcpConverseSession",
    request: {
      body: {
        required: true,
        content: json(mcpConverseSessionValidateRequestSchema),
      },
    },
    responses: {
      200: {
        description: "MCP converse session is valid",
        content: json(mcpConverseSessionValidateResponseSchema),
      },
      401: errorResponse("Invalid or expired converse session"),
      403: errorResponse("Underlying converse grant is no longer valid"),
      429: errorResponse("MCP converse session rate limit exceeded"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/mcp/converse/ask",
    tags: ["MCP Converse"],
    summary: "Run one MCP ask_agent turn through the bound agent",
    operationId: "askMcpConverseAgent",
    security: [{ [security.mcpConverseSessionBearerAuthScheme.name]: [] }],
    request: {
      body: {
        required: true,
        content: json(mcpConverseAskRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Agent answer",
        content: json(mcpConverseAskResponseSchema),
      },
      409: errorResponse("Turn superseded by a newer message in the same conversation"),
      401: errorResponse("Invalid converse session"),
      403: errorResponse("Converse session is no longer authorized"),
      429: errorResponse("MCP converse ask rate limit exceeded"),
    },
  });

};
