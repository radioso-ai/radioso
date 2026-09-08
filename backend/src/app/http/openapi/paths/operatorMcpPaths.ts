import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { OPERATOR_MCP_SCOPES } from "@radioso/operator-mcp-contract";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const workspaceParams = z.object({ workspaceId: z.string().uuid() });
const grantParams = workspaceParams.extend({ grantId: z.string().uuid() });
const transactionParams = z.object({ transactionId: z.string().uuid() });
const toolScope = z.enum(OPERATOR_MCP_SCOPES);
const grantStatus = z.enum(["active", "revoked", "superseded", "expired"]);

const setupArtifact = z.object({
  id: z.string(),
  displayName: z.string(),
  clientVersion: z.string().nullable(),
  status: z.enum(["verified", "unavailable", "unverified"]),
  description: z.string(),
  setupInstructions: z.array(z.string()),
  command: z.string().nullable(),
  configuration: z.string().nullable(),
  handoffUrl: z.string().url().nullable(),
  permittedLaunchTarget: z.string(),
  expectedClientId: z.string().nullable(),
  redirectMechanism: z.string(),
  failureRecovery: z.string(),
});

const setupResponse = z.object({
  availability: z.enum(["available", "disabled", "misconfigured", "unavailable"]),
  resource: z.string().url().nullable(),
  artifacts: z.array(setupArtifact),
  checkedAt: z.string().datetime(),
  message: z.string().nullable(),
});

const grantSummary = z.object({
  id: z.string().uuid(),
  clientId: z.string(),
  clientName: z.string(),
  clientVersion: z.string().nullable(),
  clientMetadataDigest: z.string(),
  workspaceId: z.string().uuid(),
  workspaceName: z.string(),
  userId: z.string().uuid(),
  userName: z.string().nullable(),
  scopes: z.array(toolScope),
  offlineAccess: z.boolean(),
  status: grantStatus,
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  revokedReason: z.string().nullable(),
  canRevoke: z.boolean(),
  isOwner: z.boolean(),
});

const grantDetail = grantSummary.extend({
  redirectHost: z.string(),
  resource: z.string().url(),
  credentialCount: z.number().int().nonnegative(),
  recentInvocationCount: z.number().int().nonnegative(),
});

const transactionResponse = z.object({
  transactionId: z.string().uuid(),
  client: z.object({
    clientId: z.string(),
    displayName: z.string(),
    clientUri: z.string().url().nullable(),
    clientVersion: z.string().nullable(),
    metadataDigest: z.string(),
    applicationType: z.enum(["web", "native"]),
  }),
  requestedScopes: z.array(toolScope),
  requestedOfflineAccess: z.boolean(),
  redirectHost: z.string(),
  redirectUri: z.string().url(),
  resource: z.string().url(),
  currentUser: z.object({ id: z.string().uuid(), displayName: z.string(), email: z.string().email().nullable() }),
  workspaces: z.array(z.object({ id: z.string().uuid(), name: z.string(), role: z.enum(["member", "admin", "owner"]) })),
  status: z.enum(["pending", "approved", "denied", "consumed", "expired"]),
  expiresAt: z.string().datetime(),
});

export const registerOperatorMcpPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
): void => {
  const session = [{ [security.sessionCookieScheme.name]: [] }];
  const csrfHeaders = z.object({
    "X-Radioso-CSRF": z.literal("1").openapi({
      description: "Required non-simple header for cookie-authenticated Operator MCP mutations.",
      param: { in: "header", name: "X-Radioso-CSRF" },
    }),
  });
  const errors = {
    400: { description: "Invalid Operator MCP request", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    401: { description: "Interactive session required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    403: { description: "Workspace access required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    404: { description: "Operator MCP resource not found", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
  };

  registry.registerPath({
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/operator-mcp/setup",
    tags: ["Operator MCP"],
    summary: "Read Operator MCP setup options",
    operationId: "getOperatorMcpSetup",
    security: session,
    request: { params: workspaceParams },
    responses: { 200: { description: "Current setup availability and client artifacts", content: { "application/json": { schema: setupResponse } } }, ...errors },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/operator-mcp/grants",
    tags: ["Operator MCP"],
    summary: "List visible Operator MCP grants",
    operationId: "listOperatorMcpGrants",
    security: session,
    request: { params: workspaceParams },
    responses: { 200: { description: "User or workspace grant inventory", content: { "application/json": { schema: z.object({ grants: z.array(grantSummary), canViewWorkspace: z.boolean() }) } } }, ...errors },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/operator-mcp/grants/{grantId}",
    tags: ["Operator MCP"],
    summary: "Read an Operator MCP grant",
    operationId: "getOperatorMcpGrant",
    security: session,
    request: { params: grantParams },
    responses: { 200: { description: "Grant detail", content: { "application/json": { schema: grantDetail } } }, ...errors },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/operator-mcp/grants/{grantId}/revoke",
    tags: ["Operator MCP"],
    summary: "Revoke an Operator MCP grant",
    operationId: "revokeOperatorMcpGrant",
    security: session,
    request: { params: grantParams, headers: csrfHeaders },
    responses: { 200: { description: "Revoked grant", content: { "application/json": { schema: grantSummary } } }, ...errors },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/operator-mcp/oauth/transactions/{transactionId}",
    tags: ["Operator MCP"],
    summary: "Read a pending Operator MCP consent transaction",
    operationId: "getOperatorMcpConsentTransaction",
    security: session,
    request: { params: transactionParams },
    responses: { 200: { description: "Consent transaction bound to the current session", content: { "application/json": { schema: transactionResponse } } }, ...errors },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/operator-mcp/oauth/transactions/{transactionId}/decision",
    tags: ["Operator MCP"],
    summary: "Approve or deny an Operator MCP consent transaction",
    operationId: "decideOperatorMcpConsentTransaction",
    security: session,
    request: {
      params: transactionParams,
      headers: csrfHeaders,
      body: { required: true, content: { "application/json": { schema: z.object({
        decision: z.enum(["approve", "deny"]),
        workspaceId: z.string().uuid().optional(),
        approvedToolScopes: z.array(toolScope).min(1).max(4).optional(),
        offlineAccess: z.boolean(),
      }) } } },
    },
    responses: { 200: { description: "OAuth redirect for the client", content: { "application/json": { schema: z.object({ redirectUrl: z.string().url() }) } } }, ...errors },
  });
};
