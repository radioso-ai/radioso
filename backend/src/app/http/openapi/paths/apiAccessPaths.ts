import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const role = z.enum(["member", "admin"]);
const status = z.enum(["enabled", "disabled", "archived"]);
const label = z.string().min(1).max(80);
const revision = z.number().int().positive();
const workspaceParams = z.object({ workspaceId: z.string().uuid() });
const serviceAccountParams = workspaceParams.extend({ serviceAccountId: z.string().uuid() });
const credentialParams = workspaceParams.extend({ credentialId: z.string().uuid() });
const serviceCredentialParams = serviceAccountParams.extend({ credentialId: z.string().uuid() });
const pageQuery = z.object({ page: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(100).optional() });
const optionalExpiry = z.string().datetime().nullable().optional();

const credential = z.object({
  id: z.string().uuid(),
  kind: z.enum(["personal", "service"]),
  label,
  prefix: z.string(),
  roleCeiling: role.nullable(),
  ownerUserId: z.string().uuid().nullable(),
  serviceAccountId: z.string().uuid().nullable(),
  createdByUserId: z.string().uuid(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
  status: z.enum(["active", "expired", "revoked", "suspended", "invalid"]),
  expiryWarningDays: z.union([z.literal(30), z.literal(7), z.literal(1)]).nullable(),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  revokedByUserId: z.string().uuid().nullable(),
  revocationReason: z.string().nullable(),
  rotatedFromCredentialId: z.string().uuid().nullable(),
  revision,
});

const serviceAccount = z.object({
  id: z.string().uuid(),
  displayName: label,
  role,
  status,
  createdByUserId: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  disabledAt: z.string().datetime().nullable(),
  archivedAt: z.string().datetime().nullable(),
  lastUsedAt: z.string().datetime().nullable(),
  activeCredentialCount: z.number().int().min(0),
  revision,
});

const paged = <T extends z.ZodTypeAny>(item: T) => z.object({
  items: z.array(item),
  page: z.number().int().min(1),
  limit: z.number().int().min(1).max(100),
  total: z.number().int().min(0),
});
const oneTimeCredential = z.object({ credential, secret: z.string() });

export const registerApiAccessPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
): void => {
  const session = [{ [security.sessionCookieScheme.name]: [] }];
  const csrfHeaders = z.object({
    "X-Radioso-CSRF": z.literal("1").openapi({
      description: "Required non-simple header for cookie-authenticated API-access mutations.",
      param: { in: "header", name: "X-Radioso-CSRF" },
    }),
  });
  const errors = {
    400: { description: "Invalid lifecycle request", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    401: { description: "Interactive session required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    403: { description: "Workspace capability required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    404: { description: "Resource not available in this workspace or ownership boundary", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    409: { description: "Stale revision, quota, or invalid lifecycle transition", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
  };

  registry.registerPath({
    method: "get",
    path: "/api/v1/account/workspaces/{workspaceId}/api-access",
    tags: ["API Access"],
    summary: "Read API-access capabilities and limits",
    operationId: "getApiAccessSummary",
    security: session,
    request: { params: workspaceParams },
    responses: {
      200: { description: "API-access capabilities", content: { "application/json": { schema: z.object({
        effectiveRole: z.enum(["member", "admin", "owner"]),
        capabilities: z.object({ manageOwnPersonalTokens: z.boolean(), auditWorkspacePersonalTokens: z.boolean(), manageServiceAccounts: z.boolean() }),
        defaults: z.object({ personalTokenLifetimeDays: z.null(), serviceCredentialLifetimeDays: z.null() }),
        limits: z.object({ personalTokensPerUser: z.literal(10), serviceAccountsPerWorkspace: z.literal(50), credentialsPerServiceAccount: z.literal(5), maximumPageSize: z.literal(100) }),
        legacyCredentialMigration: z.object({ status: z.enum(["destroyed", "not_applicable"]), migratedAt: z.string().datetime().nullable() }),
        mcpCredentialSupport: z.literal("unsupported"),
      }) } } },
      ...errors,
    },
  });

  registry.registerPath({
    method: "get", path: "/api/v1/account/workspaces/{workspaceId}/api-access/personal-tokens",
    tags: ["API Access"], summary: "List personal-token metadata", operationId: "listPersonalApiTokens", security: session,
    request: { params: workspaceParams, query: pageQuery.extend({ view: z.enum(["mine", "workspace"]).optional() }) },
    responses: { 200: { description: "Safe personal-token metadata", content: { "application/json": { schema: paged(credential) } } }, ...errors },
  });
  registry.registerPath({
    method: "post", path: "/api/v1/account/workspaces/{workspaceId}/api-access/personal-tokens",
    tags: ["API Access"], summary: "Issue a personal API token", operationId: "issuePersonalApiToken", security: session,
    request: { params: workspaceParams, headers: csrfHeaders, body: { required: true, content: { "application/json": { schema: z.object({ label, roleCeiling: role, expiresAt: optionalExpiry }) } } } },
    responses: { 201: { description: "One-time personal-token secret", content: { "application/json": { schema: oneTimeCredential } } }, ...errors },
  });
  registry.registerPath({
    method: "patch", path: "/api/v1/account/workspaces/{workspaceId}/api-access/personal-tokens/{credentialId}",
    tags: ["API Access"], summary: "Relabel an owned personal token", operationId: "relabelPersonalApiToken", security: session,
    request: { params: credentialParams, headers: csrfHeaders, body: { required: true, content: { "application/json": { schema: z.object({ label, revision }) } } } },
    responses: { 200: { description: "Updated safe credential metadata", content: { "application/json": { schema: credential } } }, ...errors },
  });
  registry.registerPath({
    method: "post", path: "/api/v1/account/workspaces/{workspaceId}/api-access/personal-tokens/{credentialId}/rotate",
    tags: ["API Access"], summary: "Immediately rotate an owned personal token", operationId: "rotatePersonalApiToken", security: session,
    request: { params: credentialParams, headers: csrfHeaders, body: { required: true, content: { "application/json": { schema: z.object({ revision }) } } } },
    responses: { 201: { description: "One-time replacement secret", content: { "application/json": { schema: oneTimeCredential } } }, ...errors },
  });
  registry.registerPath({
    method: "post", path: "/api/v1/account/workspaces/{workspaceId}/api-access/personal-tokens/{credentialId}/revoke",
    tags: ["API Access"], summary: "Revoke a personal token", operationId: "revokePersonalApiToken", security: session,
    request: { params: credentialParams, headers: csrfHeaders },
    responses: { 200: { description: "Revoked safe credential metadata", content: { "application/json": { schema: credential } } }, ...errors },
  });

  registry.registerPath({
    method: "get", path: "/api/v1/account/workspaces/{workspaceId}/api-access/service-accounts",
    tags: ["API Access"], summary: "List workspace service accounts", operationId: "listServiceAccounts", security: session,
    request: { params: workspaceParams, query: pageQuery },
    responses: { 200: { description: "Service-account inventory", content: { "application/json": { schema: paged(serviceAccount) } } }, ...errors },
  });
  registry.registerPath({
    method: "post", path: "/api/v1/account/workspaces/{workspaceId}/api-access/service-accounts",
    tags: ["API Access"], summary: "Create a service account and first credential", operationId: "createServiceAccount", security: session,
    request: { params: workspaceParams, headers: csrfHeaders, body: { required: true, content: { "application/json": { schema: z.object({ displayName: label, role, initialCredential: z.object({ label, expiresAt: optionalExpiry }) }) } } } },
    responses: { 201: { description: "Service account and one-time credential secret", content: { "application/json": { schema: z.object({ serviceAccount, credential, secret: z.string() }) } } }, ...errors },
  });
  registry.registerPath({
    method: "get", path: "/api/v1/account/workspaces/{workspaceId}/api-access/service-accounts/{serviceAccountId}",
    tags: ["API Access"], summary: "Read a service account", operationId: "getServiceAccount", security: session,
    request: { params: serviceAccountParams },
    responses: { 200: { description: "Service-account metadata", content: { "application/json": { schema: serviceAccount } } }, ...errors },
  });
  registry.registerPath({
    method: "patch", path: "/api/v1/account/workspaces/{workspaceId}/api-access/service-accounts/{serviceAccountId}",
    tags: ["API Access"], summary: "Rename or change a service-account role", operationId: "updateServiceAccount", security: session,
    request: { params: serviceAccountParams, headers: csrfHeaders, body: { required: true, content: { "application/json": { schema: z.object({ displayName: label.optional(), role: role.optional(), revision }) } } } },
    responses: { 200: { description: "Updated service-account metadata", content: { "application/json": { schema: serviceAccount } } }, ...errors },
  });
  for (const action of ["disable", "enable", "archive"] as const) {
    registry.registerPath({
      method: "post", path: `/api/v1/account/workspaces/{workspaceId}/api-access/service-accounts/{serviceAccountId}/${action}`,
      tags: ["API Access"], summary: `${action[0]?.toUpperCase()}${action.slice(1)} a service account`, operationId: `${action}ServiceAccount`, security: session,
      request: { params: serviceAccountParams, headers: csrfHeaders, body: { required: true, content: { "application/json": { schema: z.object({ revision }) } } } },
      responses: { 200: { description: "Updated service-account metadata", content: { "application/json": { schema: serviceAccount } } }, ...errors },
    });
  }

  const credentialsPath = "/api/v1/account/workspaces/{workspaceId}/api-access/service-accounts/{serviceAccountId}/credentials";
  registry.registerPath({
    method: "get", path: credentialsPath, tags: ["API Access"], summary: "List service-account credentials", operationId: "listServiceAccountCredentials", security: session,
    request: { params: serviceAccountParams, query: pageQuery },
    responses: { 200: { description: "Safe service-credential metadata", content: { "application/json": { schema: paged(credential) } } }, ...errors },
  });
  registry.registerPath({
    method: "post", path: credentialsPath, tags: ["API Access"], summary: "Issue another service-account credential", operationId: "issueServiceAccountCredential", security: session,
    request: { params: serviceAccountParams, headers: csrfHeaders, body: { required: true, content: { "application/json": { schema: z.object({ label, expiresAt: optionalExpiry }) } } } },
    responses: { 201: { description: "One-time service credential secret", content: { "application/json": { schema: oneTimeCredential } } }, ...errors },
  });
  const credentialPath = `${credentialsPath}/{credentialId}`;
  registry.registerPath({
    method: "patch", path: credentialPath, tags: ["API Access"], summary: "Relabel a service-account credential", operationId: "relabelServiceAccountCredential", security: session,
    request: { params: serviceCredentialParams, headers: csrfHeaders, body: { required: true, content: { "application/json": { schema: z.object({ label, revision }) } } } },
    responses: { 200: { description: "Updated safe credential metadata", content: { "application/json": { schema: credential } } }, ...errors },
  });
  registry.registerPath({
    method: "post", path: `${credentialPath}/rotate`, tags: ["API Access"], summary: "Immediately rotate a service-account credential", operationId: "rotateServiceAccountCredential", security: session,
    request: { params: serviceCredentialParams, headers: csrfHeaders, body: { required: true, content: { "application/json": { schema: z.object({ revision }) } } } },
    responses: { 201: { description: "One-time replacement secret", content: { "application/json": { schema: oneTimeCredential } } }, ...errors },
  });
  registry.registerPath({
    method: "post", path: `${credentialPath}/revoke`, tags: ["API Access"], summary: "Revoke a service-account credential", operationId: "revokeServiceAccountCredential", security: session,
    request: { params: serviceCredentialParams, headers: csrfHeaders },
    responses: { 200: { description: "Revoked safe credential metadata", content: { "application/json": { schema: credential } } }, ...errors },
  });
};
