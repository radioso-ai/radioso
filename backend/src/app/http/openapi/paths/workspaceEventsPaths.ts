import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSecurity } from "../openApiRegistry.js";

export const registerWorkspaceEventsPaths = (
  registry: OpenAPIRegistry,
  security: OpenApiSecurity,
): void => {
  registry.registerPath({
    method: "get",
    path: "/api/v1/events",
    tags: ["Events"],
    summary: "Stream live workspace change notifications",
    description:
      "Long-lived server-sent stream of workspace resource-change hints for the dashboard. " +
      "Emits a `ready` frame once the transport is live, then `push` frames carrying an " +
      "invalidation hint `{ resourceType, resourceId, workspaceId, changeKind, version }` — " +
      "identity only, never resource content; the client refetches the affected surface. " +
      "Comment lines beginning with `:` are heartbeats. Returns 404 when workspace push is " +
      "disabled.",
    operationId: "streamWorkspaceEvents",
    security: [
      ...security.workspaceAdminSecurity,
      { [security.bearerAuthScheme.name]: [] },
    ],
    responses: {
      200: {
        description:
          "Server-sent workspace change notifications. Events include `ready` then `push`.",
        content: {
          "text/event-stream": {
            schema: z.string(),
          },
        },
      },
      404: {
        description: "Workspace push is disabled",
      },
    },
  });
};
