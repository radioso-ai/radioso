import { EmailSendError, type EmailDriver, type EmailMessage, type RfcMessageId } from "../../mail/public.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { traceOperation } from "../../../shared/observability/tracing/operations.js";
import { requestDrainBestEffort, type EmailChannelDrainDispatcherPort } from "../drains.js";
import type { EmailChannelLogger } from "../emailChannelAudit.js";
import type { EmailSendIntentRecord, SendRequestSnapshot } from "../persistence/emailSendIntentRepository.js";
import type { EmailSendUnitOfWork, SendIntentWriter, SendIntentWriterName } from "./sendIntentWriter.js";

/**
 * How long after the first attempt a re-POST may still reuse the idempotency key: the provider
 * honours a key for 24 hours (research A5), and the last hour is left as margin.
 */
const REPOST_WINDOW_MS = 23 * 60 * 60 * 1000;
/** Due intents one scheduled reconcile drain asks the worker to claim. */
const RECONCILE_DRAIN_BATCH = 5;

type ProviderCallResult =
  | { result: "accepted"; providerMessageId: string; deliveredMessageId: RfcMessageId | null }
  | { result: "rejected" | "retryable" | "unknown"; code: string };

/**
 * The provider turned the request away without accepting it, for a reason that passes: re-send it
 * unchanged under the same key later. The send's state is unchanged.
 */
export class EmailSendRetryableError extends Error {
  constructor(readonly code: string) {
    super(`email_send_retryable:${code}`);
    this.name = "EmailSendRetryableError";
  }
}

const correlation = (intent: EmailSendIntentRecord) => ({
  "radioso.workspace_id": intent.workspaceId,
  "radioso.conversation_id": intent.conversationId,
  "radioso.email.send_intent_id": intent.id,
});

const messageOf = (intent: EmailSendIntentRecord, request: SendRequestSnapshot & { body: NonNullable<SendRequestSnapshot["body"]> }): EmailMessage => ({
  to: request.to,
  from: { email: request.from.email, name: request.from.name },
  replyTo: request.replyTo,
  subject: request.subject,
  text: request.body.text,
  ...(request.body.html === null ? {} : { html: request.body.html }),
  kind: "channel_reply",
  idempotencyKey: intent.idempotencyKey,
  threading: request.threading,
});

/** The thread index rows an accepted send is found by: the supplied id, and the delivered one when it differs. */
const outboundIndexEntries = (intent: EmailSendIntentRecord, rfcMessageIds: readonly string[]) =>
  [...new Set(rfcMessageIds)].map((rfcMessageId) => ({
    workspaceId: intent.workspaceId,
    mailboxId: intent.mailboxId,
    conversationId: intent.conversationId,
    messageId: intent.messageId,
    direction: "outbound" as const,
    origin: rfcMessageId === intent.suppliedRfcMessageId ? "radioso_generated" as const : "provider_delivered" as const,
    rfcMessageId,
    subject: intent.request?.subject ?? null,
    ccAddresses: [],
    attachments: [],
    inboundDeliveryId: null,
    sendIntentId: intent.id,
  }));

/**
 * One provider call for a send whose request is frozen, and its outcome applied through the fence
 * (research B6 steps 4 to 6). No transaction is open across the call: the outcome is written in
 * its own unit of work once the provider has answered. Shared by the action handler's attempt and
 * the reconciler's re-POST, which send the same request under the same key.
 */
export class ProviderSendAttempt {
  constructor(private readonly deps: {
    driver: Pick<EmailDriver, "send" | "lookup">;
    writer: Pick<SendIntentWriter, "apply">;
    unitOfWork: EmailSendUnitOfWork;
    drains: EmailChannelDrainDispatcherPort;
    metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
    logger: EmailChannelLogger;
    clock: () => Date;
  }) {}

  /** Whether a re-POST may still reuse the key, measured from the first attempt. */
  withinRepostWindow(intent: Pick<EmailSendIntentRecord, "firstAttemptAt">): boolean {
    return intent.firstAttemptAt !== null && this.deps.clock().getTime() - intent.firstAttemptAt.getTime() < REPOST_WINDOW_MS;
  }

  /**
   * Sends the intent's frozen request with its key. The caller has checked the send's authority.
   * Throws `EmailSendRetryableError` when the provider asks to be asked again.
   */
  async send(intent: EmailSendIntentRecord, options: { writer: SendIntentWriterName; attempt: number | null }): Promise<EmailSendIntentRecord> {
    const request = intent.request;
    if (request === null || request.body === null) {
      throw new Error("email_send_request_not_frozen");
    }
    const message = messageOf(intent, { ...request, body: request.body });
    const outcome = await traceOperation({
      name: "email.send.provider",
      attributes: { ...correlation(intent), provider: intent.provider, attempt: options.attempt ?? "reconcile" },
      run: () => this.call(message),
      resultAttributes: (called) => ({ result: called.result }),
    });
    this.deps.metrics?.incrementCounter("email_send_provider_calls_total", {
      help: "Email channel provider send calls by result.",
      labels: { result: outcome.result },
    });
    switch (outcome.result) {
      case "accepted":
        return this.recordAcceptance(intent, outcome, options.writer);
      case "rejected":
        return this.recordRejection(intent, outcome.code, options.writer);
      case "retryable":
        throw new EmailSendRetryableError(outcome.code);
      case "unknown":
        return this.recordUnknownOutcome(intent, outcome.code, options.writer);
    }
  }

  /**
   * Fetches the Message-ID the provider delivered under (research A7), best effort: a provider
   * that has not handed the message on yet reports none, and the reconciler's lookup asks again.
   */
  async fetchDeliveredMessageId(intent: EmailSendIntentRecord): Promise<void> {
    if (intent.providerMessageId === null || intent.deliveredRfcMessageId !== null) return;
    try {
      const status = await this.deps.driver.lookup(intent.providerMessageId);
      if (status?.deliveredMessageId) await this.recordDeliveredMessageId(intent, status.deliveredMessageId);
    } catch (error) {
      this.deps.logger.warn(
        { sendIntentId: intent.id, conversationId: intent.conversationId, errorName: error instanceof Error ? error.name : "unknown" },
        "email_send_delivered_id_lookup_failed",
      );
    }
  }

  /** Records the delivered Message-ID once, with its thread index row when it differs from the supplied one. */
  async recordDeliveredMessageId(intent: EmailSendIntentRecord, deliveredRfcMessageId: RfcMessageId): Promise<void> {
    const providerMessageId = intent.providerMessageId;
    if (providerMessageId === null || intent.deliveredRfcMessageId !== null) return;
    await this.deps.unitOfWork.run(async (scope) => {
      const recorded = await scope.intents.recordDeliveredMessageId(intent.id, { providerMessageId, deliveredRfcMessageId });
      if (recorded && deliveredRfcMessageId !== intent.suppliedRfcMessageId) {
        await scope.threads.insertIndexEntries(outboundIndexEntries(intent, [deliveredRfcMessageId]));
      }
    });
  }

  private async call(message: EmailMessage): Promise<ProviderCallResult> {
    try {
      const sent = await this.deps.driver.send(message);
      if (sent.dispatched && sent.providerMessageId) {
        return { result: "accepted", providerMessageId: sent.providerMessageId, deliveredMessageId: sent.deliveredMessageId };
      }
      // Accepted, but under an id the response did not carry: only a re-POST with the key reads it.
      if (sent.dispatched) return { result: "unknown", code: "provider_id_unreadable" };
      // A driver that only records mail sends nothing, so nothing reached the customer.
      return { result: "rejected", code: "not_dispatched" };
    } catch (error) {
      if (error instanceof EmailSendError) return { result: error.outcome, code: error.code };
      // A driver failing outside its contract may have sent; only the key can settle it.
      return { result: "unknown", code: "driver_error" };
    }
  }

  private async recordAcceptance(
    intent: EmailSendIntentRecord,
    accepted: Extract<ProviderCallResult, { result: "accepted" }>,
    writer: SendIntentWriterName,
  ): Promise<EmailSendIntentRecord> {
    const written = await this.deps.writer.apply(
      intent,
      { kind: "provider_accepted", providerMessageId: accepted.providerMessageId, deliveredMessageId: accepted.deliveredMessageId },
      {
        writer,
        onApplied: async (scope, applied) => {
          const ids = [applied.suppliedRfcMessageId, ...(applied.deliveredRfcMessageId ? [applied.deliveredRfcMessageId] : [])];
          await scope.threads.insertIndexEntries(outboundIndexEntries(applied, ids));
        },
      },
    );
    if (written.outcome === "not_found") return intent;
    await this.fetchDeliveredMessageId(written.intent);
    return written.intent;
  }

  private async recordRejection(intent: EmailSendIntentRecord, code: string, writer: SendIntentWriterName): Promise<EmailSendIntentRecord> {
    if (code === "idempotency_body_mismatch") {
      // The same key carried a different body: a defect, since the request is frozen (research A5).
      this.deps.logger.warn({ sendIntentId: intent.id, conversationId: intent.conversationId }, "email_send_idempotency_body_mismatch");
    }
    const written = await this.deps.writer.apply(intent, { kind: "provider_rejected", code }, { writer });
    return written.outcome === "not_found" ? intent : written.intent;
  }

  /**
   * The provider may have accepted the send. While the key is in its window the send stays queued
   * and a reconcile drain is scheduled for the re-POST; after it, the doubt goes to an operator.
   */
  private async recordUnknownOutcome(intent: EmailSendIntentRecord, code: string, writer: SendIntentWriterName): Promise<EmailSendIntentRecord> {
    this.deps.logger.warn({ sendIntentId: intent.id, conversationId: intent.conversationId, code }, "email_send_outcome_unknown");
    const written = await this.deps.writer.apply(
      intent,
      { kind: "outcome_unknown", authorityValid: true, withinWindow: this.withinRepostWindow(intent) },
      { writer },
    );
    if (written.outcome === "not_found") return intent;
    const { nextReconcileAt } = written.intent;
    if (written.outcome === "applied" && written.intent.state === "queued" && nextReconcileAt !== null) {
      await requestDrainBestEffort(this.deps, { maxJobs: RECONCILE_DRAIN_BATCH, stage: "reconcile", scheduleAt: nextReconcileAt });
    }
    return written.intent;
  }
}
