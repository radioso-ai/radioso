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
    const results = await Promise.allSettled(
      this.sinks.map((sink) => sink.deliver(notification, context)),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        continue;
      }
      this.logger?.warn({
        event: "operator_notification_sink_failed",
        kind: notification.kind,
        workspaceId: notification.workspaceId,
        conversationId: notification.conversationId,
        err: result.reason instanceof Error ? result.reason.message : String(result.reason),
      }, "Operator notification sink failed");
    }
  }
}
