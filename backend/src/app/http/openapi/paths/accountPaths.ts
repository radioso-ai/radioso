import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

export const registerAccountManagementPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "get",
    path: "/api/v1/account/usage-trends",
    tags: ["Account"],
    summary: "Get account usage trends",
    description:
      "Returns UTC-bucketed usage trends for the current account. Token totals include succeeded usage events only. " +
      "When an agent filter is supplied, usage events without conversation lineage are excluded because they cannot be attributed to that agent.",
    operationId: "getAccountUsageTrends",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    request: {
      query: schemas.UsageTrendsQuerySchema,
    },
    responses: {
      200: {
        description: "Usage trends returned",
        content: {
          "application/json": {
            schema: schemas.UsageTrendsResponseSchema,
          },
        },
      },
      400: {
        description: "Invalid date range, bucket count, or account-scoped filter",
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
    path: "/api/v1/account/usage/messages",
    tags: ["Account"],
    summary: "Get detailed message AI usage",
    description:
      "Returns one aggregated row for each end-user message in the active account. Model, embedding, and unknown-historical usage remain separate. " +
      "The response excludes message content, prompts, completions, provider request IDs, idempotency keys, and error detail.",
    operationId: "getAccountUsageMessages",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    request: { query: schemas.UsageDetailsQuerySchema },
    responses: {
      200: {
        description: "Detailed message usage returned",
        content: { "application/json": { schema: schemas.MessageUsageResponseSchema } },
      },
      400: {
        description: "Invalid detailed-usage range, cursor, limit, or account-scoped workspace filter",
        content: { "application/json": { schema: schemas.ErrorResponseSchema } },
      },
      401: {
        description: "Authentication required",
        content: { "application/json": { schema: schemas.ErrorResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/account/usage/internal-operations",
    tags: ["Account"],
    summary: "Get detailed internal AI usage",
    description:
      "Returns individual internal model, embedding, and unknown-historical usage attempts for the active account. " +
      "The response excludes message content, prompts, completions, provider request IDs, idempotency keys, and error detail.",
    operationId: "getAccountInternalUsage",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    request: { query: schemas.UsageDetailsQuerySchema },
    responses: {
      200: {
        description: "Detailed internal usage returned",
        content: { "application/json": { schema: schemas.InternalUsageResponseSchema } },
      },
      400: {
        description: "Invalid detailed-usage range, cursor, limit, or account-scoped workspace filter",
        content: { "application/json": { schema: schemas.ErrorResponseSchema } },
      },
      401: {
        description: "Authentication required",
        content: { "application/json": { schema: schemas.ErrorResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/account/accounts",
    tags: ["Account"],
    summary: "Create an additional organization",
    description: "Creates and switches to an additional organization. This capability is available in Enterprise Edition.",
    operationId: "createAdditionalOrganization",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.CreateAccountRequestSchema,
          },
        },
      },
    },
    responses: {
      201: {
        description: "Organization created and session switched",
        content: {
          "application/json": {
            schema: schemas.LoginResponseSchema,
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
      403: {
        description: "Additional organization creation is unavailable in this edition",
        content: { "application/json": { schema: schemas.ErrorResponseSchema } },
      },
      429: {
        description: "Enterprise monthly organization creation limit reached",
        content: { "application/json": { schema: schemas.ErrorResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/account/users",
    tags: ["Account"],
    summary: "List active account users and invitations",
    operationId: "listAccountUsers",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    responses: {
      200: {
        description: "Account users returned",
        content: {
          "application/json": {
            schema: schemas.AccountUsersResponseSchema,
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
    path: "/api/v1/account/accounts",
    tags: ["Account"],
    summary: "List accessible accounts for the current user",
    operationId: "listAccessibleAccounts",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    responses: {
      200: {
        description: "Accessible accounts returned",
        content: {
          "application/json": {
            schema: schemas.AccessibleAccountsResponseSchema,
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
    path: "/api/v1/account/invitations",
    tags: ["Account"],
    summary: "Create an account invitation",
    operationId: "createAccountInvitation",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.AccountInvitationCreateRequestSchema,
          },
        },
      },
    },
    responses: {
      201: {
        description: "Invitation created",
        content: {
          "application/json": {
            schema: schemas.CreateAccountInvitationResponseSchema,
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
      409: {
        description: "Invitation already pending or user already has access",
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
    path: "/api/v1/account/invitations/{invitationId}",
    tags: ["Account"],
    summary: "Revoke a pending account invitation",
    operationId: "revokeAccountInvitation",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    request: {
      params: schemas.accountInvitationParamsSchema,
    },
    responses: {
      204: {
        description: "Invitation revoked",
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
        description: "Permission required",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Invitation not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      409: {
        description: "Invitation has already been accepted",
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
    path: "/api/v1/account/users/{membershipId}",
    tags: ["Account"],
    summary: "Update an account user's role",
    operationId: "updateAccountUserRole",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    request: {
      params: schemas.accountMembershipParamsSchema,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.AccountMembershipRoleUpdateRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Membership role updated",
        content: {
          "application/json": {
            schema: schemas.AccountUserSchema,
          },
        },
      },
      403: {
        description: "Role management is not allowed for the caller",
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
    path: "/api/v1/account/workspaces/{workspaceId}/grants/{userId}",
    tags: ["Account"],
    summary: "Set a workspace role grant",
    operationId: "setWorkspaceGrant",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    request: {
      params: schemas.workspaceGrantParamsSchema,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.WorkspaceGrantRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Workspace grant updated",
        content: {
          "application/json": {
            schema: schemas.WorkspaceGrantSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/account/workspaces/{workspaceId}/grants/{userId}",
    tags: ["Account"],
    summary: "Remove a workspace role grant",
    operationId: "removeWorkspaceGrant",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    request: {
      params: schemas.workspaceGrantParamsSchema,
    },
    responses: {
      204: {
        description: "Workspace grant removed",
      },
    },
  });
};

export const registerAccountSessionPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "post",
    path: "/api/v1/account/switch",
    tags: ["Account"],
    summary: "Switch the current session to another accessible account",
    operationId: "switchAccount",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.accountSwitchSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Account switched",
        content: {
          "application/json": {
            schema: schemas.LoginResponseSchema,
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
    path: "/api/v1/account/users/{membershipId}",
    tags: ["Account"],
    summary: "Remove account user access",
    operationId: "removeAccountUser",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    request: {
      params: schemas.accountMembershipParamsSchema,
    },
    responses: {
      204: {
        description: "Account user removed",
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
        description: "Owner access required",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Membership not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      409: {
        description: "Membership cannot be removed",
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
    path: "/api/v1/account/workspaces/{workspaceId}/token",
    tags: ["Account"],
    summary: "Reveal the workspace API token for manual SDK or CLI use",
    operationId: "getWorkspaceApiToken",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    request: {
      params: schemas.workspaceParamsSchema,
    },
    responses: {
      200: {
        description: "Workspace token returned",
        content: {
          "application/json": {
            schema: schemas.WorkspaceTokenResponseSchema,
          },
        },
      },
      400: {
        description: "Invalid workspace id",
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
      403: {
        description: "Workspace token no longer resolves to an active workspace",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      429: {
        description: "Token reveal temporarily rate limited",
        content: {
          "application/json": {
            schema: schemas.RateLimitExceededSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/account/workspaces/{workspaceId}/token/rotate",
    tags: ["Account"],
    summary: "Rotate the workspace API token",
    operationId: "rotateWorkspaceApiToken",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    request: {
      params: schemas.workspaceParamsSchema,
    },
    responses: {
      200: {
        description: "Workspace token rotated",
        content: {
          "application/json": {
            schema: schemas.WorkspaceTokenResponseSchema,
          },
        },
      },
      400: {
        description: "Invalid workspace id",
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
      403: {
        description: "Workspace does not belong to the current account",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      429: {
        description: "Too many rotate attempts",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      503: {
        description: "Workspace token secret is not configured",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });
};
