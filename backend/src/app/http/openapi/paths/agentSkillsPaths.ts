import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const AgentParams = z.object({ agentId: z.string().uuid() });
const AgentSkillParams = AgentParams.extend({ skillId: z.string().uuid() });
const InvocationModeSchema = z.enum(["default_answer", "routine_named", "agent_selectable"]);
const CapabilityIdSchema = z.enum(["retrieve", "mcp_tool", "email", "slack_post", "webhook_call", "notify"]);

const AgentSkillTargetSchema = z.object({
  kind: z.string(),
  id: z.string().uuid().nullable(),
});

const AgentSkillCreateSchema = z.object({
  name: z.string(),
  capability: CapabilityIdSchema,
  target: AgentSkillTargetSchema,
  config: z.record(z.unknown()).default({}),
  invocationMode: InvocationModeSchema.default("routine_named"),
  enabled: z.boolean().default(true),
});

const AgentSkillUpdateSchema = z.object({
  target: AgentSkillTargetSchema.optional(),
  config: z.record(z.unknown()).optional(),
  invocationMode: InvocationModeSchema.optional(),
  enabled: z.boolean().optional(),
});

const AgentSkillSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid(),
  name: z.string(),
  capability: CapabilityIdSchema,
  storedKind: z.string(),
  target: AgentSkillTargetSchema,
  config: z.record(z.unknown()),
  invocationMode: InvocationModeSchema,
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const CapabilityTargetSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.string().optional(),
});

const CapabilitySettingsFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["boolean", "number", "text", "textarea", "select", "string_list", "source_scope"]),
  help: z.string().optional(),
  options: z.array(z.object({
    value: z.string(),
    label: z.string(),
  })).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  group: z.string().optional(),
  advanced: z.boolean().optional(),
  defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const CapabilitySchema = z.object({
  id: CapabilityIdSchema,
  storedKind: z.string(),
  targetKind: z.string(),
  requiresTarget: z.boolean(),
  inputSchema: z.union([
    z.object({ source: z.literal("discovered") }),
    z.object({ source: z.literal("static"), schema: z.record(z.unknown()) }),
  ]),
  settingsFields: z.array(CapabilitySettingsFieldSchema),
  outcomeVocabulary: z.array(z.string()),
  supportedInvocationModes: z.array(InvocationModeSchema),
  defaultInvocationMode: InvocationModeSchema.optional(),
  executorAdapter: z.string(),
  targets: z.array(CapabilityTargetSchema),
  available: z.boolean(),
  unavailableReason: z.literal("no_connection").nullable(),
});

export const registerAgentSkillsPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const sec = [{ [security.bearerAuthScheme.name]: [] }];
  const json = <T>(schema: T) => ({ "application/json": { schema } });
  const errorResponse = (description: string) => ({ description, content: json(schemas.ErrorResponseSchema) });
  const skillResponse = json(z.object({ skill: AgentSkillSchema }));

  registry.registerPath({
    method: "get",
    path: "/api/v1/agents/{agentId}/skill-capabilities",
    tags: ["Agent Skills"],
    summary: "List agent skill capabilities",
    operationId: "listAgentSkillCapabilities",
    security: sec,
    request: { params: AgentParams },
    responses: {
      200: { description: "Skill capabilities", content: json(z.object({ capabilities: z.array(CapabilitySchema) })) },
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent read permission required"),
      404: errorResponse("Agent not found"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/agents/{agentId}/skills",
    tags: ["Agent Skills"],
    summary: "List agent skills",
    operationId: "listAgentSkills",
    security: sec,
    request: { params: AgentParams },
    responses: {
      200: { description: "Agent skills", content: json(z.object({ skills: z.array(AgentSkillSchema) })) },
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent read permission required"),
      404: errorResponse("Agent not found"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/skills",
    tags: ["Agent Skills"],
    summary: "Create an agent skill",
    operationId: "createAgentSkill",
    security: sec,
    request: { params: AgentParams, body: { required: true, content: json(AgentSkillCreateSchema) } },
    responses: {
      201: { description: "Agent skill", content: skillResponse },
      400: errorResponse("Invalid skill definition"),
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent manage permission required"),
      404: errorResponse("Agent not found"),
      409: errorResponse("Skill name or default-answer already exists"),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/v1/agents/{agentId}/skills/{skillId}",
    tags: ["Agent Skills"],
    summary: "Update an agent skill",
    operationId: "updateAgentSkill",
    security: sec,
    request: { params: AgentSkillParams, body: { required: true, content: json(AgentSkillUpdateSchema) } },
    responses: {
      200: { description: "Agent skill", content: skillResponse },
      400: errorResponse("Invalid skill definition"),
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent manage permission required"),
      404: errorResponse("Agent or skill not found"),
      409: errorResponse("Default-answer already exists"),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/agents/{agentId}/skills/{skillId}",
    tags: ["Agent Skills"],
    summary: "Delete an agent skill",
    operationId: "deleteAgentSkill",
    security: sec,
    request: { params: AgentSkillParams },
    responses: {
      204: { description: "Deleted" },
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent manage permission required"),
      404: errorResponse("Agent or skill not found"),
    },
  });
};
