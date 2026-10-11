import type { ErrorReporter } from "../../shared/errors/errorReporter.js";
import type { AuditService } from "../audit/contracts/index.js";

/** Where a failed best-effort step after an already-committed ownership action is reported. */
export interface CommittedAuditReporting {
  logger?: { warn(payload: Record<string, unknown>, message: string): void };
  errorReporter?: Pick<ErrorReporter, "report">;
}

interface CommittedOwnershipAuditEvent {
  /** The handoff audit stream: ownership changes (the default), or held-reply decisions. */
  eventType?: "hitl.ownership" | "hitl.held_reply";
  /** Null for an action no teammate took, such as a review's result being held. */
  accountId: string | null;
  workspaceId: string;
  metadata: Record<string, unknown> & { action: string; conversationId: string; actorUserId: string | null };
}

/**
 * Records the handoff audit event for an action that has already committed. The action stands
 * whatever happens here: a failed write is logged by ids and reported, never thrown, so no caller
 * is told a committed change failed — a REST client would retry it, a Slack card would go stale.
 */
export const recordCommittedOwnershipAudit = async (
  dependencies: { audit: Pick<AuditService, "record"> } & CommittedAuditReporting,
  event: CommittedOwnershipAuditEvent,
): Promise<void> => {
  const eventType = event.eventType ?? "hitl.ownership";
  try {
    await dependencies.audit.record({
      accountId: event.accountId,
      workspaceId: event.workspaceId,
      eventType,
      eventStatus: "success",
      metadata: event.metadata,
    });
  } catch (error) {
    const { action, conversationId, actorUserId } = event.metadata;
    dependencies.logger?.warn(
      {
        event: `${eventType.replace(".", "_")}_audit_failed`,
        action,
        accountId: event.accountId,
        workspaceId: event.workspaceId,
        conversationId,
        actorUserId,
        errorClass: error instanceof Error ? error.name : typeof error,
      },
      "Ownership audit record failed after the action committed",
    );
    void dependencies.errorReporter?.report({
      errorType: `${eventType}.audit_failed`,
      error,
      severity: "warn",
      correlation: { accountId: event.accountId ?? undefined, workspaceId: event.workspaceId, conversationId },
      metadata: { action },
    }).catch(() => undefined);
  }
};

interface CommittedOwnershipNotification {
  /** What was being told, e.g. `visitor_push`: a fixed name, never content. */
  notification: "visitor_push" | "dashboard_refresh";
  /** Null for an action no teammate took. */
  accountId: string | null;
  workspaceId: string;
  conversationId: string;
  messageId?: string;
}

/**
 * Runs a synchronous notification owed by an ownership action that has already committed — a push
 * to the visitor's open chat, a dashboard refresh. Like its audit, it never fails the action: a
 * throw is logged by ids and reported, and the caller is told the action succeeded, since it did.
 */
export const notifyAfterCommit = (
  dependencies: CommittedAuditReporting,
  event: CommittedOwnershipNotification,
  notify: () => void,
): void => {
  try {
    notify();
  } catch (error) {
    dependencies.logger?.warn(
      {
        event: "hitl_ownership_notification_failed",
        ...event,
        errorClass: error instanceof Error ? error.name : typeof error,
      },
      "Ownership notification failed after the action committed",
    );
    void dependencies.errorReporter?.report({
      errorType: "hitl.ownership.notification_failed",
      error,
      severity: "warn",
      correlation: { accountId: event.accountId ?? undefined, workspaceId: event.workspaceId, conversationId: event.conversationId },
      metadata: { notification: event.notification, messageId: event.messageId },
    }).catch(() => undefined);
  }
};
