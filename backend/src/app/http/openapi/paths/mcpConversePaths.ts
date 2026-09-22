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
    summary: "Exchange a launch token or an agent's public id for a signed converse session",
    description: "Send exactly one of `launchToken` or `publicId`. A `launchToken` is the credential an operator minted for this agent. A `publicId` is the agent's public identifier and carries no secret: it works only while the agent accepts walk-in connections, and it opens a fresh conversation each time. Rotating the public id or closing walk-in access refuses the next request on every session issued against it.",
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
      403: errorResponse("Grant channel or bound agent is not allowed, or the agent does not accept walk-in connections"),
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
    description: "Returns the agent's name and one descriptor per exposed routine in its current published release, on every call. The standalone MCP server reads this once at session exchange and pins the result, so an MCP client's `tools/list` is stable for a session; a direct caller sees the current catalog each time.",
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
    description: "Send exactly one of `message` or `routine`. An optional `signedIdentity` is the same HMAC visitor token the website embed sends, bound to this session's `conversationId` rather than a browser origin; one that does not verify leaves the turn anonymous. A `routine` call is validated against the tool's `inputSchema` from the catalog before any turn state is written: an unknown tool returns 404 with `details.code` `routine_tool_unknown`; invalid input returns 400 whose `details` is `RoutineInvocationInvalidDetails` (`code` `routine_invocation_invalid`, field-level `errors`).",
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
      400: errorResponse("Routine invocation input did not match the tool's schema (`details` is `RoutineInvocationInvalidDetails`), or the body failed validation"),
      404: errorResponse("Routine tool is not in the agent's catalog"),
      409: errorResponse("Turn superseded by a newer message in the same conversation"),
      401: errorResponse("Invalid converse session"),
      403: errorResponse("Converse session is no longer authorized"),
      429: errorResponse("MCP converse ask rate limit exceeded"),
    },
  });

};
