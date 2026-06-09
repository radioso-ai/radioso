import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

export const registerEnterpriseUsageLimitPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "get",
    path: "/api/v1/ee/usage-limits/org-creation/users/{userId}",
    tags: ["Enterprise Usage Limits"],
    summary: "Get a user's organization creation limit override",
    operationId: "getOrganizationCreationOverride",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.organizationCreationUserParamsSchema,
    },
    responses: {
      200: {
        description: "Organization creation override returned",
        content: {
          "application/json": {
            schema: schemas.OrganizationCreationOverrideResponseSchema,
          },
        },
      },
      401: {
        description: "Admin token required",
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
    path: "/api/v1/ee/usage-limits/org-creation/users/{userId}",
    tags: ["Enterprise Usage Limits"],
    summary: "Set a user's organization creation limit override",
    operationId: "setOrganizationCreationOverride",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.organizationCreationUserParamsSchema,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.OrganizationCreationOverrideRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Organization creation override updated",
        content: {
          "application/json": {
            schema: schemas.OrganizationCreationOverrideResponseSchema,
          },
        },
      },
      401: {
        description: "Admin token required",
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
    path: "/api/v1/ee/usage-limits/org-creation/users/{userId}",
    tags: ["Enterprise Usage Limits"],
    summary: "Delete a user's organization creation limit override",
    operationId: "deleteOrganizationCreationOverride",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.organizationCreationUserParamsSchema,
    },
    responses: {
      204: {
        description: "Organization creation override removed",
      },
      401: {
        description: "Admin token required",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });
};
