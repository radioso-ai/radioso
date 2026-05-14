import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

export const registerAssistantSessionPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "post",
    path: "/api/v1/public/chat/{token}/sessions",
    tags: ["Assistant"],
    summary: "Create a public chat session from a launch token",
    operationId: "createPublicChatSession",
    request: {
      params: schemas.tokenPathParamsSchema,
      body: {
        content: {
          "application/json": {
            schema: schemas.PublicChatSessionRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Public chat session returned",
        content: {
          "application/json": {
            schema: schemas.PublicChatSessionResponseSchema,
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
      403: {
        description: "Origin not allowed for this public chat channel",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Public chat not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });
};

export const registerAssistantAuthenticatedChatPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "post",
    path: "/api/v1/assistant/chat",
    tags: ["Assistant"],
    summary: "Run human-facing assistant chat",
    operationId: "createAssistantChatResponse",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.AssistantChatRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Chat response returned as JSON or SSE",
        content: {
          "application/json": {
            schema: schemas.AssistantChatResponseSchema,
          },
          "text/event-stream": {
            schema: z.string().openapi("AssistantChatSseStream"),
          },
        },
      },
      204: {
        description: "Bootstrap request completed without creating a greeting",
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
      404: {
        description: "Conversation not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });
};

export const registerAssistantPublicChatPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "post",
    path: "/api/v1/public/chat/{token}",
    tags: ["Assistant"],
    summary: "Send a public chat message",
    operationId: "createPublicChatResponse",
    security: [{ [security.anonymousSessionCookieScheme.name]: [] }],
    request: {
      params: schemas.tokenPathParamsSchema,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.PublicChatRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Public chat response returned as JSON or SSE",
        content: {
          "application/json": {
            schema: schemas.AssistantChatResponseSchema,
          },
          "text/event-stream": {
            schema: z.string().openapi("PublicChatSseStream"),
          },
        },
      },
      204: {
        description: "Bootstrap request completed without creating a greeting",
      },
      400: {
        description: "Request validation failed",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Public chat link not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      429: {
        description: "Rate limit exceeded",
        content: {
          "application/json": {
            schema: schemas.RateLimitExceededSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/public/chat/{token}",
    tags: ["Assistant"],
    summary: "List conversations for the current anonymous session",
    operationId: "listPublicChatHistory",
    security: [{ [security.anonymousSessionCookieScheme.name]: [] }],
    request: {
      params: schemas.tokenPathParamsSchema,
      query: z.object({
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
        cursor: z.string().min(1).optional(),
      }),
    },
    responses: {
      200: {
        description: "Conversation summaries returned",
        content: {
          "application/json": {
            schema: schemas.PublicConversationListResponseSchema,
          },
        },
      },
      404: {
        description: "Public chat link not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/public/chat/{token}/history/{conversationId}",
    tags: ["Assistant"],
    summary: "Get a public conversation for the current anonymous session",
    operationId: "getPublicChatHistoryConversation",
    security: [{ [security.anonymousSessionCookieScheme.name]: [] }],
    request: {
      params: schemas.tokenPathParamsSchema.extend(schemas.publicConversationParamsSchema.shape),
      query: z.object({
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
        cursor: z.string().min(1).optional(),
      }),
    },
    responses: {
      200: {
        description: "Historical conversation detail",
        content: {
          "application/json": {
            schema: schemas.ChatConversationDetailSchema,
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
      404: {
        description: "Conversation not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });
};
