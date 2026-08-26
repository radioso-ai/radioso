import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const retryAfterHeaders = {
  "Retry-After": {
    description: "Minimum reconnect delay in whole seconds. The browser also applies its local jittered exponential backoff.",
    schema: { type: "string" as const, pattern: "^[1-9][0-9]*$" },
  },
};

export const registerWorkspaceEventsPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const requestHeaders = z.object({
    Accept: z.string().openapi({
      description: "Must contain the text/event-stream media range.",
      example: "text/event-stream",
      param: { in: "header", name: "Accept" },
    }),
    "X-Workspace-Id": z.string().uuid().openapi({
      description: "Workspace selected by the authenticated dashboard session.",
      example: "4d7293c8-d241-4f8f-a4db-3df5b88da44c",
      param: { in: "header", name: "X-Workspace-Id" },
    }),
  });
  const errorResponse = (description: string) => ({
    description,
    content: { "application/json": { schema: schemas.ErrorResponseSchema } },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/events",
    tags: ["Realtime"],
    summary: "Stream workspace dashboard invalidations",
    description: [
      "Opens the dashboard's workspace-scoped SSE transport after authentication, admission, and broker subscription succeed.",
      "Requires the dashboard session cookie, X-Workspace-Id, and an Accept header containing text/event-stream.",
      "Bearer API tokens and anonymous public-chat sessions are rejected. This transport is not an API-token SDK or MCP event surface.",
    ].join(" "),
    operationId: "streamWorkspaceEvents",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    request: { headers: requestHeaders },
    responses: {
      200: {
        description: "Workspace event stream committed; ready is the first data event",
        headers: {
          "Cache-Control": { description: "Disables intermediary transformation and caching.", schema: { type: "string", const: "no-cache, no-transform" } },
          Connection: { description: "Keeps the HTTP connection open for the event stream.", schema: { type: "string", const: "keep-alive" } },
          "X-Accel-Buffering": { description: "Disables reverse-proxy response buffering.", schema: { type: "string", const: "no" } },
        },
        content: { "text/event-stream": { schema: schemas.WorkspaceEventStreamSchema } },
      },
      400: errorResponse("Accept or workspace selection is malformed"),
      401: errorResponse("Dashboard session is missing, invalid, expired, or too near expiry to open a stream"),
      403: errorResponse("Dashboard session cannot access the selected workspace"),
      404: errorResponse("Realtime is disabled for this deployment or account"),
      405: {
        ...errorResponse("Only GET is supported"),
        headers: { Allow: { description: "Allowed method.", schema: { type: "string", const: "GET" } } },
      },
      429: {
        ...errorResponse("Reconnect or distributed workspace/account/principal admission limit exceeded"),
        headers: retryAfterHeaders,
      },
      503: {
        ...errorResponse("Realtime admission, broker subscription, or runtime capacity is temporarily unavailable"),
        headers: retryAfterHeaders,
      },
    },
  });
};
