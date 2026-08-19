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
    method: "post",
    path: "/api/v1/agents/{agentId}/mcp-converse-grants",
    tags: ["Agents"],
    summary: "Issue an MCP converse grant for an agent",
    operationId: "issueAgentMcpConverseGrant",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.AgentParamsSchema,
      body: {
        required: true,
        content: { "application/json": { schema: schemas.AgentMcpConverseGrantIssueRequestSchema } },
      },
    },
    responses: {
      201: {
        description: "MCP converse grant issued. The token is returned only in this response.",
        content: { "application/json": { schema: schemas.AgentMcpConverseGrantIssueResponseSchema } },
      },
      400: { description: "Request validation failed", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      403: { description: "Agent manage permission required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/agents/{agentId}/mcp-converse-grants",
    tags: ["Agents"],
    summary: "List MCP converse grants for an agent",
    operationId: "listAgentMcpConverseGrants",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: schemas.AgentParamsSchema },
    responses: {
      200: {
        description: "MCP converse grant metadata returned without token material",
        content: { "application/json": { schema: schemas.AgentMcpConverseGrantListResponseSchema } },
      },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      403: { description: "Agent manage permission required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/mcp-converse-grants/{grantId}/rotate",
    tags: ["Agents"],
    summary: "Rotate an MCP converse grant for an agent",
    operationId: "rotateAgentMcpConverseGrant",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: schemas.AgentMcpConverseGrantParamsSchema },
    responses: {
      200: {
        description: "MCP converse grant rotated. The new token is returned only in this response.",
        content: { "application/json": { schema: schemas.AgentMcpConverseGrantSecretResponseSchema } },
      },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      403: { description: "Agent manage permission required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent or MCP converse grant not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/agents/{agentId}/mcp-converse-grants/{grantId}",
    tags: ["Agents"],
    summary: "Revoke an MCP converse grant for an agent",
    operationId: "revokeAgentMcpConverseGrant",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: schemas.AgentMcpConverseGrantParamsSchema },
    responses: {
      204: { description: "MCP converse grant revoked" },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      403: { description: "Agent manage permission required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent or MCP converse grant not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
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
    method: "get",
    path: "/api/v1/agents/{agentId}/routine-skill-catalog",
    tags: ["Agents"],
    summary: "List routine-authoring skills for an agent",
    operationId: "listAgentRoutineSkillCatalog",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: schemas.AgentParamsSchema },
    responses: {
      200: { description: "Routine skill catalog returned", content: { "application/json": { schema: schemas.RoutineSkillCatalogResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/agents/{agentId}/routines",
    tags: ["Agents"],
    summary: "List routine definitions for an agent",
    operationId: "listAgentRoutines",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: schemas.AgentParamsSchema },
    responses: {
      200: { description: "Routine definitions returned", content: { "application/json": { schema: schemas.RoutineDefinitionListResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/agents/{agentId}/routines/{routineId}",
    tags: ["Agents"],
    summary: "Get a routine definition for an agent",
    operationId: "getAgentRoutine",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: schemas.RoutineDefinitionParamsSchema },
    responses: {
      200: { description: "Routine definition returned", content: { "application/json": { schema: schemas.RoutineDefinitionGetResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent or routine definition not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });


  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/routines/draft-assist",
    tags: ["Agents"],
    summary: "Draft a routine definition from operator procedure prose",
    operationId: "draftAgentRoutineFromProcedure",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.AgentParamsSchema,
      body: {
        required: true,
        content: { "application/json": { schema: schemas.RoutineDraftAssistRequestSchema } },
      },
    },
    responses: {
      200: { description: "Routine draft proposal returned", content: { "application/json": { schema: schemas.RoutineDraftAssistResponseSchema } } },
      400: { description: "Request validation failed", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      422: { description: "Routine draft could not be generated", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/routines",
    tags: ["Agents"],
    summary: "Create a draft routine definition for an agent",
    operationId: "createAgentRoutine",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.AgentParamsSchema,
      body: {
        required: true,
        content: { "application/json": { schema: schemas.RoutineDefinitionCreateRequestSchema } },
      },
    },
    responses: {
      201: { description: "Draft routine definition created", content: { "application/json": { schema: schemas.RoutineDefinitionSaveResponseSchema } } },
      400: { description: "Request validation failed", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      409: { description: "Routine name and version already exist for this agent", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/v1/agents/{agentId}/routines/{routineId}",
    tags: ["Agents"],
    summary: "Update a draft routine definition for an agent",
    operationId: "updateAgentRoutine",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.RoutineDefinitionParamsSchema,
      body: {
        required: true,
        content: { "application/json": { schema: schemas.RoutineDefinitionUpdateRequestSchema } },
      },
    },
    responses: {
      200: { description: "Draft routine definition updated", content: { "application/json": { schema: schemas.RoutineDefinitionSaveResponseSchema } } },
      400: { description: "Request validation failed", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent or routine definition not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/routines/{routineId}/validate",
    tags: ["Agents"],
    summary: "Validate a routine definition for an agent",
    operationId: "validateAgentRoutine",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: schemas.RoutineDefinitionParamsSchema },
    responses: {
      200: { description: "Routine validation returned", content: { "application/json": { schema: schemas.RoutineDefinitionValidateResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent or routine definition not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/routines/{routineId}/publish",
    tags: ["Agents"],
    summary: "Publish a draft routine definition for an agent",
    operationId: "publishAgentRoutine",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: schemas.RoutineDefinitionParamsSchema },
    responses: {
      200: { description: "Routine definition published", content: { "application/json": { schema: schemas.RoutineDefinitionPublishResponseSchema } } },
      400: { description: "Routine definition cannot be published", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent or routine definition not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      422: { description: "Routine definition is invalid", content: { "application/json": { schema: schemas.RoutineDefinitionPublishRejectedResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/routines/{routineId}/revise",
    tags: ["Agents"],
    summary: "Create or return a draft revision for a published routine definition",
    operationId: "reviseAgentRoutine",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: schemas.RoutineDefinitionParamsSchema },
    responses: {
      200: { description: "Routine revision draft returned", content: { "application/json": { schema: schemas.RoutineDefinitionLifecycleResponseSchema } } },
      400: { description: "Routine definition cannot be revised", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent or routine definition not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/routines/{routineId}/archive",
    tags: ["Agents"],
    summary: "Archive a published routine definition",
    operationId: "archiveAgentRoutine",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: schemas.RoutineDefinitionParamsSchema },
    responses: {
      200: { description: "Routine definition archived", content: { "application/json": { schema: schemas.RoutineDefinitionLifecycleResponseSchema } } },
      400: { description: "Routine definition cannot be archived", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent or routine definition not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/routines/{routineId}/restore",
    tags: ["Agents"],
    summary: "Restore an archived routine definition",
    operationId: "restoreAgentRoutine",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: schemas.RoutineDefinitionParamsSchema },
    responses: {
      200: { description: "Routine definition restored", content: { "application/json": { schema: schemas.RoutineDefinitionLifecycleResponseSchema } } },
      400: { description: "Routine definition cannot be restored", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent or routine definition not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/agents/{agentId}/routines/{routineId}",
    tags: ["Agents"],
    summary: "Delete a draft routine definition for an agent",
    operationId: "deleteAgentRoutine",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: schemas.RoutineDefinitionParamsSchema },
    responses: {
      204: { description: "Draft routine definition deleted" },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent or draft routine definition not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
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
