import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

export const registerAgentsPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "get",
    path: "/api/v1/agents",
    tags: ["Agents"],
    summary: "List workspace agents",
    operationId: "listAgents",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    responses: {
      200: {
        description: "Agents returned",
        content: { "application/json": { schema: schemas.AgentListResponseSchema } },
      },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agents",
    tags: ["Agents"],
    summary: "Create a workspace agent",
    operationId: "createAgent",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: schemas.ConversationAgentRequestSchema } },
      },
    },
    responses: {
      201: { description: "Agent created", content: { "application/json": { schema: schemas.ConversationAgentSchema } } },
      400: { description: "Request validation failed", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/agents/{agentId}",
    tags: ["Agents"],
    summary: "Get a workspace agent",
    operationId: "getAgent",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: schemas.AgentParamsSchema },
    responses: {
      200: { description: "Agent returned", content: { "application/json": { schema: schemas.ConversationAgentSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/agents/{agentId}/channels/lifecycle",
    tags: ["Agents"],
    summary: "Get public channel lifecycle for an agent",
    operationId: "getAgentChannelsLifecycle",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: schemas.AgentParamsSchema },
    responses: {
      200: {
        description: "Channel lifecycle returned",
        content: { "application/json": { schema: schemas.AgentChannelsLifecycleResponseSchema } },
      },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/v1/agents/{agentId}",
    tags: ["Agents"],
    summary: "Update a workspace agent",
    operationId: "updateAgent",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.AgentParamsSchema,
      body: {
        required: true,
        content: { "application/json": { schema: schemas.ConversationAgentRequestSchema } },
      },
    },
    responses: {
      200: { description: "Agent updated", content: { "application/json": { schema: schemas.ConversationAgentSchema } } },
      400: { description: "Request validation failed", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/agents/{agentId}/directives",
    tags: ["Agents"],
    summary: "List directives for an agent",
    operationId: "listAgentDirectives",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: schemas.AgentParamsSchema },
    responses: {
      200: { description: "Directives returned", content: { "application/json": { schema: schemas.DirectiveListResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/directives/draft",
    tags: ["Agents"],
    summary: "Draft an authored directive from coaching",
    operationId: "draftAgentDirective",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.AgentParamsSchema,
      body: {
        required: true,
        content: { "application/json": { schema: schemas.DirectiveDraftRequestSchema } },
      },
    },
    responses: {
      200: { description: "Directive draft returned", content: { "application/json": { schema: schemas.DirectiveDraftResponseSchema } } },
      400: { description: "Request validation failed", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      422: { description: "The model did not return a valid draft", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/directives",
    tags: ["Agents"],
    summary: "Create an authored directive for an agent",
    operationId: "createAgentDirective",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.AgentParamsSchema,
      body: {
        required: true,
        content: { "application/json": { schema: schemas.AuthoredDirectiveCreateRequestSchema } },
      },
    },
    responses: {
      201: { description: "Directive created", content: { "application/json": { schema: schemas.AuthoredDirectiveSaveResponseSchema } } },
      400: { description: "Request validation failed", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      409: { description: "Directive name already exists for this agent", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/v1/agents/{agentId}/directives/{directiveId}",
    tags: ["Agents"],
    summary: "Update an authored directive for an agent",
    operationId: "updateAgentDirective",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.AuthoredDirectiveParamsSchema,
      body: {
        required: true,
        content: { "application/json": { schema: schemas.AuthoredDirectiveUpdateRequestSchema } },
      },
    },
    responses: {
      200: { description: "Directive updated", content: { "application/json": { schema: schemas.AuthoredDirectiveSaveResponseSchema } } },
      400: { description: "Request validation failed", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      409: { description: "Directive name already exists for this agent", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent or directive not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/agents/{agentId}/directives/{directiveId}",
    tags: ["Agents"],
    summary: "Delete an authored directive for an agent",
    operationId: "deleteAgentDirective",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: schemas.AuthoredDirectiveParamsSchema },
    responses: {
      204: { description: "Directive deleted" },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent or directive not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/assistant-logo",
    tags: ["Agents"],
    summary: "Upload an assistant logo",
    operationId: "uploadAgentAssistantLogo",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.AgentParamsSchema,
      body: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: schemas.AssistantLogoUploadRequestSchema,
          },
        },
      },
    },
    responses: {
      200: { description: "Agent updated", content: { "application/json": { schema: schemas.ConversationAgentSchema } } },
      400: { description: "Request validation failed", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/agents/{agentId}/assistant-logo",
    tags: ["Agents"],
    summary: "Remove an assistant logo",
    operationId: "deleteAgentAssistantLogo",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: schemas.AgentParamsSchema },
    responses: {
      200: { description: "Agent updated", content: { "application/json": { schema: schemas.ConversationAgentSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/default",
    tags: ["Agents"],
    summary: "Set the default workspace agent",
    operationId: "setDefaultAgent",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: schemas.AgentParamsSchema },
    responses: {
      200: { description: "Default agent updated", content: { "application/json": { schema: schemas.ConversationAgentSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });
};
