import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const AgentParams = z.object({ agentId: z.string().uuid() });
const ConnectionParams = AgentParams.extend({ connectionId: z.string().uuid() });
const SkillParams = AgentParams.extend({ skillId: z.string().uuid() });

const ConnectionCreateSchema = z.object({
  displayName: z.string(),
  serverUrl: z.string().url(),
  authMethod: z.enum(["access_token", "oauth"]),
  accessToken: z.string().optional(),
});

const ConnectionSummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  serverUrl: z.string(),
  authMethod: z.string(),
  status: z.string(),
  hasCredential: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const DiscoveredToolsSchema = z.object({
  tools: z.array(z.object({ name: z.string(), description: z.string().optional(), inputSchema: z.unknown().optional() })),
});

const SkillCreateSchema = z.object({
  skillName: z.string(),
  connectionId: z.string().uuid(),
  toolName: z.string(),
  boundParams: z.record(z.unknown()).optional(),
  exposedParams: z.record(z.object({ slotBinding: z.string().optional() })).optional(),
  declaredOutcomes: z.array(z.string()).optional(),
  outcomeMap: z.record(z.string()).optional(),
  enabled: z.boolean().optional(),
});

const SkillViewSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  skillName: z.string(),
  toolName: z.string(),
  boundParams: z.record(z.unknown()),
  exposedParams: z.record(z.unknown()),
  declaredOutcomes: z.array(z.string()).nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const TAGS = ["External Skills"];

export const registerExternalSkillsPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const sec = [{ [security.bearerAuthScheme.name]: [] }];
  const json = <T>(schema: T) => ({ "application/json": { schema } });
  const errorResponse = (description: string) => ({ description, content: json(schemas.ErrorResponseSchema) });

  registry.registerPath({
    method: "get",
    path: "/api/v1/agents/{agentId}/mcp-connections",
    tags: TAGS,
    summary: "List an agent's MCP connections",
    operationId: "listMcpConnections",
    security: sec,
    request: { params: AgentParams },
    responses: {
      200: { description: "Connections", content: json(z.object({ connections: z.array(ConnectionSummarySchema) })) },
      401: errorResponse("Authentication required"),
      404: errorResponse("Agent not found"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/mcp-connections",
    tags: TAGS,
    summary: "Create an MCP connection",
    operationId: "createMcpConnection",
    security: sec,
    request: { params: AgentParams, body: { required: true, content: json(ConnectionCreateSchema) } },
    responses: {
      201: { description: "Connection created", content: json(ConnectionSummarySchema) },
      400: errorResponse("Request validation failed"),
      401: errorResponse("Authentication required"),
      404: errorResponse("Agent not found"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/mcp-connections/{connectionId}/discover",
    tags: TAGS,
    summary: "Discover a connection's tools",
    operationId: "discoverMcpConnectionTools",
    security: sec,
    request: { params: ConnectionParams },
    responses: {
      200: { description: "Discovered tools", content: json(DiscoveredToolsSchema) },
      401: errorResponse("Authentication required"),
      404: errorResponse("Connection not found"),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/agents/{agentId}/mcp-connections/{connectionId}",
    tags: TAGS,
    summary: "Delete an MCP connection",
    operationId: "deleteMcpConnection",
    security: sec,
    request: { params: ConnectionParams },
    responses: {
      204: { description: "Connection deleted" },
      401: errorResponse("Authentication required"),
      404: errorResponse("Connection not found"),
      409: errorResponse("Connection is still referenced by a skill"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/agents/{agentId}/external-skills",
    tags: TAGS,
    summary: "List an agent's external skill definitions",
    operationId: "listExternalSkills",
    security: sec,
    request: { params: AgentParams },
    responses: {
      200: { description: "Skill definitions", content: json(z.object({ skills: z.array(SkillViewSchema) })) },
      401: errorResponse("Authentication required"),
      404: errorResponse("Agent not found"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/external-skills",
    tags: TAGS,
    summary: "Define an external skill (bind a discovered tool)",
    operationId: "createExternalSkill",
    security: sec,
    request: { params: AgentParams, body: { required: true, content: json(SkillCreateSchema) } },
    responses: {
      201: { description: "Skill defined", content: json(SkillViewSchema) },
      400: errorResponse("Validation failed (unknown tool or param mismatch)"),
      401: errorResponse("Authentication required"),
      404: errorResponse("Agent or connection not found"),
      409: errorResponse("Skill name already used"),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/agents/{agentId}/external-skills/{skillId}",
    tags: TAGS,
    summary: "Delete an external skill definition",
    operationId: "deleteExternalSkill",
    security: sec,
    request: { params: SkillParams },
    responses: {
      204: { description: "Skill deleted" },
      401: errorResponse("Authentication required"),
      404: errorResponse("Skill not found"),
    },
  });
};
