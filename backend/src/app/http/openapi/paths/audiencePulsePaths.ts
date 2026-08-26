import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

export const registerAudiencePulsePaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "get",
    path: "/api/v1/quality/audience-pulse",
    tags: ["Audience Pulse"],
    summary: "Read the saved Audience Pulse report",
    description: "Returns the one saved workspace report without invoking an AI provider. Requires a browser dashboard session; bearer/API authentication is intentionally not accepted.",
    operationId: "getAudiencePulse",
    security: security.workspaceAdminSecurity,
    responses: {
      200: { description: "Saved report or no saved report", content: { "application/json": { schema: schemas.AudiencePulseReadResponseSchema } } },
      401: { description: "Browser dashboard session required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      403: { description: "Caller lacks workspace.quality.read", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/v1/quality/audience-pulse/refresh-status",
    tags: ["Audience Pulse"],
    summary: "Read pending Audience Pulse preparation work",
    description: "Reports whether the durable facet queue still has work for this workspace. Requires a browser dashboard session; bearer/API authentication is intentionally not accepted.",
    operationId: "getAudiencePulseRefreshStatus",
    security: security.workspaceAdminSecurity,
    responses: {
      200: { description: "Facet preparation status", content: { "application/json": { schema: schemas.AudiencePulseRefreshStatusResponseSchema } } },
      401: { description: "Browser dashboard session required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      403: { description: "Caller lacks workspace.quality.read", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/v1/quality/audience-pulse/evidence-anchor",
    tags: ["Audience Pulse"],
    summary: "Read a bounded authorized source window",
    description: "Reads one workspace-authorized source message and, when it occurs before the next visitor turn, its next assistant reply. Source identifiers are supplied only in the JSON request body. Requires a browser dashboard session and workspace.history.read; bearer/API authentication is intentionally not accepted.",
    operationId: "getAudiencePulseEvidenceAnchor",
    security: security.workspaceAdminSecurity,
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: schemas.AudiencePulseEvidenceAnchorRequestSchema } },
      },
    },
    responses: {
      200: { description: "Bounded source and next assistant context", content: { "application/json": { schema: schemas.AudiencePulseEvidenceAnchorResponseSchema } } },
      400: { description: "Request validation failed", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      401: { description: "Browser dashboard session required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      403: { description: "Caller lacks workspace.history.read", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      404: { description: "Exact source was not found in the selected workspace conversation", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/v1/quality/audience-pulse",
    tags: ["Audience Pulse"],
    summary: "Analyze the last 30 days of visitor questions",
    description: "Explicitly refreshes one bounded saved workspace report. This route has a dedicated durable rate limit and accepts only a browser dashboard session, never bearer/API authentication.",
    operationId: "refreshAudiencePulse",
    security: security.workspaceAdminSecurity,
    responses: {
      200: { description: "Completed, no-traffic, or retryable inference result", content: { "application/json": { schema: schemas.AudiencePulseRefreshResponseSchema } } },
      401: { description: "Browser dashboard session required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      403: { description: "Caller lacks workspace.quality.read", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      409: { description: "A workspace refresh is already in progress", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      429: { description: "Refresh rate or usage capacity exceeded", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
      503: { description: "Workspace inference capability is unavailable", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    },
  });
};
