import { ActionDispatchSkippedError } from "../../shared/domain/actionDispatchOutcome.js";
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

  async dispatch(notification: OperatorNotification, context: OperatorNotificationContext): Promise<void> {
    // Attempt every sink (one failing sink must not skip the others), then surface any failure so
    // the action outbox retries. Sinks are idempotent (email/webhook idempotency keys, slack.post
    // idempotency keys), so a retry re-attempts all without duplicating an already-sent message.
    const results = await Promise.allSettled(
      this.sinks.map((sink) => sink.deliver(notification, context)),
    );
    const failures: unknown[] = [];
    const skips: Extract<OperatorNotificationSinkOutcome, { disposition: "skipped" }>[] = [];
    let delivered = false;
    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value.disposition === "delivered") {
          delivered = true;
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
        err: result.reason instanceof Error ? result.reason.message : String(result.reason),
      }, "Operator notification sink failed");
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((reason) => (reason instanceof Error ? reason : new Error(String(reason)))),
        "Operator notification delivery failed",
      );
    }
    if (!delivered) {
      throw new ActionDispatchSkippedError(skips[0]?.reason ?? "operator_notification_no_sink");
    }
  }
}
