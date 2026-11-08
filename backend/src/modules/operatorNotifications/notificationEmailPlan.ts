import { normalizeRecipientEmail } from "../../shared/domain/recipientEmailAudit.js";
import type { NotificationDeliveryAdmission, NotificationDeliveryAdmissionPort } from "./notificationDeliveryAdmission.js";
import type {
  NotificationRecipientPolicyPort,
  RecipientPolicySkipReason,
  SkippedRecipient,
} from "./notificationRecipientPolicy.js";

type RecipientDecision = Awaited<ReturnType<NotificationRecipientPolicyPort["prepareDelivery"]>>;
type AdmissionReason = NonNullable<NotificationDeliveryAdmission["reason"]>;
type RecipientSkipReason =
  | "notification_recipient_unconfirmed"
  | "notification_recipient_revoked"
  | "notification_recipient_suppressed";

/** Why an email is left out of a notice that otherwise goes out, as the action's settled reason names it. */
export type EmailSkipReason = AdmissionReason | RecipientSkipReason | "notification_recipient_state_unavailable";

/**
 * Why one configured address is not emailed. A cap or an unreadable recipient state is not the
 * address's own doing, which is why an operator is only warned about the policy reasons.
 */
export type PlannedSkipReason = RecipientPolicySkipReason | "cap" | "state_unavailable";

export interface PlannedSkip {
  email: string;
  reason: PlannedSkipReason;
}

export type NotificationEmailPlan =
  | {
      /** The conversation has used its dispatch allowance: neither email nor webhook goes out. */
      dispatchAllowed: false;
      reason: AdmissionReason;
      /** Every configured address, none of which was emailed. */
      skipped: PlannedSkip[];
    }
  | {
      dispatchAllowed: true;
      recipients: RecipientDecision["eligibleRecipients"];
      /** Each configured address that is not emailed, with why. */
      skipped: PlannedSkip[];
      /**
       * Why at least one configured address receives no email, when policy rather than the transport
       * decided; null when every configured address is emailed or none is configured.
       */
      emailSkipReason: EmailSkipReason | null;
    };

const NO_ELIGIBLE_RECIPIENTS: RecipientDecision = {
  eligibleEmails: [],
  eligibleRecipients: [],
  skippedRecipients: [],
};

// An unconfirmed address is the one an operator can still act on, so it names the skip first.
const RECIPIENT_SKIP_PRIORITY: readonly RecipientPolicySkipReason[] = ["unconfirmed", "revoked", "suppressed"];

const POLICY_REASON_CODES: Record<RecipientPolicySkipReason, RecipientSkipReason> = {
  unconfirmed: "notification_recipient_unconfirmed",
  revoked: "notification_recipient_revoked",
  suppressed: "notification_recipient_suppressed",
};

const policySkipReason = (skipped: readonly PlannedSkip[]): EmailSkipReason | null => {
  const reason = RECIPIENT_SKIP_PRIORITY.find((candidate) => skipped.some((skip) => skip.reason === candidate));
  if (reason) return POLICY_REASON_CODES[reason];
  return skipped.some((skip) => skip.reason === "state_unavailable") ? "notification_recipient_state_unavailable" : null;
};

const uniqueNormalized = (emails: readonly string[]): string[] =>
  [...new Set(emails.map(normalizeRecipientEmail).filter(Boolean))];

/**
 * Decides who receives a contact or operator-notice email, in the order the anti-abuse rules need:
 * recipient confirmation first, then the conversation and daily caps over the addresses that remain.
 * A configured webhook still goes out when recipient state cannot be read, but email then fails
 * closed; with no webhook the failure propagates so the action retries. Every configured address
 * that is not emailed comes back in `skipped` with its reason, so the caller can record it.
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
  let stateUnavailable = false;
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
    stateUnavailable = true;
  }

  const policySkipped: PlannedSkip[] = stateUnavailable
    ? uniqueNormalized(request.emails).map((email) => ({ email, reason: "state_unavailable" }))
    : decision.skippedRecipients.map(({ email, reason }: SkippedRecipient) => ({ email, reason }));
  const cappedSkips = (): PlannedSkip[] => [
    ...decision.eligibleRecipients.map(({ email }) => ({ email, reason: "cap" as const })),
    ...policySkipped,
  ];

  // Admission is keyed on the configured list, which a retry sees unchanged even when an address
  // confirmed or lapsed in between; only the email count reserved follows confirmation.
  const admission = await input.admission?.admit({
    requestId: request.requestId,
    workspaceId: request.workspaceId,
    accountId: request.accountId,
    conversationId: request.conversationId,
    recipientEmails: request.emails,
    requestedEmailCount: decision.eligibleEmails.length,
  });
  if (admission && !admission.dispatchAllowed) {
    return { dispatchAllowed: false, reason: admission.reason ?? "conversation_dispatch_cap", skipped: cappedSkips() };
  }
  if (admission?.emailAllowed === false) {
    return {
      dispatchAllowed: true,
      recipients: [],
      skipped: cappedSkips(),
      emailSkipReason: admission.reason ?? "workspace_daily_email_cap",
    };
  }
  return {
    dispatchAllowed: true,
    recipients: decision.eligibleRecipients,
    skipped: policySkipped,
    emailSkipReason: policySkipReason(policySkipped),
  };
};
