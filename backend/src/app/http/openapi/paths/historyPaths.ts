import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

export const registerHistoryPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "get",
    path: "/api/v1/history",
    tags: ["History"],
    summary: "List merged chat and document search history",
    operationId: "listHistory",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      query: z.object({
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    },
    responses: {
      200: {
        description: "Merged history items",
        content: {
          "application/json": {
            schema: schemas.HistoryItemsResponseSchema,
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
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/history/chat",
    tags: ["History"],
    summary: "List saved assistant conversations",
    operationId: "listChatHistory",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      query: z.object({
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
        cursor: z.string().min(1).optional(),
      }),
    },
    responses: {
      200: {
        description: "Chat history summaries",
        content: {
          "application/json": {
            schema: schemas.ChatHistoryListResponseSchema,
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
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/history/search",
    tags: ["History"],
    summary: "List document search history for the authenticated workspace",
    operationId: "listHistorySearches",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      query: z.object({
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
        cursor: z.string().min(1).optional(),
      }),
    },
    responses: {
      200: {
        description: "Document search history returned",
        content: {
          "application/json": {
            schema: schemas.DocumentSearchHistoryListResponseSchema,
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
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/history/chat/{conversationId}",
    tags: ["History"],
    summary: "Get a saved assistant conversation and its debug metadata",
    operationId: "getHistoryConversation",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.conversationParamsSchema,
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

  registry.registerPath({
    method: "get",
    path: "/api/v1/history/{conversationId}",
    tags: ["History"],
    summary: "Get a saved assistant conversation and its debug metadata",
    description: "Deprecated compatibility alias. Prefer `/api/v1/history/chat/{conversationId}`.",
    operationId: "getLegacyHistoryConversation",
    deprecated: true,
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.conversationParamsSchema,
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

  registry.registerPath({
    method: "get",
    path: "/api/v1/history/search/{searchId}",
    tags: ["History"],
    summary: "Replay one historical document search",
    operationId: "getHistorySearch",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.documentSearchHistoryParamsSchema,
    },
    responses: {
      200: {
        description: "Document search replay returned",
        content: {
          "application/json": {
            schema: schemas.DocumentSearchResponseSchema,
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
      404: {
        description: "Search history entry not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });
};
