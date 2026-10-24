import { logSafeMetadata, type LogSafeValue } from "../../../shared/observability/logging/logSafeValues.js";
import type { AuditEventInput } from "../contracts/index.js";

type AuditEventLogFields = Pick<AuditEventInput, "accountId" | "workspaceId" | "eventType" | "eventStatus"> & {
  metadata?: Record<string, LogSafeValue>;
};

// The audit_event line lands in Cloud Logging, which conversation erasure cannot reach, so it
// carries only values whose shape rules out a visitor's words: ids, counts, durations, flags and
// the coded fields below. The full metadata stays in audit_events, where erasure applies.

// Fields the server fills from a closed set of codes: the request audit context's principal
// (requestAuditContext.ts) and a chat turn's workflow and execution labels (chatTurnLifecycle.ts).
// Each value must still be a code, so a sentence under a same-named key never reaches the line.
const CODED_FIELDS = new Set(["principalKind", "role", "stage", "workflow", "executionClass", "executionMode", "surface"]);

export const auditEventLogFields = (event: AuditEventInput): AuditEventLogFields => {
  const metadata = logSafeMetadata(event.metadata, { coded: CODED_FIELDS });

  return {
    accountId: event.accountId,
    workspaceId: event.workspaceId,
    eventType: event.eventType,
    eventStatus: event.eventStatus,
    ...(metadata ? { metadata } : {}),
  };
};
