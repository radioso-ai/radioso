import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";
import { registerWorkspaceEventLogSchemas } from "../schemas/workspaceEventLogSchemas.js";

/** The workspace event log (#1851): business events an automation polls, by a commit-safe cursor. */
export const registerWorkspaceEventLogPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const log = registerWorkspaceEventLogSchemas(registry);
  const sec = [{ [security.bearerAuthScheme.name]: [] }];
  const json = (schema: z.ZodTypeAny) => ({ "application/json": { schema } });
  const errorResponse = (description: string) => ({ description, content: json(schemas.ErrorResponseSchema) });

  registry.registerPath({
    method: "get",
    path: "/api/v1/workspace/events",
    tags: ["Workspace Events"],
    summary: "List workspace events",
    description: [
      "Business events in this workspace, kept 30 days: a conversation started, a contact request, a handoff, a routine run ended, a decision waiting.",
      "Without `after`, returns the newest events, oldest first, and a `nextCursor` at the end of the log; pass it back as `after` to page forward.",
      "Paging is complete: an event whose transaction commits after a later-numbered one is still returned to a client that paged past that number.",
      "Each type needs the permission that reads its subject elsewhere: `workspace.history.read`, and for `decision.pending` also `workspace.conversation.takeover`.",
      "Payloads carry ids and the values an automation acts on, never a transcript; fetch one with `GET /api/v1/history/chat/{conversationId}`.",
      "This is not the dashboard's `GET /api/v1/events` stream.",
    ].join(" "),
    operationId: "listWorkspaceEvents",
    security: sec,
    request: { query: log.ListWorkspaceEventsQuerySchema },
    responses: {
      200: { description: "A page of workspace events", content: json(log.WorkspaceEventPageSchema) },
      400: errorResponse("An invalid query, an unknown event type, or a cursor issued for different types"),
      401: errorResponse("Authentication required"),
      403: errorResponse("Event log read permission required, or a requested type the caller may not read"),
      410: errorResponse("The cursor is older than the log's retention window; start again without one"),
    },
  });
  return { WorkspaceEventSchema: log.WorkspaceEventSchema };
};
