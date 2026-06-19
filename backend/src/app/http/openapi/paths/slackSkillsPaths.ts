import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const AgentParams = z.object({ agentId: z.string().uuid() });
const SlackSkillParams = AgentParams.extend({ skillId: z.string().uuid() });
const SlackSkillInputKeySchema = z.enum(["channelId", "text", "threadTs"]);
const SlackSkillBoundInputsSchema = z.record(SlackSkillInputKeySchema, z.unknown());
const SlackSkillExposedInputsSchema = z.record(SlackSkillInputKeySchema, z.object({
  description: z.string().optional(),
  slotBinding: z.string().optional(),
  required: z.boolean().default(true),
}));
const SlackSkillOutcomeSchema = z.enum(["enqueued", "missing_input", "failed"]);

const SlackSkillDefinitionCreateSchema = z.object({
  skillName: z.string(),
  installationId: z.string().uuid(),
  boundInputs: SlackSkillBoundInputsSchema.default({}),
  exposedInputs: SlackSkillExposedInputsSchema.default({}),
  enabled: z.boolean().default(true),
});

const SlackSkillDefinitionUpdateSchema = z.object({
  boundInputs: SlackSkillBoundInputsSchema.optional(),
  exposedInputs: SlackSkillExposedInputsSchema.optional(),
  enabled: z.boolean().optional(),
});

const SlackSkillDefinitionSummarySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid(),
  installationId: z.string().uuid(),
  skillName: z.string(),
  boundInputs: SlackSkillBoundInputsSchema,
  exposedInputs: SlackSkillExposedInputsSchema,
  enabled: z.boolean(),
  outcomes: z.array(SlackSkillOutcomeSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const registerSlackSkillsPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const sec = [{ [security.bearerAuthScheme.name]: [] }];
  const json = <T>(schema: T) => ({ "application/json": { schema } });
  const errorResponse = (description: string) => ({ description, content: json(schemas.ErrorResponseSchema) });
  const skillResponse = json(z.object({ skill: SlackSkillDefinitionSummarySchema }));

  registry.registerPath({
    method: "get",
    path: "/api/v1/agents/{agentId}/slack-skills",
    tags: ["Slack Skills"],
    summary: "List agent Slack skills",
    operationId: "listAgentSlackSkills",
    security: sec,
    request: { params: AgentParams },
    responses: {
      200: { description: "Slack skill definitions", content: json(z.object({ skills: z.array(SlackSkillDefinitionSummarySchema) })) },
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent read permission required"),
      404: errorResponse("Agent not found"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/slack-skills",
    tags: ["Slack Skills"],
    summary: "Create an agent Slack skill",
    operationId: "createAgentSlackSkill",
    security: sec,
    request: { params: AgentParams, body: { required: true, content: json(SlackSkillDefinitionCreateSchema) } },
    responses: {
      201: { description: "Slack skill definition", content: skillResponse },
      400: errorResponse("Invalid Slack skill definition"),
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent manage permission required"),
      404: errorResponse("Agent or Slack installation not found"),
      409: errorResponse("Slack skill name already exists"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/agents/{agentId}/slack-skills/{skillId}",
    tags: ["Slack Skills"],
    summary: "Get an agent Slack skill",
    operationId: "getAgentSlackSkill",
    security: sec,
    request: { params: SlackSkillParams },
    responses: {
      200: { description: "Slack skill definition", content: skillResponse },
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent read permission required"),
      404: errorResponse("Agent or Slack skill not found"),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/v1/agents/{agentId}/slack-skills/{skillId}",
    tags: ["Slack Skills"],
    summary: "Update an agent Slack skill",
    operationId: "updateAgentSlackSkill",
    security: sec,
    request: { params: SlackSkillParams, body: { required: true, content: json(SlackSkillDefinitionUpdateSchema) } },
    responses: {
      200: { description: "Slack skill definition", content: skillResponse },
      400: errorResponse("Invalid Slack skill definition"),
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent manage permission required"),
      404: errorResponse("Agent or Slack skill not found"),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/agents/{agentId}/slack-skills/{skillId}",
    tags: ["Slack Skills"],
    summary: "Delete an agent Slack skill",
    operationId: "deleteAgentSlackSkill",
    security: sec,
    request: { params: SlackSkillParams },
    responses: {
      204: { description: "Deleted" },
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent manage permission required"),
      404: errorResponse("Agent or Slack skill not found"),
    },
  });
};
