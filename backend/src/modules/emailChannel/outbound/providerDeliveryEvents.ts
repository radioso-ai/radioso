import type { AuditPort } from "../../audit/contracts/index.js";
import type { DeliveryStatusFacts } from "../../mail/public.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { recordEmailChannelAudit, type EmailChannelJobLogger } from "../emailChannelAudit.js";
import type { EmailSendIntentRecord, EmailSendIntentRepository } from "../persistence/emailSendIntentRepository.js";
import { sendIntentIdOfOutboundMessageId } from "./outboundHeaders.js";
import { recordProviderAcceptance } from "./providerAcceptance.js";
import type { SendIntentEvent } from "./sendIntentTransitions.js";
import type { SendIntentWriter } from "./sendIntentWriter.js";

/** `foreign`: the provider id names no send of this deployment, such as transactional mail. */
type ProviderDeliveryOutcome = "applied" | "ignored" | "foreign";

type ProviderStatusEvent = Extract<SendIntentEvent, { kind: "provider_status" }>;

/**
 * What the Message-ID fallback did (#1619): settled the send, recorded only the acceptance the
 * event revealed, matched a send it had nothing to change on, or named no send it may settle.
 */
type MessageIdFallbackOutcome = "settled" | "accepted" | "matched_ignored" | "foreign";

/**
 * Why the matched send had no provider id of its own: a provider call came back with an unknown
 * outcome (the 5xx recovery the fallback exists for), or the call was still in flight when the
 * provider's event raced its response. `none` when no send matched.
 */
type MessageIdFallbackPhase = "outcome_unknown" | "in_flight" | "none";

const phaseOf = (intent: Pick<EmailSendIntentRecord, "outcomeUnknown">): MessageIdFallbackPhase =>
  intent.outcomeUnknown ? "outcome_unknown" : "in_flight";

/** Whether the intent records a provider message other than the one an event names: that message is not this send. */
const recordsAnotherMessage = (intent: Pick<EmailSendIntentRecord, "providerMessageId">, providerMessageId: string): boolean =>
  intent.providerMessageId !== null && intent.providerMessageId !== providerMessageId;

/** Both halves of a Message-ID Radioso mints are case-insensitive (a hex UUID, a lowercased domain). */
const sameMessageId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const idsOf = (intent: EmailSendIntentRecord) => ({
  sendIntentId: intent.id,
  workspaceId: intent.workspaceId,
  conversationId: intent.conversationId,
});

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
    intents: Pick<EmailSendIntentRepository, "findByProviderMessageId" | "findById" | "findByOutboundRfcMessageIds" | "recordComplaint">;
    writer: Pick<SendIntentWriter, "apply">;
    audit: Pick<AuditPort, "record">;
    metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
    /** Audit failures at warn; an event it drops, and a send the Message-ID fallback accepted or settled, at info, with ids only. */
    logger: EmailChannelJobLogger;
  }) {}

  async applyStatus(input: {
    provider: string;
    providerMessageId: string;
    status: DeliveryStatusFacts;
    /** The RFC Message-ID the event carried, if any; the fallback when the provider id is foreign (#1619). */
    rfcMessageId?: string | null;
  }): Promise<ProviderDeliveryOutcome> {
    const byProviderId = await this.deps.intents.findByProviderMessageId(input.provider, input.providerMessageId);
    if (byProviderId) return this.applyTo(byProviderId, input.status);
    const bySentMessageId = await this.findBySentMessageId(input.provider, input.rfcMessageId ?? null);
    return bySentMessageId ? this.applyByMessageId(bySentMessageId, input) : this.foreign(input.status);
  }

  /**
   * The send a delivery event names only by the RFC Message-ID it carried (#1619): the intent
   * whose primary key is that Message-ID's UUID, sent through the same provider under exactly that
   * Message-ID. Radioso mints both the supplied id and the one the frozen request sends with
   * `outboundMessageId`, from the intent's id and its mailbox's sending domain, which is set once
   * when the mailbox is created, so the two are one string and a match is this deployment's own
   * send. Null and uncounted for an id of any other shape; null and counted for one naming no send.
   */
  private async findBySentMessageId(provider: string, rfcMessageId: string | null): Promise<EmailSendIntentRecord | null> {
    if (rfcMessageId === null) return null;
    const intentId = sendIntentIdOfOutboundMessageId(rfcMessageId);
    if (intentId === null) return null;
    const intent = await this.deps.intents.findById(intentId);
    if (intent?.provider === provider && sameMessageId(intent.suppliedRfcMessageId, rfcMessageId)) return intent;
    this.countFallback("foreign", "none");
    return null;
  }

  /**
   * A send matched only by its Message-ID may have no provider id of its own yet: a 5xx whose
   * outcome stayed unknown (inside the 23h re-POST window or past it), or a provider response still
   * in flight. The event's provider id is recorded first, as the acceptance that response would
   * have recorded, which is what lets the event's status settle the send. A send that records a
   * different provider message is that message's, so the event is foreign to it.
   */
  private async applyByMessageId(
    matched: EmailSendIntentRecord,
    input: { providerMessageId: string; status: DeliveryStatusFacts },
  ): Promise<ProviderDeliveryOutcome> {
    const phase = phaseOf(matched);
    const accepted = await this.acceptByMessageId(matched, input.providerMessageId, phase);
    if (recordsAnotherMessage(accepted.intent, input.providerMessageId)) {
      this.countFallback("foreign", phase);
      return this.foreign(input.status);
    }
    const outcome = await this.applyTo(accepted.intent, input.status);
    // A complaint records once, but settles no delivery state; it never counts as `settled` here.
    const settled = outcome === "applied" && input.status.type !== "complained";
    this.countFallback(settled ? "settled" : accepted.recorded ? "accepted" : "matched_ignored", phase);
    if (settled) this.deps.logger.info({ ...idsOf(accepted.intent), phase }, "email_send_settled_by_message_id");
    return outcome;
  }

  /**
   * Records the event's provider id on a matched send that has none, through the same acceptance
   * and thread index rows a provider response records (`recordProviderAcceptance`; an `uncertain`
   * send keeps its state), and returns the row as it now is. The event carried the send's own
   * Message-ID, which is the id the provider delivered under. A provider id already on record is
   * never replaced.
   */
  private async acceptByMessageId(
    intent: EmailSendIntentRecord,
    providerMessageId: string,
    phase: MessageIdFallbackPhase,
  ): Promise<{ intent: EmailSendIntentRecord; recorded: boolean }> {
    if (intent.providerMessageId !== null) return { intent, recorded: false };
    const written = await recordProviderAcceptance(
      this.deps,
      intent,
      { providerMessageId, deliveredMessageId: intent.suppliedRfcMessageId },
      { writer: "webhook" },
    );
    if (written.outcome === "not_found") return { intent, recorded: false };
    const recorded = written.outcome === "applied";
    if (recorded) this.deps.logger.info({ ...idsOf(written.intent), phase }, "email_send_accepted_by_message_id");
    return { intent: written.intent, recorded };
  }

  /** A provider status on the send it names: a complaint is recorded once, any other status is evidence. */
  private async applyTo(intent: EmailSendIntentRecord, status: DeliveryStatusFacts): Promise<"applied" | "ignored"> {
    const outcome = status.type === "complained"
      ? await this.recordComplaint(intent)
      : await this.applyEvidence(intent, {
          kind: "provider_status",
          status: status.type,
          source: "webhook",
          detailCode: bounceDetailCode(status.bounce),
        });
    this.count(status.type, "webhook", outcome);
    return outcome;
  }

  private foreign(status: DeliveryStatusFacts): "foreign" {
    this.count(status.type, "webhook", "foreign");
    return "foreign";
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

  /** Counted only once the provider id named no send and the event's Message-ID had Radioso's shape (#1619). */
  private countFallback(outcome: MessageIdFallbackOutcome, phase: MessageIdFallbackPhase): void {
    this.deps.metrics?.incrementCounter("email_send_message_id_fallback_total", {
      help: "Delivery events matched by the RFC Message-ID they carried, by what that changed and the matched send's phase.",
      labels: { outcome, phase },
    });
  }
}
