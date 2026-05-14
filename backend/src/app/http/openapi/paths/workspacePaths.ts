import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

export const registerWorkspacePaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "get",
    path: "/api/v1/workspace/mcp/context",
    tags: ["Workspace"],
    summary: "Get workspace MCP context for a bearer-authenticated workspace token",
    operationId: "getWorkspaceMcpContext",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    responses: {
      200: {
        description: "Workspace MCP context returned",
        content: {
          "application/json": {
            schema: schemas.WorkspaceMcpContextResponseSchema,
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
        description: "Workspace token no longer resolves to an active workspace",
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
    path: "/api/v1/workspace",
    tags: ["Workspace"],
    summary: "List workspaces for the authenticated account",
    operationId: "listWorkspaces",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    responses: {
      200: {
        description: "Workspaces returned",
        content: {
          "application/json": {
            schema: schemas.WorkspaceListResponseSchema,
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
    path: "/api/v1/workspace/summary",
    tags: ["Workspace"],
    summary: "Get lightweight workspace dashboard summary",
    operationId: "getWorkspaceSummary",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    responses: {
      200: {
        description: "Workspace summary returned",
        content: {
          "application/json": {
            schema: schemas.WorkspaceSummaryResponseSchema,
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
    path: "/api/v1/workspace/resolve/{workspaceKey}",
    tags: ["Workspace"],
    summary: "Resolve a workspace public route key for the authenticated user",
    operationId: "resolveWorkspaceRouteKey",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    request: {
      params: schemas.workspaceKeyParamsSchema,
    },
    responses: {
      200: {
        description: "Workspace route key resolved",
        content: {
          "application/json": {
            schema: schemas.WorkspaceRouteResolutionResponseSchema,
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
        description: "Workspace not found or inaccessible",
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
    path: "/api/v1/workspace",
    tags: ["Workspace"],
    summary: "Create a workspace",
    operationId: "createWorkspace",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.WorkspaceCreateRequestSchema,
          },
        },
      },
    },
    responses: {
      201: {
        description: "Workspace created",
        content: {
          "application/json": {
            schema: schemas.WorkspaceSchema,
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
    method: "patch",
    path: "/api/v1/workspace/{workspaceId}",
    tags: ["Workspace"],
    summary: "Rename a workspace",
    operationId: "renameWorkspace",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    request: {
      params: schemas.workspaceParamsSchema,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.WorkspaceRenameRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Workspace renamed",
        content: {
          "application/json": {
            schema: schemas.WorkspaceSchema,
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
    method: "delete",
    path: "/api/v1/workspace/{workspaceId}",
    tags: ["Workspace"],
    summary: "Delete a workspace",
    operationId: "deleteWorkspace",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    request: {
      params: schemas.workspaceParamsSchema,
    },
    responses: {
      204: {
        description: "Workspace deleted",
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
};
