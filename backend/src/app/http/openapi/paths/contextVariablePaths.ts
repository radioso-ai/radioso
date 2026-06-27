import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

export const registerContextVariablePaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "post",
    path: "/api/v1/context-variables",
    tags: ["Context Variables"],
    summary: "Create a workspace context variable declaration",
    operationId: "createContextVariable",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: schemas.ContextVariableCreateRequestSchema } },
      },
    },
    responses: {
      201: { description: "Context variable created", content: { "application/json": { schema: schemas.ContextVariableResponseSchema } } },
      400: { description: "Request validation failed", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/context-variables",
    tags: ["Context Variables"],
    summary: "List workspace context variable declarations",
    operationId: "listContextVariables",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    responses: {
      200: { description: "Context variables returned", content: { "application/json": { schema: schemas.ContextVariableListResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/context-variables/{id}",
    tags: ["Context Variables"],
    summary: "Get a workspace context variable declaration",
    operationId: "getContextVariable",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: schemas.ContextVariableParamsSchema },
    responses: {
      200: { description: "Context variable returned", content: { "application/json": { schema: schemas.ContextVariableResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Context variable not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/v1/context-variables/{id}",
    tags: ["Context Variables"],
    summary: "Update a workspace context variable declaration",
    operationId: "updateContextVariable",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.ContextVariableParamsSchema,
      body: {
        required: true,
        content: { "application/json": { schema: schemas.ContextVariableUpdateRequestSchema } },
      },
    },
    responses: {
      200: { description: "Context variable updated", content: { "application/json": { schema: schemas.ContextVariableResponseSchema } } },
      400: { description: "Request validation failed", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Context variable not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/context-variables/{id}",
    tags: ["Context Variables"],
    summary: "Delete a workspace context variable declaration",
    operationId: "deleteContextVariable",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: schemas.ContextVariableParamsSchema },
    responses: {
      204: { description: "Context variable deleted" },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Context variable not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/agents/{agentId}/context-variables",
    tags: ["Context Variables"],
    summary: "List context variable enablements for an agent",
    operationId: "listAgentContextVariables",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: schemas.AgentParamsSchema },
    responses: {
      200: { description: "Context variable enablements returned", content: { "application/json": { schema: schemas.AgentContextVariableEnablementListResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/agents/{agentId}/context-variables/signing-key",
    tags: ["Context Variables"],
    summary: "Reveal the per-agent signed visitor identity key",
    operationId: "getAgentContextVariableSigningKey",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: schemas.AgentParamsSchema },
    responses: {
      200: { description: "Signing key returned", content: { "application/json": { schema: schemas.ContextVariableSigningKeyResponseSchema } } },
      400: { description: "Signing is not configured", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/v1/agents/{agentId}/context-variables/{variableId}",
    tags: ["Context Variables"],
    summary: "Upsert a context variable enablement for an agent",
    operationId: "upsertAgentContextVariable",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.AgentContextVariableParamsSchema,
      body: {
        required: true,
        content: { "application/json": { schema: schemas.AgentContextVariableEnablementRequestSchema } },
      },
    },
    responses: {
      200: { description: "Context variable enablement saved", content: { "application/json": { schema: schemas.AgentContextVariableEnablementResponseSchema } } },
      400: { description: "Request validation failed", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent or context variable not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/agents/{agentId}/context-variables/{variableId}",
    tags: ["Context Variables"],
    summary: "Delete a context variable enablement for an agent",
    operationId: "deleteAgentContextVariable",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: schemas.AgentContextVariableParamsSchema },
    responses: {
      204: { description: "Context variable enablement deleted" },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Agent, context variable, or enablement not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/v1/context-variables/{id}/values",
    tags: ["Context Variables"],
    summary: "Upsert a pushed context variable value",
    operationId: "upsertContextVariableValue",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.ContextVariableParamsSchema,
      body: {
        required: true,
        content: { "application/json": { schema: schemas.ContextVariableValueUpsertRequestSchema } },
      },
    },
    responses: {
      200: { description: "Context variable value saved", content: { "application/json": { schema: schemas.ContextVariableValueResponseSchema } } },
      400: { description: "Request validation failed", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Context variable not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/context-variables/{id}/values",
    tags: ["Context Variables"],
    summary: "Read a pushed context variable value",
    operationId: "getContextVariableValue",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.ContextVariableParamsSchema,
      query: schemas.ContextVariableValueQuerySchema,
    },
    responses: {
      200: { description: "Context variable value returned", content: { "application/json": { schema: schemas.ContextVariableValueResponseSchema } } },
      400: { description: "Request validation failed", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Context variable or value not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/context-variables/{id}/values",
    tags: ["Context Variables"],
    summary: "Delete a pushed context variable value",
    operationId: "deleteContextVariableValue",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.ContextVariableParamsSchema,
      body: {
        required: true,
        content: { "application/json": { schema: schemas.ContextVariableValueDeleteRequestSchema } },
      },
    },
    responses: {
      204: { description: "Context variable value deleted" },
      400: { description: "Request validation failed", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Context variable or value not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });
};
