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

  const topicStateResponses = (permission: string) => ({
    204: { description: "Done; a repeated call that changes nothing also answers 204" },
    400: { description: "Malformed topic id or request body", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    401: { description: "Browser dashboard session required", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    403: { description: `Caller lacks ${permission}`, content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
    404: { description: "The topic, or the document, is not in the selected workspace", content: { "application/json": { schema: schemas.ErrorResponseSchema } } },
  });
  registry.registerPath({
    method: "put",
    path: "/api/v1/quality/audience-pulse/topics/{topicId}/dismissal",
    tags: ["Audience Pulse"],
    summary: "Mark a topic \"not for us\"",
    description: "Takes the topic out of the report's content queue: the content gap reads back with dismissedAt set. No count changes, and the dismissal outlasts a refresh while the topic survives. Requires a browser dashboard session and workspace.quality.manage.",
    operationId: "dismissAudiencePulseTopic",
    security: security.workspaceAdminSecurity,
    request: { params: schemas.audiencePulseTopicParamsSchema },
    responses: topicStateResponses("workspace.quality.manage"),
  });
  registry.registerPath({
    method: "delete",
    path: "/api/v1/quality/audience-pulse/topics/{topicId}/dismissal",
    tags: ["Audience Pulse"],
    summary: "Return a dismissed topic to the content queue",
    description: "Clears the topic's dismissal. Requires a browser dashboard session and workspace.quality.manage.",
    operationId: "restoreAudiencePulseTopic",
    security: security.workspaceAdminSecurity,
    request: { params: schemas.audiencePulseTopicParamsSchema },
    responses: topicStateResponses("workspace.quality.manage"),
  });
  registry.registerPath({
    method: "post",
    path: "/api/v1/quality/audience-pulse/topics/{topicId}/drafts",
    tags: ["Audience Pulse"],
    summary: "Record a document drafted from a topic",
    description: "Links a workspace document to the topic, so the content gap reads back with latestDraft set. Deleting the document removes the link. Requires a browser dashboard session and workspace.documents.manage.",
    operationId: "linkAudiencePulseTopicDraft",
    security: security.workspaceAdminSecurity,
    request: {
      params: schemas.audiencePulseTopicParamsSchema,
      body: {
        required: true,
        content: { "application/json": { schema: schemas.AudiencePulseTopicDraftLinkRequestSchema } },
      },
    },
    responses: topicStateResponses("workspace.documents.manage"),
  });
};
