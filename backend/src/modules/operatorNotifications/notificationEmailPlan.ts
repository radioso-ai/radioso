import type { NotificationDeliveryAdmission, NotificationDeliveryAdmissionPort } from "./notificationDeliveryAdmission.js";
import type { NotificationRecipientPolicyPort } from "./notificationRecipientPolicy.js";

type RecipientDecision = Awaited<ReturnType<NotificationRecipientPolicyPort["prepareDelivery"]>>;
type AdmissionReason = NonNullable<NotificationDeliveryAdmission["reason"]>;
type RecipientSkipReason = "notification_recipient_unconfirmed" | "notification_recipient_suppressed";

export type NotificationEmailPlan =
  | {
      /** The conversation has used its dispatch allowance: neither email nor webhook goes out. */
      dispatchAllowed: false;
      reason: AdmissionReason;
    }
  | {
      dispatchAllowed: true;
      recipients: RecipientDecision["eligibleRecipients"];
      /** Why no configured address receives this email, when policy rather than the transport decided. */
      emailSkipReason: AdmissionReason | RecipientSkipReason | null;
    };

const NO_ELIGIBLE_RECIPIENTS: RecipientDecision = {
  eligibleEmails: [],
  eligibleRecipients: [],
  skipped: { unconfirmed: 0, suppressed: 0 },
};

const recipientSkipReason = (decision: RecipientDecision): RecipientSkipReason =>
  decision.skipped.suppressed > 0 && decision.skipped.unconfirmed === 0
    ? "notification_recipient_suppressed"
    : "notification_recipient_unconfirmed";

/**
 * Decides who receives a contact or operator-notice email, in the order the anti-abuse rules need:
 * recipient confirmation first, then the conversation and daily caps over the addresses that remain.
 * A configured webhook still goes out when recipient state cannot be read, but email then fails
 * closed; with no webhook the failure propagates so the action retries.
 */
export const planNotificationEmail = async (input: {
  recipientPolicy: Pick<NotificationRecipientPolicyPort, "prepareDelivery">;
  admission: NotificationDeliveryAdmissionPort | undefined;
  webhookConfigured: boolean;
  onPreparationFailure: (error: unknown) => void;
  request: {
    requestId: string;
    workspaceId: string;
    accountId: string | null;
    conversationId: string | null;
    agentId?: string | null;
    emails: readonly string[];
    idempotencyKey: string;
  };
}): Promise<NotificationEmailPlan> => {
  const { request } = input;
  let decision: RecipientDecision;
  try {
    decision = await input.recipientPolicy.prepareDelivery({
      workspaceId: request.workspaceId,
      agentId: request.agentId,
      conversationId: request.conversationId,
      emails: request.emails,
      idempotencyKey: request.idempotencyKey,
    });
  } catch (error) {
    if (!input.webhookConfigured) throw error;
    input.onPreparationFailure(error);
    decision = NO_ELIGIBLE_RECIPIENTS;
  }

  const admission = await input.admission?.admit({
    requestId: request.requestId,
    workspaceId: request.workspaceId,
    accountId: request.accountId,
    conversationId: request.conversationId,
    recipientEmails: decision.eligibleEmails,
    requestedEmailCount: decision.eligibleEmails.length,
  });
  if (admission && !admission.dispatchAllowed) {
    return { dispatchAllowed: false, reason: admission.reason ?? "conversation_dispatch_cap" };
  }
  if (admission?.emailAllowed === false) {
    return { dispatchAllowed: true, recipients: [], emailSkipReason: admission.reason ?? "workspace_daily_email_cap" };
  }
  return {
    dispatchAllowed: true,
    recipients: decision.eligibleRecipients,
    emailSkipReason: decision.eligibleRecipients.length === 0 ? recipientSkipReason(decision) : null,
  };
};
