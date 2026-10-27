import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

/**
 * A document's chunks: the units retrieval actually scores and cites. Split out of
 * documentsPaths.ts, which is already at its file-size baseline, rather than grown in place.
 */
export const registerDocumentChunksPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "get",
    path: "/api/v1/document/{documentId}/chunks",
    tags: ["Documents"],
    summary: "List a document's chunks",
    operationId: "listDocumentChunks",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.documentParamsSchema,
    },
    responses: {
      200: {
        description: "Chunk summaries returned",
        content: {
          "application/json": {
            schema: schemas.DocumentChunkListResponseSchema,
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
        description: "Document not found",
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
    path: "/api/v1/document/{documentId}/chunks/{chunkId}",
    tags: ["Documents"],
    summary: "Get a single document chunk",
    operationId: "getDocumentChunk",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.chunkParamsSchema,
    },
    responses: {
      200: {
        description: "Chunk returned",
        content: {
          "application/json": {
            schema: schemas.DocumentChunkSchema,
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
        description: "Chunk not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });
};
