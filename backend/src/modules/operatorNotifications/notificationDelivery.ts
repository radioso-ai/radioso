import { isUndispatchedMailResult, mailDeliverySkipReason } from "../../shared/domain/mailDeliveryOutcome.js";
import type { NotificationEmailPlan, PlannedSkip, PlannedSkipReason } from "./notificationEmailPlan.js";
import type { OperatorNotificationSinkOutcome } from "./operatorNotification.js";

/** What raised a notice: the contact routine's request, an approval, or a routine ending's hand-off or completion. */
export type NotificationKind = "contact_request" | "approval" | "handoff" | "completion";

/**
 * What happened to one address for one notice: a configured address, or an administrator the notice
 * went to in its place. `skipped_*` is a decision (an address that
 * is unconfirmed, stopped, or bounced; or a cap), `not_dispatched` is a transport that recorded the
 * mail without sending it, and `failed` is mail that was attempted and did not go out, or an address
 * whose state could not be read.
 */
export const RECIPIENT_DELIVERY_OUTCOMES = [
  "sent",
  "skipped_unconfirmed",
  "skipped_revoked",
  "skipped_suppressed",
  "skipped_cap",
  "not_dispatched",
  "failed",
] as const;

export type RecipientDeliveryOutcome = (typeof RECIPIENT_DELIVERY_OUTCOMES)[number];

export interface RecipientDelivery {
  /** The normalized address. */
  email: string;
  outcome: RecipientDeliveryOutcome;
  /**
   * Set on a workspace administrator who was sent the notice because recipient policy left out
   * every configured address. Absent on a configured address.
   */
  via?: "administrator_fallback";
}

/** One copy of a notice, as a sender's transport takes it. */
interface NotificationEmail {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
  listUnsubscribeUrl?: string;
}

interface NoticeCopy {
  email: NotificationEmail;
  via?: RecipientDelivery["via"];
}

/** The request one notice belongs to; a retry of the same request updates its rows instead of adding. */
export interface NotificationDeliverySubject {
  workspaceId: string;
  /** Null when the notice names no agent; the recorder falls back to the conversation's. */
  agentId: string | null;
  /** Null when the notice has no conversation, which leaves nothing to record against. */
  conversationId: string | null;
  requestId: string;
  kind: NotificationKind;
}

/**
 * Records what happened to each address of a notice. An implementation never rejects: recording is
 * bookkeeping about a delivery that already happened, and must not fail or retry it.
 */
export interface NotificationDeliveryRecorderPort {
  record(subject: NotificationDeliverySubject, deliveries: readonly RecipientDelivery[]): Promise<void>;
}

const SKIP_OUTCOMES: Record<PlannedSkipReason, RecipientDeliveryOutcome> = {
  unconfirmed: "skipped_unconfirmed",
  revoked: "skipped_revoked",
  suppressed: "skipped_suppressed",
  cap: "skipped_cap",
  state_unavailable: "failed",
};

const skippedDeliveries = (skipped: readonly PlannedSkip[]): RecipientDelivery[] =>
  skipped.map(({ email, reason }) => ({ email, outcome: SKIP_OUTCOMES[reason] }));

const emailOutcome = (result: PromiseSettledResult<unknown>): RecipientDeliveryOutcome => {
  if (result.status === "rejected") return "failed";
  return isUndispatchedMailResult(result.value) ? "not_dispatched" : "sent";
};

/** Starts an attempt so a throw before its first await rejects like any other failure. */
const attempt = async <T>(run: () => Promise<T>): Promise<T> => run();

/**
 * The copies a planned notice sends. An administrator's copy opens with why it came to them, and is
 * keyed apart from any configured address's copy, so the two never collide at the provider.
 */
const noticeCopies = (
  plan: Extract<NotificationEmailPlan, { dispatchAllowed: true }>,
  message: { subject: string; text: string; idempotencyKey: string },
): NoticeCopy[] => {
  const configured = plan.recipients.map(({ email, listUnsubscribeUrl }): NoticeCopy => ({
    email: {
      to: email,
      subject: message.subject,
      text: message.text,
      ...(listUnsubscribeUrl ? { listUnsubscribeUrl } : {}),
      idempotencyKey: `${message.idempotencyKey}:email:${encodeURIComponent(email)}`,
    },
  }));
  const fallback = plan.administratorFallback;
  if (!fallback) return configured;
  return [
    ...configured,
    ...fallback.recipients.map(({ email, listUnsubscribeUrl }): NoticeCopy => ({
      via: "administrator_fallback",
      email: {
        to: email,
        subject: message.subject,
        text: `${fallback.note}\n\n${message.text}`,
        ...(listUnsubscribeUrl ? { listUnsubscribeUrl } : {}),
        idempotencyKey: `${message.idempotencyKey}:administrator-fallback:${encodeURIComponent(email)}`,
      },
    })),
  ];
};

/**
 * Sends a planned notice's emails and its webhook together, records what happened to each address,
 * and says how the notice went. The two senders (`contact.send` and the operator-notice sink) share
 * this so what counts as delivered, partial or skipped is decided once, and so is what each copy
 * says and the key it is sent under.
 *
 * Every attempt settles before anything is thrown, so the record is complete when a send fails; the
 * first failure is then rethrown unchanged for the action to retry. A retry sends to the same
 * addresses under the same idempotency keys and updates the same rows. A notice that reached only
 * administrators settles partial with the policy reason: its configured address still missed it.
 */
export const deliverNotification = async (input: {
  plan: NotificationEmailPlan;
  subject: NotificationDeliverySubject;
  recorder: NotificationDeliveryRecorderPort | undefined;
  /** What every copy says, and the key each copy's idempotency key is built from. */
  message: { subject: string; text: string; idempotencyKey: string };
  /** Sends one copy through the sender's transport, which adds what it owns (mail kind, reply-to). */
  sendEmail: (email: NotificationEmail) => Promise<unknown>;
  /** The webhook post, when the destination configures one. */
  postWebhook: (() => Promise<void>) | null;
  logger?: { warn(payload: Record<string, unknown>, message: string): void };
}): Promise<Exclude<OperatorNotificationSinkOutcome, { disposition: "not_applicable" }>> => {
  const { plan } = input;
  const record = async (deliveries: readonly RecipientDelivery[]): Promise<void> => {
    if (!input.recorder || deliveries.length === 0) return;
    try {
      await input.recorder.record(input.subject, deliveries);
    } catch (error) {
      input.logger?.warn(
        { event: "notification_delivery_record_failed", errorName: error instanceof Error ? error.name : "unknown" },
        "Notification delivery could not be recorded",
      );
    }
  };

  if (!plan.dispatchAllowed) {
    await record(skippedDeliveries(plan.skipped));
    return { disposition: "skipped", reason: plan.reason };
  }

  const copies = noticeCopies(plan, input.message);
  const emailCount = copies.length;
  const settled = await Promise.allSettled([
    ...copies.map((copy) => attempt(() => input.sendEmail(copy.email))),
    ...(input.postWebhook ? [attempt(input.postWebhook)] : []),
  ]);
  const emailResults = settled.slice(0, emailCount);
  await record([
    ...skippedDeliveries(plan.skipped),
    ...copies.map((copy, index) => ({
      email: copy.email.to,
      outcome: emailOutcome(emailResults[index]),
      ...(copy.via ? { via: copy.via } : {}),
    })),
  ]);

  const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;

  const fulfilled = emailResults.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const undispatched = fulfilled.filter(isUndispatchedMailResult);
  const emailGap = plan.emailSkipReason ?? mailDeliverySkipReason(undispatched);
  if (!input.postWebhook && undispatched.length === emailCount) {
    return { disposition: "skipped", reason: emailGap ?? "contact_destination_not_configured" };
  }
  return emailGap ? { disposition: "partial", reason: emailGap } : { disposition: "delivered" };
};
