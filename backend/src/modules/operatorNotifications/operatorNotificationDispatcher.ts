import { ActionDispatchSkippedError, type ActionDispatchOutcome } from "../../shared/domain/actionDispatchOutcome.js";
import type {
  NotificationSkipReason,
  OperatorNotification,
  OperatorNotificationContext,
  OperatorNotificationSink,
  OperatorNotificationSinkOutcome,
} from "./operatorNotification.js";

/**
 * Skips that leave nothing undelivered: the sink had no destination of its own to reach, or the
 * approval it would announce is no longer waiting. Any other skip is a destination that was set up
 * and left out, which a send that reached another sink must still report.
 */
const NOTHING_LEFT_UNDELIVERED: ReadonlySet<NotificationSkipReason> = new Set([
  "contact_destination_not_configured",
  "slack_workspace_not_linked",
  "slack_not_installed",
  "slack_escalation_channel_not_configured",
  "slack_approval_not_pending",
]);

export class OperatorNotificationDispatcher {
  constructor(
    private readonly sinks: OperatorNotificationSink[],
    private readonly logger?: { warn(payload: Record<string, unknown>, message: string): void },
  ) {}

  /**
   * Resolves `partial` when a destination that was set up got nothing, so the action is not settled
   * as a whole send: a sink that reached only some of its own destinations, or a sink that skipped
   * (an address that has not confirmed, a cap) while another sink delivered. A sink with no
   * destination configured at all (Slack not linked) leaves nothing undelivered, so another sink
   * delivering still settles the action as dispatched.
   */
  async dispatch(notification: OperatorNotification, context: OperatorNotificationContext): Promise<ActionDispatchOutcome> {
    // Attempt every sink (one failing sink must not skip the others), then surface any failure so
    // the action outbox retries. Sinks are idempotent (email/webhook idempotency keys, slack.post
    // idempotency keys), so a retry re-attempts all without duplicating an already-sent message.
    const results = await Promise.allSettled(
      this.sinks.map((sink) => sink.deliver(notification, context)),
    );
    const failures: unknown[] = [];
    const skips: Extract<OperatorNotificationSinkOutcome, { disposition: "skipped" }>[] = [];
    const partials: Extract<OperatorNotificationSinkOutcome, { disposition: "partial" }>[] = [];
    let delivered = false;
    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value.disposition === "delivered") {
          delivered = true;
        } else if (result.value.disposition === "partial") {
          partials.push(result.value);
        } else {
          skips.push(result.value);
        }
        continue;
      }
      failures.push(result.reason);
      this.logger?.warn({
        event: "operator_notification_sink_failed",
        kind: notification.kind,
        workspaceId: notification.workspaceId,
        conversationId: notification.conversationId,
        // A provider's message can name the recipient; the app logger's serializer keeps only
        // the error's class, code and status.
        err: result.reason,
      }, "Operator notification sink failed");
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((reason) => (reason instanceof Error ? reason : new Error(String(reason)))),
        "Operator notification delivery failed",
      );
    }
    if (partials.length > 0) {
      return { disposition: "partial", reason: partials[0].reason };
    }
    if (!delivered) {
      throw new ActionDispatchSkippedError(skips[0]?.reason ?? "operator_notification_no_sink");
    }
    const leftOut = skips.find((skip) => !NOTHING_LEFT_UNDELIVERED.has(skip.reason));
    return leftOut ? { disposition: "partial", reason: leftOut.reason } : { disposition: "dispatched" };
  }
}
