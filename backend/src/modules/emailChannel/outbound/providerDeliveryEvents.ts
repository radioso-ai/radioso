import type { AuditPort } from "../../audit/contracts/index.js";
import type { DeliveryStatusFacts } from "../../mail/public.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { recordEmailChannelAudit, type EmailChannelJobLogger } from "../emailChannelAudit.js";
import type { EmailSendIntentRecord, EmailSendIntentRepository } from "../persistence/emailSendIntentRepository.js";
import type { SendIntentEvent } from "./sendIntentTransitions.js";
import type { SendIntentWriter } from "./sendIntentWriter.js";

/** `foreign`: the provider id names no send of this deployment, such as transactional mail. */
type ProviderDeliveryOutcome = "applied" | "ignored" | "foreign";

type ProviderStatusEvent = Extract<SendIntentEvent, { kind: "provider_status" }>;

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
      | "findByProviderMessageId"
      | "findByOutboundRfcMessageIds"
      | "findBySuppliedRfcMessageId"
      | "recordProviderMessageId"
      | "recordComplaint"
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
    const outcome = !resolved
      ? "foreign"
      : input.status.type === "complained"
        ? await this.recordComplaint(resolved.intent)
        : await this.applyEvidence(resolved.intent, {
            kind: "provider_status",
            status: input.status.type,
            source: "webhook",
            detailCode: bounceDetailCode(input.status.bounce),
          });
    this.count(input.status.type, "webhook", outcome);
    if (resolved?.matchedBy === "message_id") await this.recordFallbackMatch(resolved.intent, input);
    return outcome;
  }

  /**
   * The intent a delivery event names: by the provider's own id first (research A6), and only when
   * that is unknown, by the RFC Message-ID the event carried (#1619) — the id Radioso minted on its
   * own verified sending domain, so a match is still only ever this deployment's own send, never
   * another workspace's. Resolving never writes: the evidence transition applies to the intent's
   * version exactly as read, and the fallback's own bookkeeping follows it.
   */
  private async resolveIntent(input: {
    provider: string;
    providerMessageId: string;
    rfcMessageId?: string | null;
  }): Promise<{ intent: EmailSendIntentRecord; matchedBy: "provider_id" | "message_id" } | null> {
    const byProviderId = await this.deps.intents.findByProviderMessageId(input.provider, input.providerMessageId);
    if (byProviderId) return { intent: byProviderId, matchedBy: "provider_id" };
    if (!input.rfcMessageId) return null;
    const byMessageId = await this.deps.intents.findBySuppliedRfcMessageId(input.provider, input.rfcMessageId);
    if (!byMessageId) {
      this.countMessageIdFallback("foreign");
      return null;
    }
    return { intent: byMessageId, matchedBy: "message_id" };
  }

  /**
   * Observes a Message-ID fallback match, after its evidence has already applied at the intent's
   * read version: counted and logged by ids only, and the provider's own id recorded on the intent
   * when this deployment never learned it, so a later event for the same send matches directly.
   */
  private async recordFallbackMatch(
    intent: EmailSendIntentRecord,
    input: { provider: string; providerMessageId: string },
  ): Promise<void> {
    this.countMessageIdFallback("settled");
    this.deps.logger.info(
      { sendIntentId: intent.id, workspaceId: intent.workspaceId, conversationId: intent.conversationId },
      "email_send_settled_by_message_id",
    );
    if (intent.providerMessageId === null) {
      await this.deps.intents.recordProviderMessageId(intent.id, { provider: input.provider, providerMessageId: input.providerMessageId });
    }
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

  /** Only counted when the provider id was foreign and the Message-ID fallback was attempted (#1619). */
  private countMessageIdFallback(outcome: "settled" | "foreign"): void {
    this.deps.metrics?.incrementCounter("email_send_message_id_fallback_total", {
      help: "Delivery events a foreign provider id left to the RFC Message-ID fallback, settled or still foreign.",
      labels: { outcome },
    });
  }
}
