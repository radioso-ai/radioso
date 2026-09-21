import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";
import {
  mcpConverseAskRequestSchema,
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
    method: "get",
    path: "/api/v1/mcp/converse/tools",
    tags: ["MCP Converse"],
    summary: "List the bound agent's exposed routines as tools",
    description: "Returns the agent's name and one descriptor per exposed routine in its current published release. A session reads the catalog once; a routine exposed or withdrawn after that shows up for the next session.",
    operationId: "getMcpConverseTools",
    security: [{ [security.mcpConverseSessionBearerAuthScheme.name]: [] }],
    responses: {
      200: {
        description: "The bound agent's tool catalog",
        content: json(schemas.McpConverseToolsResponseSchema),
      },
      401: errorResponse("Invalid converse session"),
      403: errorResponse("Converse session is no longer authorized"),
      429: errorResponse("MCP converse rate limit exceeded"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/mcp/converse/ask",
    tags: ["MCP Converse"],
    summary: "Run one turn through the bound agent: a message, or a tool call to an exposed routine",
    description: "Send exactly one of `message` or `routine`. A `routine` call is validated against the tool's `inputSchema` from the catalog before any turn state is written: an unknown tool returns 404 with `details.code` `routine_tool_unknown`; invalid input returns 400 with `details.code` `routine_invocation_invalid` and field-level `details.errors`.",
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
        description: "Agent reply envelope with the answer text and citations",
        content: json(schemas.McpConverseAskResponseSchema),
      },
      400: errorResponse("Routine invocation input did not match the tool's schema"),
      404: errorResponse("Routine tool is not in the agent's catalog"),
      409: errorResponse("Turn superseded by a newer message in the same conversation"),
      401: errorResponse("Invalid converse session"),
      403: errorResponse("Converse session is no longer authorized"),
      429: errorResponse("MCP converse ask rate limit exceeded"),
    },
  });

};
