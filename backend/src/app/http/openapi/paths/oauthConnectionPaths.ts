import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const WorkspaceParams = z.object({ workspaceId: z.string().uuid() });
const ConnectionParams = WorkspaceParams.extend({ connectionId: z.string().uuid() });
const CallbackParams = z.object({ provider: z.string() });
const CallbackQuery = z.object({ code: z.string(), state: z.string() });

const OAuthConnectionCreateSchema = z.object({
  provider: z.string(),
  displayName: z.string(),
  requestedScopes: z.array(z.string()).optional(),
});

const OAuthAuthorizationResponseSchema = z.object({
  connectionId: z.string().uuid(),
  authorizationUrl: z.string(),
  status: z.literal("pending"),
});

const OAuthConnectionSummarySchema = z.object({
  id: z.string().uuid(),
  provider: z.string(),
  displayName: z.string(),
  status: z.enum(["pending", "authorized", "needs_reauth", "disabled", "error"]),
  grantedScopes: z.array(z.string()),
  providerAccountId: z.string().nullable(),
  updatedAt: z.string(),
});

const TAGS = ["OAuth Connections"];

export const registerOauthConnectionPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const sec = [{ [security.bearerAuthScheme.name]: [] }];
  const json = <T>(schema: T) => ({ "application/json": { schema } });
  const errorResponse = (description: string) => ({ description, content: json(schemas.ErrorResponseSchema) });

  registry.registerPath({
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/oauth-connections",
    tags: TAGS,
    summary: "Create and start a workspace OAuth connection",
    operationId: "createWorkspaceOauthConnection",
    security: sec,
    request: { params: WorkspaceParams, body: { required: true, content: json(OAuthConnectionCreateSchema) } },
    responses: {
      201: { description: "Authorization started", content: json(OAuthAuthorizationResponseSchema) },
      400: errorResponse("Unsupported provider, scopes, or request validation failed"),
      401: errorResponse("Authentication required"),
      403: errorResponse("Workspace settings permission required"),
      503: errorResponse("OAuth encryption or redirect URI is not configured"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/oauth-connections",
    tags: TAGS,
    summary: "List non-secret workspace OAuth connection statuses",
    operationId: "listWorkspaceOauthConnections",
    security: sec,
    request: { params: WorkspaceParams },
    responses: {
      200: { description: "OAuth connections", content: json(z.object({ connections: z.array(OAuthConnectionSummarySchema) })) },
      401: errorResponse("Authentication required"),
      403: errorResponse("Workspace settings permission required"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/oauth-connections/{connectionId}",
    tags: TAGS,
    summary: "Get a non-secret workspace OAuth connection status",
    operationId: "getWorkspaceOauthConnection",
    security: sec,
    request: { params: ConnectionParams },
    responses: {
      200: { description: "OAuth connection", content: json(z.object({ connection: OAuthConnectionSummarySchema })) },
      401: errorResponse("Authentication required"),
      403: errorResponse("Workspace settings permission required"),
      404: errorResponse("OAuth connection not found"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/oauth-connections/{connectionId}/reauthorize",
    tags: TAGS,
    summary: "Restart authorization for a workspace OAuth connection",
    operationId: "reauthorizeWorkspaceOauthConnection",
    security: sec,
    request: { params: ConnectionParams },
    responses: {
      200: { description: "Authorization restarted", content: json(OAuthAuthorizationResponseSchema) },
      400: errorResponse("Connection is not ready for OAuth authorization"),
      401: errorResponse("Authentication required"),
      403: errorResponse("Workspace settings permission required"),
      404: errorResponse("OAuth connection not found"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/oauth/callback/{provider}",
    tags: TAGS,
    summary: "Complete a provider OAuth callback",
    operationId: "completeWorkspaceOauthCallback",
    request: { params: CallbackParams, query: CallbackQuery },
    responses: {
      302: { description: "Redirects to the frontend OAuth status page" },
      400: errorResponse("State mismatch or authorization could not be completed"),
      404: errorResponse("OAuth connection not found"),
      503: errorResponse("OAuth encryption is not configured"),
    },
  });
};
