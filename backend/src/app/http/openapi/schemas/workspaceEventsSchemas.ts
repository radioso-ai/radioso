import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import {
  INVALIDATION_KINDS,
  protocolVersion,
  workspaceInvalidationKindSchema,
} from "@radioso/workspace-invalidation-contract";

import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

export const registerWorkspaceEventsSchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const WorkspaceInvalidationKindSchema = registry.register(
    "WorkspaceInvalidationKind",
    workspaceInvalidationKindSchema,
  );
  const protocolData = { protocolVersion: z.literal(protocolVersion) };
  const WorkspaceEventReadyDataSchema = registry.register(
    "WorkspaceEventReadyData",
    z.object(protocolData).strict(),
  );
  const WorkspaceEventInvalidateDataSchema = registry.register(
    "WorkspaceEventInvalidateData",
    z.object({
      ...protocolData,
      changeKinds: z.array(WorkspaceInvalidationKindSchema)
        .min(1)
        .max(INVALIDATION_KINDS.length)
        .openapi({
          description: "Unique invalidation kinds; clients ignore unknown future kinds and retain their polling floor.",
          uniqueItems: true,
        }),
    }).strict(),
  );
  const WorkspaceEventResyncDataSchema = registry.register(
    "WorkspaceEventResyncData",
    z.object(protocolData).strict(),
  );
  const WorkspaceEventStreamSchema = registry.register(
    "WorkspaceEventStream",
    z.string().openapi({
      description: [
        "A server-sent event stream with named ready, invalidate, and resync events.",
        "Each data field is JSON matching the corresponding WorkspaceEvent*Data schema.",
        "Heartbeat records are SSE comments (`: heartbeat`) and carry no data.",
        "Protocol version 1 has no event ID, cursor, replay, timestamp, or resource identifier.",
      ].join(" "),
      example: [
        "event: ready",
        'data: {"protocolVersion":1}',
        "",
        "event: invalidate",
        'data: {"protocolVersion":1,"changeKinds":["document.status_changed"]}',
        "",
        "event: resync",
        'data: {"protocolVersion":1}',
        "",
      ].join("\n"),
    }),
  );

  Object.assign(schemas, {
    WorkspaceEventInvalidateDataSchema,
    WorkspaceEventReadyDataSchema,
    WorkspaceEventResyncDataSchema,
    WorkspaceEventStreamSchema,
    WorkspaceInvalidationKindSchema,
  });
};
