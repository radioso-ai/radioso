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
    intents: Pick<EmailSendIntentRepository, "findByProviderMessageId" | "findByOutboundRfcMessageIds" | "recordComplaint">;
    writer: Pick<SendIntentWriter, "apply">;
    audit: Pick<AuditPort, "record">;
    metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
    /** Audit failures at warn; an event it drops at info, with ids only. */
    logger: EmailChannelJobLogger;
  }) {}

  async applyStatus(input: { provider: string; providerMessageId: string; status: DeliveryStatusFacts }): Promise<ProviderDeliveryOutcome> {
    const intent = await this.deps.intents.findByProviderMessageId(input.provider, input.providerMessageId);
    const outcome = !intent
      ? "foreign"
      : input.status.type === "complained"
        ? await this.recordComplaint(intent)
        : await this.applyEvidence(intent, {
            kind: "provider_status",
            status: input.status.type,
            source: "webhook",
            detailCode: bounceDetailCode(input.status.bounce),
          });
    this.count(input.status.type, "webhook", outcome);
    return outcome;
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
}
