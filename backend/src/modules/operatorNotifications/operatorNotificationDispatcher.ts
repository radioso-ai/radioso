import type {
  OperatorNotification,
  OperatorNotificationContext,
  OperatorNotificationSink,
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
    for (const result of results) {
      if (result.status === "fulfilled") {
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
  }
}
