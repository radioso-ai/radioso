import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { resolveReadableEventTypes, WORKSPACE_EVENTS_READ_PERMISSION } from "../../../modules/workspaceEvents/public.js";
import { badRequest } from "../../../shared/domain/errors.js";
import { WORKSPACE_EVENT_TYPES, type WorkspaceEventType } from "../../../shared/domain/workspaceEvents.js";
import { holdsWorkspacePermission, requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { validateQuery } from "../middleware/validate.js";

type WorkspaceEventRouteDependencies = WorkspaceSessionDependencies & Pick<AppDependencies, "workspaceEventLog">;

const DEFAULT_PAGE_SIZE = 50;

export const listWorkspaceEventsQuerySchema = z.object({
  types: z.string().trim().min(1).max(512).optional()
    .describe("Comma-separated event types to list, such as `routine.completed,contact_request.created`. Every type the caller may read when absent."),
  after: z.string().min(1).max(1024).optional()
    .describe("A `nextCursor` this list returned for the same `types`. Without it, the newest events and a cursor at the end of the log."),
  limit: z.coerce.number().int().min(1).max(100).optional().describe("Events per page, 1 to 100. Defaults to 50."),
}).strict();

const isEventType = (value: string): value is WorkspaceEventType =>
  (WORKSPACE_EVENT_TYPES as readonly string[]).includes(value);

/** A comma-separated `types` filter, each one a type the log records. */
const parseEventTypes = (value: string): WorkspaceEventType[] => {
  const names = [...new Set(value.split(",").map((name) => name.trim()).filter((name) => name.length > 0))];
  const unknown = names.filter((name) => !isEventType(name));
  if (names.length === 0 || unknown.length > 0) {
    throw badRequest("Unknown event types", { types: unknown });
  }
  return names.filter(isEventType);
};

/**
 * The workspace event log (#1851) at `/api/v1/workspace/events`, for automations that poll. It is
 * not the dashboard's `GET /api/v1/events` stream: that one carries invalidations to a signed-in
 * browser, this one business events to any caller holding `workspace.events.read`, each type only
 * to a caller who may read its subject elsewhere.
 */
export const createWorkspaceEventRoutes = (dependencies: WorkspaceEventRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const eventsRead = requireWorkspacePermission(dependencies, WORKSPACE_EVENTS_READ_PERMISSION);

  router.get("/", workspaceSession, eventsRead, validateQuery(listWorkspaceEventsQuerySchema), async (req, res, next) => {
    try {
      const query = req.query as z.infer<typeof listWorkspaceEventsQuerySchema>;
      const { workspaceId } = res.locals as { workspaceId: string };
      const requestedTypes = query.types === undefined ? null : parseEventTypes(query.types);
      const readableTypes = await resolveReadableEventTypes((permission) => holdsWorkspacePermission(dependencies, res, permission));
      const page = await dependencies.workspaceEventLog.list({
        workspaceId,
        readableTypes,
        requestedTypes,
        after: query.after ?? null,
        limit: query.limit ?? DEFAULT_PAGE_SIZE,
      });
      res.status(200).json(page);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
