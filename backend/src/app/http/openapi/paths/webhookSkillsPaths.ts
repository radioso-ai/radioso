import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const AgentParams = z.object({ agentId: z.string().uuid() });
const WebhookSkillParams = AgentParams.extend({ skillId: z.string().uuid() });
const WebhookSkillExposedPayloadSchema = z.record(z.object({
  description: z.string().optional(),
  slotBinding: z.string().optional(),
  required: z.boolean().default(true),
}));
const WebhookSkillBoundPayloadSchema = z.record(z.unknown());
const WebhookSkillOutcomeSchema = z.enum(["delivered", "missing_input", "destination_not_found", "failed"]);

const WebhookSkillDefinitionCreateSchema = z.object({
  skillName: z.string(),
  destinationId: z.string().uuid(),
  boundPayload: WebhookSkillBoundPayloadSchema.default({}),
  exposedPayload: WebhookSkillExposedPayloadSchema.default({}),
  enabled: z.boolean().default(true),
});

const WebhookSkillDefinitionUpdateSchema = z.object({
  boundPayload: WebhookSkillBoundPayloadSchema.optional(),
  exposedPayload: WebhookSkillExposedPayloadSchema.optional(),
  enabled: z.boolean().optional(),
});

const WebhookSkillDefinitionSummarySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid(),
  destinationId: z.string().uuid(),
  skillName: z.string(),
  boundPayload: WebhookSkillBoundPayloadSchema,
  exposedPayload: WebhookSkillExposedPayloadSchema,
  enabled: z.boolean(),
  outcomes: z.array(WebhookSkillOutcomeSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const registerWebhookSkillsPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const sec = [{ [security.bearerAuthScheme.name]: [] }];
  const json = <T>(schema: T) => ({ "application/json": { schema } });
  const errorResponse = (description: string) => ({ description, content: json(schemas.ErrorResponseSchema) });
  const skillResponse = json(z.object({ skill: WebhookSkillDefinitionSummarySchema }));

  registry.registerPath({
    method: "get",
    path: "/api/v1/agents/{agentId}/webhook-skills",
    tags: ["Webhook Skills"],
    summary: "List agent webhook skills",
    operationId: "listAgentWebhookSkills",
    security: sec,
    request: { params: AgentParams },
    responses: {
      200: { description: "Webhook skill definitions", content: json(z.object({ skills: z.array(WebhookSkillDefinitionSummarySchema) })) },
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent read permission required"),
      404: errorResponse("Agent not found"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/webhook-skills",
    tags: ["Webhook Skills"],
    summary: "Create an agent webhook skill",
    operationId: "createAgentWebhookSkill",
    security: sec,
    request: { params: AgentParams, body: { required: true, content: json(WebhookSkillDefinitionCreateSchema) } },
    responses: {
      201: { description: "Webhook skill definition", content: skillResponse },
      400: errorResponse("Invalid webhook skill definition"),
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent manage permission required"),
      404: errorResponse("Agent or webhook destination not found"),
      409: errorResponse("Webhook skill name already exists"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/agents/{agentId}/webhook-skills/{skillId}",
    tags: ["Webhook Skills"],
    summary: "Get an agent webhook skill",
    operationId: "getAgentWebhookSkill",
    security: sec,
    request: { params: WebhookSkillParams },
    responses: {
      200: { description: "Webhook skill definition", content: skillResponse },
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent read permission required"),
      404: errorResponse("Agent or webhook skill not found"),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/v1/agents/{agentId}/webhook-skills/{skillId}",
    tags: ["Webhook Skills"],
    summary: "Update an agent webhook skill",
    operationId: "updateAgentWebhookSkill",
    security: sec,
    request: { params: WebhookSkillParams, body: { required: true, content: json(WebhookSkillDefinitionUpdateSchema) } },
    responses: {
      200: { description: "Webhook skill definition", content: skillResponse },
      400: errorResponse("Invalid webhook skill definition"),
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent manage permission required"),
      404: errorResponse("Agent or webhook skill not found"),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/agents/{agentId}/webhook-skills/{skillId}",
    tags: ["Webhook Skills"],
    summary: "Delete an agent webhook skill",
    operationId: "deleteAgentWebhookSkill",
    security: sec,
    request: { params: WebhookSkillParams },
    responses: {
      204: { description: "Deleted" },
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent manage permission required"),
      404: errorResponse("Agent or webhook skill not found"),
    },
  });
};
