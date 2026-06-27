import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const WorkspaceParams = z.object({ workspaceId: z.string().uuid() });
const ConnectionParams = WorkspaceParams.extend({ connectionId: z.string().uuid() });
const AgentParams = z.object({ agentId: z.string().uuid() });
const EmailSkillParams = AgentParams.extend({ skillId: z.string().uuid() });
const ActivityQuery = z.object({
  agentId: z.string().uuid().optional(),
  connectionId: z.string().uuid().optional(),
  skillDefinitionId: z.string().uuid().optional(),
  outcome: z.enum([
    "drafted",
    "sent",
    "missing_input",
    "disabled_connection",
    "needs_reauth",
    "provider_rejected",
    "failed",
  ]).optional(),
  createdFrom: z.string().datetime().optional(),
  createdTo: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const CustomerEmailConnectionCreateSchema = z.object({
  oauthConnectionId: z.string().uuid(),
  displayName: z.string(),
  senderEmail: z.string().email(),
  senderName: z.string().nullable().optional(),
  replyToEmail: z.string().email().nullable().optional(),
});

const CustomerEmailConnectionUpdateSchema = z.object({
  displayName: z.string().optional(),
  senderEmail: z.string().email().optional(),
  senderName: z.string().nullable().optional(),
  replyToEmail: z.string().email().nullable().optional(),
  disabled: z.boolean().optional(),
});

const CustomerEmailConnectionSummarySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string(),
  oauthConnectionId: z.string().uuid(),
  provider: z.string(),
  displayName: z.string(),
  senderEmail: z.string(),
  senderName: z.string().nullable(),
  replyToEmail: z.string().nullable(),
  status: z.enum(["authorized", "disabled", "needs_reauth", "error"]),
  lastHealthStatus: z.enum(["ok", "failed", "unknown"]).nullable(),
  lastHealthCheckedAt: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  updatedAt: z.string(),
});

const EmailSkillBoundInputsSchema = z.record(z.unknown());
const EmailSkillExposedInputsSchema = z.record(z.object({
  description: z.string().optional(),
  slotBinding: z.string().optional(),
}));
const EmailSkillModeSchema = z.enum(["draft", "send"]);
const EmailSkillOutcomesSchema = z.enum([
  "drafted",
  "sent",
  "missing_input",
  "disabled_connection",
  "needs_reauth",
  "provider_rejected",
  "failed",
]);

const EmailSkillDefinitionCreateSchema = z.object({
  skillName: z.string(),
  connectionId: z.string().uuid(),
  mode: EmailSkillModeSchema.default("draft"),
  boundInputs: EmailSkillBoundInputsSchema.default({}),
  exposedInputs: EmailSkillExposedInputsSchema.default({}),
  enabled: z.boolean().default(true),
});

const EmailSkillDefinitionUpdateSchema = z.object({
  mode: EmailSkillModeSchema.optional(),
  boundInputs: EmailSkillBoundInputsSchema.optional(),
  exposedInputs: EmailSkillExposedInputsSchema.optional(),
  enabled: z.boolean().optional(),
});

const EmailSkillDefinitionSummarySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid(),
  connectionId: z.string().uuid(),
  skillName: z.string(),
  mode: EmailSkillModeSchema,
  boundInputs: EmailSkillBoundInputsSchema,
  exposedInputs: EmailSkillExposedInputsSchema,
  enabled: z.boolean(),
  outcomes: z.array(EmailSkillOutcomesSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const EmailSkillRecipientSummarySchema = z.object({
  toCount: z.number().int().nonnegative(),
  ccCount: z.number().int().nonnegative(),
  domains: z.array(z.string()),
  redactedRecipients: z.array(z.string()),
});

const EmailSkillActivitySummarySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid(),
  routineId: z.string().uuid().nullable(),
  conversationId: z.string().uuid().nullable(),
  skillDefinitionId: z.string().uuid(),
  connectionId: z.string().uuid(),
  skillName: z.string(),
  mode: EmailSkillModeSchema,
  outcome: EmailSkillOutcomesSchema,
  recipientSummary: EmailSkillRecipientSummarySchema,
  providerMessageId: z.string().nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.string(),
});

const EmailOauthConnectionSummarySchema = z.object({
  id: z.string().uuid(),
  provider: z.string(),
  displayName: z.string(),
  status: z.enum(["pending", "authorized", "needs_reauth", "disabled", "error"]),
  grantedScopes: z.array(z.string()),
  providerAccountId: z.string().nullable(),
  updatedAt: z.string(),
});

const CONNECTION_TAGS = ["Customer Email Connections"];
const SKILL_TAGS = ["Customer Email Skills"];
const ACTIVITY_TAGS = ["Customer Email Activity"];

export const registerCustomerEmailPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const sec = [{ [security.bearerAuthScheme.name]: [] }];
  const json = <T>(schema: T) => ({ "application/json": { schema } });
  const errorResponse = (description: string) => ({ description, content: json(schemas.ErrorResponseSchema) });
  const connectionResponse = json(z.object({ connection: CustomerEmailConnectionSummarySchema }));

  registry.registerPath({
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/email-skill-activity",
    tags: ACTIVITY_TAGS,
    summary: "List sanitized workspace customer email skill activity",
    operationId: "listWorkspaceEmailSkillActivity",
    security: sec,
    request: { params: WorkspaceParams, query: ActivityQuery },
    responses: {
      200: { description: "Sanitized email skill activity", content: json(z.object({ activities: z.array(EmailSkillActivitySummarySchema) })) },
      400: errorResponse("Invalid activity query"),
      401: errorResponse("Authentication required"),
      403: errorResponse("Workspace settings permission required"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/email-connections",
    tags: CONNECTION_TAGS,
    summary: "List workspace customer email connections",
    operationId: "listWorkspaceEmailConnections",
    security: sec,
    request: { params: WorkspaceParams },
    responses: {
      200: { description: "Customer email connections", content: json(z.object({ connections: z.array(CustomerEmailConnectionSummarySchema) })) },
      401: errorResponse("Authentication required"),
      403: errorResponse("Workspace settings permission required"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/email-oauth-connections",
    tags: CONNECTION_TAGS,
    summary: "List OAuth connections eligible to back a customer email connection",
    operationId: "listWorkspaceEmailOauthConnections",
    security: sec,
    request: { params: WorkspaceParams },
    responses: {
      200: { description: "Email-eligible OAuth connections", content: json(z.object({ connections: z.array(EmailOauthConnectionSummarySchema) })) },
      401: errorResponse("Authentication required"),
      403: errorResponse("Workspace settings permission required"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/email-connections",
    tags: CONNECTION_TAGS,
    summary: "Create a workspace customer email connection",
    operationId: "createWorkspaceEmailConnection",
    security: sec,
    request: { params: WorkspaceParams, body: { required: true, content: json(CustomerEmailConnectionCreateSchema) } },
    responses: {
      201: { description: "Customer email connection", content: connectionResponse },
      400: errorResponse("Invalid input or OAuth connection is not usable for email"),
      401: errorResponse("Authentication required"),
      403: errorResponse("Workspace settings permission required"),
      404: errorResponse("OAuth connection not found"),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/v1/workspaces/{workspaceId}/email-connections/{connectionId}",
    tags: CONNECTION_TAGS,
    summary: "Update or enable/disable a workspace customer email connection",
    operationId: "updateWorkspaceEmailConnection",
    security: sec,
    request: { params: ConnectionParams, body: { required: true, content: json(CustomerEmailConnectionUpdateSchema) } },
    responses: {
      200: { description: "Customer email connection", content: connectionResponse },
      400: errorResponse("Invalid input"),
      401: errorResponse("Authentication required"),
      403: errorResponse("Workspace settings permission required"),
      404: errorResponse("Customer email connection not found"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/email-connections/{connectionId}/health-check",
    tags: CONNECTION_TAGS,
    summary: "Check customer email connection health",
    operationId: "checkWorkspaceEmailConnectionHealth",
    security: sec,
    request: { params: ConnectionParams },
    responses: {
      200: { description: "Customer email connection", content: connectionResponse },
      401: errorResponse("Authentication required"),
      403: errorResponse("Workspace settings permission required"),
      404: errorResponse("Customer email connection not found"),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/workspaces/{workspaceId}/email-connections/{connectionId}",
    tags: CONNECTION_TAGS,
    summary: "Delete a workspace customer email connection",
    operationId: "deleteWorkspaceEmailConnection",
    security: sec,
    request: { params: ConnectionParams },
    responses: {
      204: { description: "Deleted" },
      401: errorResponse("Authentication required"),
      403: errorResponse("Workspace settings permission required"),
      404: errorResponse("Customer email connection not found"),
      409: errorResponse("Customer email connection is still referenced by an email skill"),
    },
  });

  const skillResponse = json(z.object({ skill: EmailSkillDefinitionSummarySchema }));

  registry.registerPath({
    method: "get",
    path: "/api/v1/agents/{agentId}/email-skills",
    tags: SKILL_TAGS,
    summary: "List agent customer email skills",
    operationId: "listAgentEmailSkills",
    security: sec,
    request: { params: AgentParams },
    responses: {
      200: { description: "Email skill definitions", content: json(z.object({ skills: z.array(EmailSkillDefinitionSummarySchema) })) },
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent read permission required"),
      404: errorResponse("Agent not found"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/email-skills",
    tags: SKILL_TAGS,
    summary: "Create an agent customer email skill",
    operationId: "createAgentEmailSkill",
    security: sec,
    request: { params: AgentParams, body: { required: true, content: json(EmailSkillDefinitionCreateSchema) } },
    responses: {
      201: { description: "Email skill definition", content: skillResponse },
      400: errorResponse("Invalid email skill definition"),
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent manage permission required"),
      404: errorResponse("Agent or customer email connection not found"),
      409: errorResponse("Email skill name already exists"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/agents/{agentId}/email-skills/{skillId}",
    tags: SKILL_TAGS,
    summary: "Get an agent customer email skill",
    operationId: "getAgentEmailSkill",
    security: sec,
    request: { params: EmailSkillParams },
    responses: {
      200: { description: "Email skill definition", content: skillResponse },
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent read permission required"),
      404: errorResponse("Agent or email skill not found"),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/v1/agents/{agentId}/email-skills/{skillId}",
    tags: SKILL_TAGS,
    summary: "Update an agent customer email skill",
    operationId: "updateAgentEmailSkill",
    security: sec,
    request: { params: EmailSkillParams, body: { required: true, content: json(EmailSkillDefinitionUpdateSchema) } },
    responses: {
      200: { description: "Email skill definition", content: skillResponse },
      400: errorResponse("Invalid email skill definition"),
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent manage permission required"),
      404: errorResponse("Agent or email skill not found"),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/agents/{agentId}/email-skills/{skillId}",
    tags: SKILL_TAGS,
    summary: "Delete an agent customer email skill",
    operationId: "deleteAgentEmailSkill",
    security: sec,
    request: { params: EmailSkillParams },
    responses: {
      204: { description: "Deleted" },
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent manage permission required"),
      404: errorResponse("Agent or email skill not found"),
    },
  });
};
