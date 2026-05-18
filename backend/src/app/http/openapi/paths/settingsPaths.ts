import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

export const registerSettingsPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "get",
    path: "/api/v1/settings",
    tags: ["Settings"],
    summary: "Get shared workspace platform settings",
    operationId: "getPlatformSettings",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    responses: {
      200: {
        description: "Shared assistant, retrieval, and channel settings returned",
        content: {
          "application/json": {
            schema: schemas.PlatformSettingsResponseSchema,
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
        description: "Workspace not found",
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
    path: "/api/v1/settings",
    tags: ["Settings"],
    summary: "Merge-update shared workspace platform settings",
    operationId: "updatePlatformSettings",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.UpdatePlatformSettingsRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Shared settings updated",
        content: {
          "application/json": {
            schema: schemas.PlatformSettingsResponseSchema,
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
        description: "Workspace not found",
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
    path: "/api/v1/settings/retrieval",
    tags: ["Settings"],
    summary: "Get retrieval settings for the authenticated workspace",
    operationId: "getRetrievalSettings",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    responses: {
      200: {
        description: "Retrieval settings returned",
        content: {
          "application/json": {
            schema: schemas.RetrievalSettingsSchema,
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
    method: "put",
    path: "/api/v1/settings/retrieval",
    tags: ["Settings"],
    summary: "Update retrieval settings for the authenticated workspace",
    operationId: "updateRetrievalSettings",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.UpdateRetrievalSettingsRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Updated retrieval settings",
        content: {
          "application/json": {
            schema: schemas.RetrievalSettingsSchema,
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
    path: "/api/v1/settings/ingestion",
    tags: ["Settings"],
    summary: "Get ingestion settings for the authenticated workspace",
    operationId: "getIngestionSettings",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    responses: {
      200: {
        description: "Ingestion settings returned",
        content: {
          "application/json": {
            schema: schemas.IngestionSettingsSchema,
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
    method: "put",
    path: "/api/v1/settings/ingestion",
    tags: ["Settings"],
    summary: "Update ingestion settings for the authenticated workspace",
    operationId: "updateIngestionSettings",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.UpdateIngestionSettingsRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Updated ingestion settings",
        content: {
          "application/json": {
            schema: schemas.IngestionSettingsSchema,
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
    path: "/api/v1/settings/ingestion/embedding-model/cancel",
    tags: ["Settings"],
    summary: "Cancel a pending workspace embedding model change",
    operationId: "cancelPendingEmbeddingModel",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    responses: {
      200: {
        description: "Pending embedding model change cancelled",
        content: {
          "application/json": {
            schema: schemas.IngestionSettingsSchema,
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
    path: "/api/v1/settings/ingestion/reprocess",
    tags: ["Settings"],
    summary: "Queue eligible workspace documents for reprocessing using current ingestion settings",
    operationId: "reprocessWorkspaceIngestion",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    responses: {
      202: {
        description: "Workspace documents accepted for reprocessing",
        content: {
          "application/json": {
            schema: schemas.WorkspaceIngestionReprocessResponseSchema,
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
    path: "/api/v1/settings/general",
    tags: ["Settings"],
    summary: "Get general workspace settings",
    operationId: "getGeneralSettings",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    responses: {
      200: {
        description: "General settings returned",
        content: {
          "application/json": {
            schema: schemas.GeneralSettingsResponseSchema,
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
        description: "Workspace not found",
        content: {
          "application/json": {
            schema: schemas.FlatErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/v1/settings/general",
    tags: ["Settings"],
    summary: "Update general workspace settings",
    operationId: "updateGeneralSettings",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.UpdateGeneralSettingsRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Updated general settings",
        content: {
          "application/json": {
            schema: schemas.GeneralSettingsResponseSchema,
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
        description: "Workspace not found",
        content: {
          "application/json": {
            schema: schemas.FlatErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/settings/general/anonymous-chat-token/rotate",
    tags: ["Settings"],
    summary: "Reset the anonymous chat public link",
    operationId: "rotateAnonymousChatToken",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    responses: {
      200: {
        description: "Updated general settings",
        content: {
          "application/json": {
            schema: schemas.GeneralSettingsResponseSchema,
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
    path: "/api/v1/settings/general/website-embed-token/rotate",
    tags: ["Settings"],
    summary: "Reset the website embed token",
    operationId: "rotateWebsiteEmbedToken",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    responses: {
      200: {
        description: "Updated general settings",
        content: {
          "application/json": {
            schema: schemas.GeneralSettingsResponseSchema,
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
    path: "/api/v1/settings/general/assistant-logo",
    tags: ["Settings"],
    summary: "Upload the default assistant logo",
    operationId: "uploadAssistantLogo",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
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
      200: {
        description: "Updated general settings",
        content: {
          "application/json": {
            schema: schemas.GeneralSettingsResponseSchema,
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
    method: "delete",
    path: "/api/v1/settings/general/assistant-logo",
    tags: ["Settings"],
    summary: "Remove the default assistant logo",
    operationId: "deleteAssistantLogo",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    responses: {
      200: {
        description: "Updated general settings",
        content: {
          "application/json": {
            schema: schemas.GeneralSettingsResponseSchema,
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
};
