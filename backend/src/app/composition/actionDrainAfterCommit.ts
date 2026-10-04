import type { ActionDrainDispatcherPort } from "../../modules/chat/composition.js";
import type { ErrorReporter } from "../../shared/errors/errorReporter.js";
import type { AppLogger } from "../../shared/observability/logger.js";

/** The row a committed transaction queued, by ids only: what a failed drain push is logged with. */
export interface QueuedOutboxRow {
  workspaceId?: string | null;
  conversationId?: string | null;
}

/**
 * Pushes an action-outbox drain once a transaction that queued a row has committed. Best-effort:
 * the interval poller and the recovery sweep still pick the row up, so a failed push is logged by
 * ids and reported, never thrown at a caller whose change already stands.
 */
export const pushActionDrainAfterCommit = async (
  deps: {
    actionDrain: ActionDrainDispatcherPort;
    logger: Pick<AppLogger, "warn">;
    errorReporter?: Pick<ErrorReporter, "report">;
  },
  event: string,
  queued: QueuedOutboxRow,
): Promise<void> => {
  try {
    await deps.actionDrain.requestDrain();
  } catch (error) {
    const workspaceId = queued.workspaceId ?? undefined;
    const conversationId = queued.conversationId ?? undefined;
    deps.logger.warn(
      { event, workspaceId, conversationId, errorClass: error instanceof Error ? error.name : typeof error },
      "Action outbox drain push failed; the interval poller or recovery sweep will pick this up",
    );
    void deps.errorReporter?.report({
      errorType: "action_outbox.drain_push_failed",
      error,
      severity: "warn",
      correlation: { workspaceId, conversationId },
      metadata: { event },
    }).catch(() => undefined);
  }
};
