import { ActionDispatchSkippedError, type ActionDispatchOutcome } from "../../shared/domain/actionDispatchOutcome.js";
import type {
  OperatorNotification,
  OperatorNotificationContext,
  OperatorNotificationSink,
  OperatorNotificationSinkOutcome,
} from "./operatorNotification.js";

export class OperatorNotificationDispatcher {
  constructor(
    private readonly sinks: OperatorNotificationSink[],
    private readonly logger?: { warn(payload: Record<string, unknown>, message: string): void },
  ) {}

  /**
   * Resolves `partial` when a destination that was set up got nothing, so the action is not settled
   * as a whole send: a sink that reached only some of its own destinations, or a sink that skipped
   * (an address that has not confirmed, a cap) while another sink delivered. A sink that reports
   * itself `not_applicable` (Slack not linked) leaves nothing undelivered, so another sink
   * delivering still settles the action as dispatched. The sinks' dispositions decide this alone.
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
    // Everything that delivered nothing, in sink order, for the reason a send that reached no one reports.
    const unmet: Extract<OperatorNotificationSinkOutcome, { disposition: "skipped" | "not_applicable" }>[] = [];
    const partials: Extract<OperatorNotificationSinkOutcome, { disposition: "partial" }>[] = [];
    let delivered = false;
    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value.disposition === "delivered") {
          delivered = true;
        } else if (result.value.disposition === "partial") {
          partials.push(result.value);
        } else {
          unmet.push(result.value);
          if (result.value.disposition === "skipped") skips.push(result.value);
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
      throw new ActionDispatchSkippedError(unmet[0]?.reason ?? "operator_notification_no_sink");
    }
    return skips.length > 0 ? { disposition: "partial", reason: skips[0].reason } : { disposition: "dispatched" };
  }
}
