import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import { providerNames } from "../../routes/settingsCredentialsRoutes.js";
import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const credentialPathParamsSchema = z.object({
  provider: z.enum(providerNames),
});

export const registerSettingsPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "get",
    path: "/api/v1/settings/webhook-destinations",
    tags: ["Settings"],
    summary: "List workspace webhook destinations",
    operationId: "listWebhookDestinations",
    security: security.workspaceAdminSecurity,
    responses: {
      200: {
        description: "Webhook destinations returned",
        content: { "application/json": { schema: schemas.WebhookDestinationListResponseSchema } },
      },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/settings/webhook-destinations",
    tags: ["Settings"],
    summary: "Create a workspace webhook destination",
    operationId: "createWebhookDestination",
    security: security.workspaceAdminSecurity,
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: schemas.WebhookDestinationRequestSchema } },
      },
    },
    responses: {
      201: {
        description: "Webhook destination created with one-time plaintext secret",
        content: { "application/json": { schema: schemas.WebhookDestinationCreateResponseSchema } },
      },
      400: { description: "Request validation failed", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      409: { description: "Destination name already exists", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/settings/webhook-destinations/{id}",
    tags: ["Settings"],
    summary: "Get a workspace webhook destination",
    operationId: "getWebhookDestination",
    security: security.workspaceAdminSecurity,
    request: { params: schemas.WebhookDestinationParamsSchema },
    responses: {
      200: {
        description: "Webhook destination returned",
        content: { "application/json": { schema: schemas.WebhookDestinationResponseSchema } },
      },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Webhook destination not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/v1/settings/webhook-destinations/{id}",
    tags: ["Settings"],
    summary: "Update a workspace webhook destination",
    operationId: "updateWebhookDestination",
    security: security.workspaceAdminSecurity,
    request: {
      params: schemas.WebhookDestinationParamsSchema,
      body: {
        required: true,
        content: { "application/json": { schema: schemas.WebhookDestinationRequestSchema } },
      },
    },
    responses: {
      200: {
        description: "Webhook destination updated",
        content: { "application/json": { schema: schemas.WebhookDestinationResponseSchema } },
      },
      400: { description: "Request validation failed", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Webhook destination not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      409: { description: "Destination name already exists", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/settings/webhook-destinations/{id}/rotate-secret",
    tags: ["Settings"],
    summary: "Rotate a workspace webhook destination secret",
    operationId: "rotateWebhookDestinationSecret",
    security: security.workspaceAdminSecurity,
    request: { params: schemas.WebhookDestinationParamsSchema },
    responses: {
      200: {
        description: "Webhook destination secret rotated with one-time plaintext secret",
        content: { "application/json": { schema: schemas.WebhookDestinationCreateResponseSchema } },
      },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Webhook destination not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/settings/webhook-destinations/{id}",
    tags: ["Settings"],
    summary: "Delete a workspace webhook destination",
    operationId: "deleteWebhookDestination",
    security: security.workspaceAdminSecurity,
    request: { params: schemas.WebhookDestinationParamsSchema },
    responses: {
      204: { description: "Webhook destination deleted" },
      401: { description: "Authentication required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Webhook destination not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      409: { description: "Destination is referenced by published routines", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/settings",
    tags: ["Settings"],
    summary: "Get shared workspace platform settings",
    operationId: "getPlatformSettings",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    responses: {
      200: {
        description: "Shared assistant and channel settings returned",
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
    path: "/api/v1/settings/retrieval-defaults",
    tags: ["Settings"],
    summary: "Get system retrieval defaults for the authenticated workspace",
    operationId: "getSettingsRetrievalDefaults",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    responses: {
      200: {
        description: "Retrieval defaults returned",
        content: {
          "application/json": {
            schema: schemas.RetrievalDefaultsResponseSchema,
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
    method: "get",
    path: "/api/v1/settings/credentials",
    tags: ["Settings"],
    summary: "List configured workspace provider API keys",
    operationId: "listWorkspaceProviderCredentials",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    responses: {
      200: {
        description: "Configured providers and encryption status",
        content: {
          "application/json": {
            schema: schemas.WorkspaceProviderCredentialsResponseSchema,
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
    path: "/api/v1/settings/credentials/{provider}",
    tags: ["Settings"],
    summary: "Set or replace a workspace provider API key",
    operationId: "setWorkspaceProviderCredential",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: credentialPathParamsSchema,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.SetWorkspaceProviderCredentialRequestSchema,
          },
        },
      },
    },
    responses: {
      204: {
        description: "Credential stored",
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
      503: {
        description: "Server-side secret encryption is not configured",
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
    path: "/api/v1/settings/credentials/{provider}",
    tags: ["Settings"],
    summary: "Remove a stored workspace provider API key",
    operationId: "removeWorkspaceProviderCredential",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: credentialPathParamsSchema,
    },
    responses: {
      204: {
        description: "Credential removed",
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
        description: "No credential found for the requested provider",
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
    path: "/api/v1/settings/llm-models",
    tags: ["Settings"],
    summary: "Get workspace chat/rewrite/rerank model preferences",
    operationId: "getWorkspaceLlmModels",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    responses: {
      200: {
        description: "Workspace LLM model preferences (null = inherit env default)",
        content: {
          "application/json": {
            schema: schemas.WorkspaceLlmModelsResponseSchema,
          },
        },
      },
      401: {
        description: "Authentication required",
        content: { "application/json": { schema: schemas.ErrorResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/v1/settings/llm-models",
    tags: ["Settings"],
    summary: "Update workspace chat/rewrite/rerank model preferences",
    operationId: "updateWorkspaceLlmModels",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.UpdateWorkspaceLlmModelsRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Updated workspace LLM model preferences",
        content: {
          "application/json": {
            schema: schemas.WorkspaceLlmModelsResponseSchema,
          },
        },
      },
      400: {
        description: "Request validation failed",
        content: { "application/json": { schema: schemas.ErrorResponseSchema } },
      },
      401: {
        description: "Authentication required",
        content: { "application/json": { schema: schemas.ErrorResponseSchema } },
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
