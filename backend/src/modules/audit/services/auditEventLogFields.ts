import { isCode, isUuid } from "../../../shared/observability/logging/logSafeValues.js";
import type { AuditEventInput } from "../contracts/index.js";

type LoggableValue = string | number | boolean;

type AuditEventLogFields = Pick<AuditEventInput, "accountId" | "workspaceId" | "eventType" | "eventStatus"> & {
  metadata?: Record<string, LoggableValue>;
};

// The audit_event line lands in Cloud Logging, which conversation erasure cannot reach, so it
// carries only values whose shape rules out a visitor's words: ids, counts, durations, flags and
// the coded fields below. The full metadata stays in audit_events, where erasure applies.

// Fields the server fills from a closed set of codes: the request audit context's principal
// (requestAuditContext.ts) and a chat turn's workflow and execution labels (chatTurnLifecycle.ts).
// Each value must still be a code, so a sentence under a same-named key never reaches the line.
const CODED_FIELDS = new Set(["principalKind", "role", "stage", "workflow", "executionClass", "executionMode", "surface"]);

// pino-http's request counter, merged in from the request audit context.
const isRequestId = (key: string, value: string): boolean => key === "requestId" && /^\d+$/u.test(value);

const isLoggable = (key: string, value: unknown): value is LoggableValue => {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  return isUuid(value) || isRequestId(key, value) || (CODED_FIELDS.has(key) && isCode(value));
};

export const auditEventLogFields = (event: AuditEventInput): AuditEventLogFields => {
  const metadata = Object.fromEntries(
    Object.entries(event.metadata ?? {}).filter((entry): entry is [string, LoggableValue] => isLoggable(...entry)),
  );

  return {
    accountId: event.accountId,
    workspaceId: event.workspaceId,
    eventType: event.eventType,
    eventStatus: event.eventStatus,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
};
