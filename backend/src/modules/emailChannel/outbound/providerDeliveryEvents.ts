import type { AuditPort } from "../../audit/contracts/index.js";
import type { DeliveryStatusFacts } from "../../mail/public.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { recordEmailChannelAudit, type EmailChannelJobLogger } from "../emailChannelAudit.js";
import type { EmailSendIntentRecord, EmailSendIntentRepository } from "../persistence/emailSendIntentRepository.js";
import { outboundIndexEntries } from "./providerSendAttempt.js";
import type { SendIntentEvent } from "./sendIntentTransitions.js";
import type { SendIntentWriter } from "./sendIntentWriter.js";

/** `foreign`: the provider id names no send of this deployment, such as transactional mail. */
type ProviderDeliveryOutcome = "applied" | "ignored" | "foreign";

type ProviderStatusEvent = Extract<SendIntentEvent, { kind: "provider_status" }>;

/** Outcome of the Message-ID fallback itself, independent of whether the status it carried settled anything (#1619). */
type MessageIdFallbackOutcome = "settled" | "matched_ignored" | "foreign";

/**
 * `<uuid@domain>`, the shape every outbound Message-ID is minted in (`outboundMessageId`): a
 * cheap structural filter before the unindexed `supplied_rfc_message_id` lookup (#1619), so a
 * transactional email's own Message-ID, or any id with no chance of being ours, skips the query
 * rather than scanning for it.
 */
const RADIOSO_MESSAGE_ID = /^<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@[^<>]+>$/iu;

/**
 * The sanitized detail of a bounce or suppression (research A6, FR-045): the provider's type and
 * subtype and the RFC 3463 enhanced status code, which the provider adapter has already reduced
 * to tokens. The bounce message, which can quote the recipient, is never part of it.
 */
export const bounceDetailCode = (bounce: DeliveryStatusFacts["bounce"]): string | null => {
  if (bounce === null) return null;
  return [bounce.type, bounce.subType, bounce.statusCode].filter((part): part is string => part !== null).join(":");
};

/**
 * Applies provider evidence about sent mail to its send intent: a provider delivery event, keyed
 * by the provider's id for the email (research A6), and an inbound delivery status report naming
 * one of the mailbox's outbound Message-Ids (research A12). Both are the bounce sources FR-036
 * names. Events arrive out of order and more than once; the fenced state machine never regresses
 * a settled send, and late evidence settles an `uncertain` one without any resend (research B18).
 */
export class ProviderDeliveryEvents {
  constructor(private readonly deps: {
    intents: Pick<
      EmailSendIntentRepository,
      "findByProviderMessageId" | "findByOutboundRfcMessageIds" | "findBySuppliedRfcMessageId" | "recordComplaint"
    >;
    writer: Pick<SendIntentWriter, "apply">;
    audit: Pick<AuditPort, "record">;
    metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
    /** Audit failures at warn; an event it drops at info, with ids only. */
    logger: EmailChannelJobLogger;
  }) {}

  async applyStatus(input: {
    provider: string;
    providerMessageId: string;
    status: DeliveryStatusFacts;
    /** The RFC Message-ID the event carried, if any; the fallback when the provider id is foreign (#1619). */
    rfcMessageId?: string | null;
  }): Promise<ProviderDeliveryOutcome> {
    const resolved = await this.resolveIntent(input);
    if (!resolved) {
      this.count(input.status.type, "webhook", "foreign");
      return "foreign";
    }
    // A match reached only by Message-ID may still be `queued` or `uncertain` with no provider id
    // of its own recorded (the issue's own timing: a 5xx inside the 23h re-POST window, or past
    // it): recording the acceptance first is what lets the status evidence below settle it, the
    // same way it would have if the provider's own acceptance response had simply arrived.
    const intent = resolved.matchedBy === "message_id" ? await this.recordFallbackAcceptance(resolved.intent, input) : resolved.intent;
    const outcome = input.status.type === "complained"
      ? await this.recordComplaint(intent)
      : await this.applyEvidence(intent, {
          kind: "provider_status",
          status: input.status.type,
          source: "webhook",
          detailCode: bounceDetailCode(input.status.bounce),
        });
    this.count(input.status.type, "webhook", outcome);
    if (resolved.matchedBy === "message_id") this.observeFallback(outcome, intent);
    return outcome;
  }

  /**
   * The intent a delivery event names: by the provider's own id first (research A6), and only when
   * that is unknown, by the RFC Message-ID the event carried (#1619) — the id Radioso minted on its
   * own verified sending domain, so a match is still only ever this deployment's own send, never
   * another workspace's. An id that cannot possibly be ours never reaches the lookup at all, so
   * it is counted as not having tried the fallback, distinct from one that tried and missed.
   */
  private async resolveIntent(input: {
    provider: string;
    providerMessageId: string;
    rfcMessageId?: string | null;
  }): Promise<{ intent: EmailSendIntentRecord; matchedBy: "provider_id" | "message_id" } | null> {
    const byProviderId = await this.deps.intents.findByProviderMessageId(input.provider, input.providerMessageId);
    if (byProviderId) return { intent: byProviderId, matchedBy: "provider_id" };
    if (!input.rfcMessageId || !RADIOSO_MESSAGE_ID.test(input.rfcMessageId)) return null;
    const byMessageId = await this.deps.intents.findBySuppliedRfcMessageId(input.provider, input.rfcMessageId);
    if (!byMessageId) {
      this.countMessageIdFallback("foreign");
      return null;
    }
    return { intent: byMessageId, matchedBy: "message_id" };
  }

  /**
   * Records the provider's own id for a Message-ID match that has none yet, through the same
   * `provider_accepted` event and thread-index insert a normal acceptance applies (`queued` moves
   * to `accepted` with a lookup scheduled; `uncertain` keeps its state via `recordLateAcceptance`).
   * A match whose id is already known (including a later event naming a different one) is left as
   * it is: this is acceptance evidence, never a correction of a provider id already on record.
   */
  private async recordFallbackAcceptance(
    intent: EmailSendIntentRecord,
    input: { providerMessageId: string },
  ): Promise<EmailSendIntentRecord> {
    if (intent.providerMessageId !== null) return intent;
    const written = await this.deps.writer.apply(
      intent,
      { kind: "provider_accepted", providerMessageId: input.providerMessageId, deliveredMessageId: intent.suppliedRfcMessageId },
      {
        writer: "webhook",
        onApplied: async (scope, applied) => {
          await scope.threads.insertIndexEntries(outboundIndexEntries(applied, [applied.suppliedRfcMessageId]));
        },
      },
    );
    return written.outcome === "applied" ? written.intent : intent;
  }

  /** Bounces the sends behind the Radioso Message-Ids an inbound delivery status report names. */
  async applyDsnBounce(input: { mailboxId: string; rfcMessageIds: readonly string[] }): Promise<number> {
    const intents = await this.deps.intents.findByOutboundRfcMessageIds(input.mailboxId, input.rfcMessageIds);
    let applied = 0;
    for (const intent of intents) {
      // A report carries no provider classification of its own, only the ids it bounced.
      const outcome = await this.applyEvidence(intent, { kind: "provider_status", status: "bounced", source: "dsn", detailCode: null });
      this.count("bounced", "dsn", outcome);
      if (outcome === "applied") applied += 1;
    }
    return applied;
  }

  private async applyEvidence(intent: EmailSendIntentRecord, event: ProviderStatusEvent): Promise<"applied" | "ignored"> {
    const written = await this.deps.writer.apply(intent, event, { writer: "webhook" });
    if (written.outcome !== "applied") return "ignored";
    if (written.previousState === "uncertain") {
      await recordEmailChannelAudit(this.deps, {
        eventType: "hitl.delivery_failure",
        action: "provider_evidence",
        actor: null,
        workspaceId: written.intent.workspaceId,
        metadata: {
          sendIntentId: written.intent.id,
          conversationId: written.intent.conversationId,
          messageId: written.intent.messageId,
          source: event.source,
          to: written.intent.state,
        },
      });
    }
    return "applied";
  }

  /** A complaint changes no delivery state: it is recorded once, and audited (research A6). */
  private async recordComplaint(intent: EmailSendIntentRecord): Promise<"applied" | "ignored"> {
    if (!(await this.deps.intents.recordComplaint(intent.id))) {
      this.deps.logger.info(
        { sendIntentId: intent.id, workspaceId: intent.workspaceId, conversationId: intent.conversationId, event: "complained", reason: "already_recorded" },
        "email_send_event_ignored",
      );
      return "ignored";
    }
    await recordEmailChannelAudit(this.deps, {
      eventType: "email_channel.send",
      action: "complained",
      actor: null,
      workspaceId: intent.workspaceId,
      metadata: { sendIntentId: intent.id, conversationId: intent.conversationId, messageId: intent.messageId },
    });
    return "applied";
  }

  private count(status: string, source: "webhook" | "dsn", outcome: ProviderDeliveryOutcome): void {
    this.deps.metrics?.incrementCounter("email_send_provider_events_total", {
      help: "Provider delivery evidence for sent email by status, source and outcome.",
      labels: { status, source, outcome },
    });
  }

  /**
   * Observes a Message-ID match: `settled` only when its evidence actually applied (a status this
   * deployment's state machine accepted, from whichever state the fallback found the intent in);
   * `matched_ignored` when the fallback found the right intent but the evidence did not change it
   * (an out-of-order or non-settling status, or a terminal intent) — never counted or logged as
   * settled just because the lookup matched (#1619).
   */
  private observeFallback(outcome: "applied" | "ignored", intent: EmailSendIntentRecord): void {
    const fallbackOutcome: MessageIdFallbackOutcome = outcome === "applied" ? "settled" : "matched_ignored";
    this.countMessageIdFallback(fallbackOutcome);
    if (fallbackOutcome === "settled") {
      this.deps.logger.info(
        { sendIntentId: intent.id, workspaceId: intent.workspaceId, conversationId: intent.conversationId },
        "email_send_settled_by_message_id",
      );
    }
  }

  /** Counted only when the provider id was foreign and the Message-ID fallback was attempted (#1619). */
  private countMessageIdFallback(outcome: MessageIdFallbackOutcome): void {
    this.deps.metrics?.incrementCounter("email_send_message_id_fallback_total", {
      help: "Delivery events the RFC Message-ID fallback matched (settled or left unchanged) or still left foreign.",
      labels: { outcome },
    });
  }
}
