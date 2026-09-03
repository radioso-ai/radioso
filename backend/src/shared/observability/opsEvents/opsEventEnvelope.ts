import type { ProductAnalyticsEvent } from "../../analytics/productAnalyticsTypes.js";
import type { ErrorEvent } from "../../errors/errorTypes.js";

export type OpsEventKind = "product_analytics" | "error";
export type OpsEventSeverity = "info" | "warn" | "error";

export const opsEventSeverityOrder: Record<OpsEventSeverity, number> = {
  info: 0,
  warn: 1,
  error: 2,
};

/**
 * One wire shape for both streams, so a receiver parses a single envelope and routes on
 * `kind` and `name`. The typed `name` is the routing key on purpose: deriving urgency
 * from the event text here would bake product vocabulary into the transport.
 */
export interface OpsEventEnvelope {
  id: string;
  kind: OpsEventKind;
  name: string;
  timestamp: string;
  severity: OpsEventSeverity;
  workspaceId?: string;
  accountId?: string;
  payload: Record<string, unknown>;
}

export const toOpsEventFromAnalytics = (
  event: ProductAnalyticsEvent,
  id: string,
): OpsEventEnvelope => ({
  id,
  kind: "product_analytics",
  name: event.eventName,
  timestamp: event.timestamp,
  // A product event records something that happened, not something that went wrong.
  severity: "info",
  workspaceId: event.workspaceId,
  accountId: event.accountId,
  payload: {
    actorType: event.actorType,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    source: event.source,
    properties: event.properties,
  },
});

export const toOpsEventFromError = (event: ErrorEvent, id: string): OpsEventEnvelope => ({
  id,
  kind: "error",
  name: event.errorType,
  timestamp: event.timestamp,
  severity: event.severity,
  workspaceId: event.correlation?.workspaceId,
  accountId: event.correlation?.accountId,
  payload: {
    service: event.service,
    environment: event.environment,
    version: event.version,
    message: event.message,
    errorClass: event.errorClass,
    stack: event.stack,
    requestContext: event.requestContext,
    correlation: event.correlation,
    metadata: event.metadata,
    tags: event.tags,
  },
});
