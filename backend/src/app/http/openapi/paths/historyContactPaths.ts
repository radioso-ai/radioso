import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

/**
 * Contact requests ("someone asked to be contacted") as the dashboard history view lists and
 * drills into them. Split out of historyPaths.ts to keep schema/path concerns for this one
 * resource together without growing an already-large sibling file.
 */
export const registerHistoryContactPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "get",
    path: "/api/v1/history/contact",
    tags: ["History"],
    summary: "List contact requests",
    operationId: "listContactRequests",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      query: schemas.historyItemsPageQuerySchema,
    },
    responses: {
      200: {
        description: "Contact requests returned",
        content: {
          "application/json": {
            schema: schemas.ContactHistoryListResponseSchema,
          },
        },
      },
      400: {
        description: "Invalid query",
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
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/history/contact/{requestId}",
    tags: ["History"],
    summary: "Get a contact request and its conversation",
    operationId: "getContactRequest",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.historyContactParamsSchema,
      query: schemas.conversationWindowQuerySchema,
    },
    responses: {
      200: {
        description: "Contact request and conversation detail returned",
        content: {
          "application/json": {
            schema: schemas.ContactHistoryDetailResponseSchema,
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
        description: "Contact request not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });
};
