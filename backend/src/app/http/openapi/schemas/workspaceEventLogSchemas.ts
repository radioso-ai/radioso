import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { listWorkspaceEventsQuerySchema } from "../../routes/workspaceEventLogRoutes.js";
import {
  WORKSPACE_EVENT_TYPES,
  WORKSPACE_EVENT_VERSIONS,
  workspaceEventDataSchema,
  type WorkspaceEventType,
} from "../../../../shared/domain/workspaceEventLog.js";

/** The component name each type's event is published under, as `routine.completed` → `RoutineCompletedEvent`. */
const componentName = (type: WorkspaceEventType): string =>
  `${type.split(/[._]/u).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("")}Event`;

/** The workspace event log's envelope, one schema per type with its typed `data`. */
export const registerWorkspaceEventLogSchemas = (registry: OpenAPIRegistry) => {
  const eventSchema = (type: WorkspaceEventType) => registry.register(componentName(type), z.object({
    id: z.string().uuid().describe("The event's id: stable, and the key a delivery or a poller deduplicates on."),
    type: z.literal(type),
    version: z.literal(WORKSPACE_EVENT_VERSIONS[type]).describe("The version of this type's `data` schema the event was written with."),
    occurredAt: z.string().datetime().describe("When the change the event records happened."),
    workspaceId: z.string().uuid(),
    data: workspaceEventDataSchema(type),
  }));
  const [first, ...rest] = WORKSPACE_EVENT_TYPES.map((type) => eventSchema(type));
  const WorkspaceEventSchema = registry.register("WorkspaceEvent", z.discriminatedUnion("type", [first, ...rest]));
  const WorkspaceEventPageSchema = registry.register("WorkspaceEventPage", z.object({
    events: z.array(WorkspaceEventSchema),
    nextCursor: z.string().describe("Pass back as `after` for the events that follow. Present on every page, empty ones included, so a client keeps its place."),
    hasMore: z.boolean().describe("True when more events follow `nextCursor` now."),
  }));

  return {
    WorkspaceEventSchema,
    WorkspaceEventPageSchema,
    ListWorkspaceEventsQuerySchema: listWorkspaceEventsQuerySchema,
  };
};
