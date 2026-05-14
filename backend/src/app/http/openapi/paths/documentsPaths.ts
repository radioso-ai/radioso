import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

export const registerDocumentsPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "post",
    path: "/api/v1/document/search",
    tags: ["Documents"],
    summary: "Search documents for the authenticated workspace",
    operationId: "searchDocuments",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.DocumentSearchRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Search results returned",
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
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/document/search/history",
    tags: ["Documents"],
    summary: "List document search history for the authenticated workspace",
    operationId: "listDocumentSearchHistory",
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
    path: "/api/v1/document/search/history/{searchId}",
    tags: ["Documents"],
    summary: "Replay one historical document search",
    operationId: "getDocumentSearchHistory",
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
      401: {
        description: "Authentication required",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Document search not found",
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
    path: "/api/v1/document/",
    tags: ["Documents"],
    summary: "List documents for the authenticated workspace",
    operationId: "listDocuments",
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
        description: "Documents returned",
        content: {
          "application/json": {
            schema: schemas.DocumentListResponseSchema,
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
    method: "post",
    path: "/api/v1/document/",
    tags: ["Documents"],
    summary: "Queue a document for background processing",
    operationId: "createDocument",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.DocumentCreateRequestSchema,
          },
        },
      },
    },
    responses: {
      202: {
        description: "Document accepted for processing",
        content: {
          "application/json": {
            schema: schemas.DocumentOperationResponseSchema,
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
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/document/import",
    tags: ["Documents"],
    summary: "Import a source file for background processing",
    operationId: "importDocument",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      body: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: schemas.DocumentImportRequestSchema,
          },
        },
      },
    },
    responses: {
      202: {
        description: "Document accepted for processing",
        content: {
          "application/json": {
            schema: schemas.DocumentOperationResponseSchema,
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
      413: {
        description: "Uploaded file exceeds the configured size limit",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      429: {
        description: "Upload rate limit exceeded",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/document/crawl",
    tags: ["Documents"],
    summary: "Crawl a website through a configured crawler provider",
    operationId: "crawlWebsiteDocuments",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.WebsiteCrawlRequestSchema,
          },
        },
      },
    },
    responses: {
      202: {
        description: "Crawl job accepted for asynchronous processing",
        content: {
          "application/json": {
            schema: schemas.WebsiteCrawlJobResponseSchema,
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
      429: {
        description: "Rate limit exceeded",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Website crawler is disabled for this deployment",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      503: {
        description: "Website crawler provider is not configured",
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
    path: "/api/v1/document/crawl/jobs",
    tags: ["Documents"],
    summary: "List recent website crawl jobs for the workspace",
    operationId: "listWebsiteCrawlJobs",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      query: schemas.WebsiteCrawlJobListQuerySchema,
    },
    responses: {
      200: {
        description: "Recent crawl jobs returned",
        content: {
          "application/json": {
            schema: schemas.WebsiteCrawlJobListResponseSchema,
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
        description: "Website crawler is disabled for this deployment",
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
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/document/crawl/jobs/{jobId}",
    tags: ["Documents"],
    summary: "Delete a completed or failed website crawl job",
    operationId: "deleteWebsiteCrawlJob",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: z.object({ jobId: z.string().uuid() }),
    },
    responses: {
      204: {
        description: "Crawl job deleted",
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
        description: "Crawl job not found in this workspace",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      409: {
        description: "Crawl job is still in progress and cannot be deleted",
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
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/document/{documentId}",
    tags: ["Documents"],
    summary: "Get a document",
    operationId: "getDocument",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.documentParamsSchema,
    },
    responses: {
      200: {
        description: "Document returned",
        content: {
          "application/json": {
            schema: schemas.DocumentDetailsSchema,
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
    method: "put",
    path: "/api/v1/document/{documentId}",
    tags: ["Documents"],
    summary: "Update and requeue a document",
    operationId: "updateDocument",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.documentParamsSchema,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.documentSchema,
          },
        },
      },
    },
    responses: {
      202: {
        description: "Document accepted for reprocessing",
        content: {
          "application/json": {
            schema: schemas.DocumentOperationResponseSchema,
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
    method: "post",
    path: "/api/v1/document/{documentId}/reprocess",
    tags: ["Documents"],
    summary: "Requeue an existing document for processing",
    operationId: "reprocessDocument",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.documentParamsSchema,
    },
    responses: {
      202: {
        description: "Document accepted for reprocessing",
        content: {
          "application/json": {
            schema: schemas.DocumentOperationResponseSchema,
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
    method: "delete",
    path: "/api/v1/document/{documentId}",
    tags: ["Documents"],
    summary: "Delete a document",
    operationId: "deleteDocument",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.documentParamsSchema,
    },
    responses: {
      204: {
        description: "Document deleted",
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
};
