import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

export const registerSupportPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "post",
    path: "/api/v1/support/impersonations",
    tags: ["Support"],
    summary: "Approve a support impersonation session",
    operationId: "approveSupportImpersonation",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.SupportImpersonationApproveRequestSchema,
          },
        },
      },
    },
    responses: {
      201: {
        description: "Support impersonation approved",
        content: {
          "application/json": {
            schema: schemas.SupportImpersonationSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/support/impersonations/{id}/start",
    tags: ["Support"],
    summary: "Start an approved support impersonation session",
    operationId: "startSupportImpersonation",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    request: {
      params: schemas.supportImpersonationParamsSchema,
    },
    responses: {
      200: {
        description: "Support impersonation started",
        content: {
          "application/json": {
            schema: schemas.SupportImpersonationSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/support/impersonations/{id}/end",
    tags: ["Support"],
    summary: "End a support impersonation session",
    operationId: "endSupportImpersonation",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    request: {
      params: schemas.supportImpersonationParamsSchema,
    },
    responses: {
      200: {
        description: "Support impersonation ended",
        content: {
          "application/json": {
            schema: schemas.SupportImpersonationSchema,
          },
        },
      },
    },
  });
};
