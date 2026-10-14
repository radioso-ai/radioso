const SUPPRESSIBLE_EMAIL_KINDS = new Set([
  "contact_notification",
  "operator_notice",
  "recipient_confirmation",
]);

type SuppressionReason = "hard_bounce" | "complaint";

const notificationProviderSuppressionReason = (input: {
  emailKind: string | null;
  status: { type: string; bounce?: { type: string } | null };
}): SuppressionReason | null => {
  if (!input.emailKind || !SUPPRESSIBLE_EMAIL_KINDS.has(input.emailKind)) return null;
  if (input.status.type === "complained") return "complaint";
  return input.status.type === "bounced" && input.status.bounce?.type.toLowerCase() === "permanent"
    ? "hard_bounce"
    : null;
};

/** Where a provider's permanent bounces and complaints about notification mail are kept. */
export interface NotificationSuppressionStore {
  suppress(input: {
    email: string;
    reason: SuppressionReason;
    provider: string;
    providerEventId: string;
  }): Promise<void>;
}

interface SuppressionObservability {
  logger: {
    info(payload: Record<string, unknown>, message: string): void;
    error(payload: Record<string, unknown>, message: string): void;
  };
  metrics?: {
    incrementCounter(name: string, options: { help: string; labels?: Record<string, string>; value?: number }): void;
  } | null;
}

/**
 * Records one verified provider delivery event against the notification suppression list. Both
 * handlers of the provider webhook call this, whether or not the inbound email channel is on. It
 * rethrows when the store fails, so the handler can answer with a status the provider retries.
 */
export const recordNotificationSuppression = async (input: {
  event: {
    providerEventId: string;
    recipients: readonly string[];
    emailKind: string | null;
    status: { type: string; bounce?: { type: string } | null };
  };
  provider: string;
  store: NotificationSuppressionStore;
} & SuppressionObservability): Promise<void> => {
  const reason = notificationProviderSuppressionReason(input.event);
  const recipientCount = input.event.recipients.length;
  if (!reason || recipientCount === 0) return;
  try {
    await Promise.all(input.event.recipients.map((email) => input.store.suppress({
      email,
      reason,
      provider: input.provider,
      providerEventId: input.event.providerEventId,
    })));
  } catch (error) {
    input.logger.error({
      event: "notification_recipient_suppression_failed",
      provider: input.provider,
      reason,
      recipientCount,
      errorName: error instanceof Error ? error.name : "unknown",
    }, "Notification recipient suppression could not be recorded");
    throw error;
  }
  input.metrics?.incrementCounter("notification_recipient_suppression_events_total", {
    help: "Notification recipient suppressions recorded from provider events.",
    labels: { reason },
    value: recipientCount,
  });
  input.logger.info({
    event: "notification_recipient_suppressed",
    provider: input.provider,
    reason,
    recipientCount,
  }, "Notification recipients suppressed");
};
