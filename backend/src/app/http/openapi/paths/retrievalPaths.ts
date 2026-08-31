import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

export const registerRetrievalSearchPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "post",
    path: "/api/v1/retrieval/search",
    tags: ["Retrieval"],
    summary: "Search workspace evidence without assistant behavior",
    operationId: "searchRetrievalEvidence",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.RetrievalSearchRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Retrieval evidence returned",
        content: {
          "application/json": {
            schema: schemas.RetrievalSearchResponseSchema,
          },
        },
      },
      400: {
        description: "Request validation failed",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      401: {
        description: "Authentication required",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      403: {
        description: "Caller lacks the workspace.retrieval.query permission, or supplied agentId without workspace.agents.read",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "The agentId supplied does not resolve to an agent in this workspace",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      429: {
        description: "Expensive authenticated request rate limit exceeded",
        content: {
          "application/json": {
            schema: schemas.RateLimitExceededSchema,
          },
        },
      },
    },
  });
};

export const registerRetrievalAnswerPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "post",
    path: "/api/v1/retrieval/answer",
    tags: ["Retrieval"],
    summary: "Generate a retrieval-only grounded answer",
    operationId: "createRetrievalAnswer",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.RetrievalAnswerRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Retrieval answer or unsupported retrieval-scoped result returned",
        content: {
          "application/json": {
            schema: schemas.RetrievalAnswerResponseSchema,
          },
        },
      },
      400: {
        description: "Request validation failed",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      401: {
        description: "Authentication required",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      403: {
        description: "Caller lacks the workspace.retrieval.query permission, or supplied agentId without workspace.agents.read",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "The agentId supplied does not resolve to an agent in this workspace",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      429: {
        description: "Expensive authenticated request rate limit exceeded",
        content: {
          "application/json": {
            schema: schemas.RateLimitExceededSchema,
          },
        },
      },
    },
  });
};
