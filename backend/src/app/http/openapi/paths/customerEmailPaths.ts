import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const WorkspaceParams = z.object({ workspaceId: z.string().uuid() });
const ConnectionParams = WorkspaceParams.extend({ connectionId: z.string().uuid() });

const CustomerEmailConnectionCreateSchema = z.object({
  oauthConnectionId: z.string().uuid(),
  displayName: z.string(),
  senderEmail: z.string().email(),
  senderName: z.string().nullable().optional(),
  replyToEmail: z.string().email().nullable().optional(),
});

const CustomerEmailConnectionUpdateSchema = z.object({
  displayName: z.string().optional(),
  senderEmail: z.string().email().optional(),
  senderName: z.string().nullable().optional(),
  replyToEmail: z.string().email().nullable().optional(),
  disabled: z.boolean().optional(),
});

const CustomerEmailConnectionSummarySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string(),
  oauthConnectionId: z.string().uuid(),
  provider: z.string(),
  displayName: z.string(),
  senderEmail: z.string(),
  senderName: z.string().nullable(),
  replyToEmail: z.string().nullable(),
  status: z.enum(["authorized", "disabled", "needs_reauth", "error"]),
  lastHealthStatus: z.enum(["ok", "failed", "unknown"]).nullable(),
  lastHealthCheckedAt: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  updatedAt: z.string(),
});

const TAGS = ["Customer Email Connections"];

export const registerCustomerEmailPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const sec = [{ [security.bearerAuthScheme.name]: [] }];
  const json = <T>(schema: T) => ({ "application/json": { schema } });
  const errorResponse = (description: string) => ({ description, content: json(schemas.ErrorResponseSchema) });
  const connectionResponse = json(z.object({ connection: CustomerEmailConnectionSummarySchema }));

  registry.registerPath({
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/email-connections",
    tags: TAGS,
    summary: "List workspace customer email connections",
    operationId: "listWorkspaceEmailConnections",
    security: sec,
    request: { params: WorkspaceParams },
    responses: {
      200: { description: "Customer email connections", content: json(z.object({ connections: z.array(CustomerEmailConnectionSummarySchema) })) },
      401: errorResponse("Authentication required"),
      403: errorResponse("Workspace settings permission required"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/email-connections",
    tags: TAGS,
    summary: "Create a workspace customer email connection",
    operationId: "createWorkspaceEmailConnection",
    security: sec,
    request: { params: WorkspaceParams, body: { required: true, content: json(CustomerEmailConnectionCreateSchema) } },
    responses: {
      201: { description: "Customer email connection", content: connectionResponse },
      400: errorResponse("Invalid input or OAuth connection is not usable for email"),
      401: errorResponse("Authentication required"),
      403: errorResponse("Workspace settings permission required"),
      404: errorResponse("OAuth connection not found"),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/v1/workspaces/{workspaceId}/email-connections/{connectionId}",
    tags: TAGS,
    summary: "Update or enable/disable a workspace customer email connection",
    operationId: "updateWorkspaceEmailConnection",
    security: sec,
    request: { params: ConnectionParams, body: { required: true, content: json(CustomerEmailConnectionUpdateSchema) } },
    responses: {
      200: { description: "Customer email connection", content: connectionResponse },
      400: errorResponse("Invalid input"),
      401: errorResponse("Authentication required"),
      403: errorResponse("Workspace settings permission required"),
      404: errorResponse("Customer email connection not found"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/email-connections/{connectionId}/health-check",
    tags: TAGS,
    summary: "Check customer email connection health",
    operationId: "checkWorkspaceEmailConnectionHealth",
    security: sec,
    request: { params: ConnectionParams },
    responses: {
      200: { description: "Customer email connection", content: connectionResponse },
      401: errorResponse("Authentication required"),
      403: errorResponse("Workspace settings permission required"),
      404: errorResponse("Customer email connection not found"),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/workspaces/{workspaceId}/email-connections/{connectionId}",
    tags: TAGS,
    summary: "Delete a workspace customer email connection",
    operationId: "deleteWorkspaceEmailConnection",
    security: sec,
    request: { params: ConnectionParams },
    responses: {
      204: { description: "Deleted" },
      401: errorResponse("Authentication required"),
      403: errorResponse("Workspace settings permission required"),
      404: errorResponse("Customer email connection not found"),
      409: errorResponse("Customer email connection is still referenced by an email skill"),
    },
  });
};
