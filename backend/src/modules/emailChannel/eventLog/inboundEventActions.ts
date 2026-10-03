import { AppError } from "../../../shared/domain/errors.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { buildRawMessageView, type RawMessageView } from "../content/rawMessageView.js";
import { requestDrainBestEffort, type EmailChannelDrainDispatcherPort } from "../drains.js";
import {
  recordEmailChannelAudit,
  recordRawMessageAccess,
  type EmailChannelActor,
  type EmailChannelAuditDependencies,
} from "../emailChannelAudit.js";
import type { EmailInboundRepository, InboundDeliveryRecord } from "../persistence/emailInboundRepository.js";
import type { EmailMailboxRepository } from "../persistence/emailMailboxRepository.js";
import { eventNotFound, type EmailEventView, type EventLogReader } from "./eventLogReader.js";

const DRAIN_BATCH = 5;

type ResumeState = Parameters<EmailInboundRepository["reopenFailedDelivery"]>[0]["resumeState"];

/**
 * Where a failed delivery's protocol resumes: after the last step whose result it kept. A reserved
 * delivery keeps its planned ids, so ingest stays idempotent across the retry (research B15).
 */
const resumeStateOf = (delivery: Pick<InboundDeliveryRecord, "conversationId" | "plannedConversationId" | "classification">): ResumeState => {
  if (delivery.conversationId !== null) return "ingested";
  if (delivery.plannedConversationId !== null) return "resolved";
  return delivery.classification !== null ? "fetched" : "pending";
};

interface InboundEventActionsDependencies extends EmailChannelAuditDependencies {
  deliveries: Pick<EmailInboundRepository, "findDelivery" | "reopenFailedDelivery" | "readRawMessage">;
  mailboxes: Pick<EmailMailboxRepository, "findActive" | "listActive">;
  events: Pick<EventLogReader, "get">;
  drains: EmailChannelDrainDispatcherPort;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  /** The deployment's relay domain: every address on it carries a relay token. */
  inboundDomain: string;
}

/** What an operator does with one event log entry: retry a failed one, and read its raw message. */
export class InboundEventActions {
  constructor(private readonly deps: InboundEventActionsDependencies) {}

  /** Returns a failed delivery to the inbound protocol, resuming where it stopped (FR-008). */
  async retry(actor: EmailChannelActor, workspaceId: string, deliveryId: string): Promise<EmailEventView> {
    const delivery = await this.findMailboxDelivery(workspaceId, deliveryId);
    const outcome = await this.deps.deliveries.reopenFailedDelivery({ workspaceId, deliveryId, resumeState: resumeStateOf(delivery) });
    if (outcome === "not_found") throw eventNotFound();
    if (outcome === "not_failed") throw new AppError(409, "event_not_failed", "Only a failed event can be retried.");
    if (outcome === "in_flight") throw new AppError(409, "event_not_failed", "This event is being processed. Try again shortly.");

    await recordEmailChannelAudit(this.deps, {
      eventType: "email_channel.event",
      action: "retried",
      actor,
      workspaceId,
      metadata: { deliveryId },
    });
    await requestDrainBestEffort(this.deps, { maxJobs: DRAIN_BATCH, stage: "inbound" });
    return this.deps.events.get(workspaceId, deliveryId);
  }

  /**
   * The sanitized raw message (research A11, B10). Relay and thread tokens are redacted from the
   * headers, and the access is audited before anything is returned (FR-046).
   */
  async openRawMessage(actor: EmailChannelActor, workspaceId: string, deliveryId: string): Promise<RawMessageView> {
    const stored = await this.deps.deliveries.readRawMessage(workspaceId, deliveryId);
    if (!stored || stored.mailboxId === null) throw eventNotFound();
    if (!stored.raw) throw new AppError(410, "raw_purged", "The raw message is no longer stored.");

    const mailboxes = await this.deps.mailboxes.listActive(workspaceId);
    const view = await buildRawMessageView(
      { raw: stored.raw, truncated: stored.truncated },
      { relayDomains: [this.deps.inboundDomain], mailboxAddresses: mailboxes.map((mailbox) => mailbox.address) },
    );
    await recordRawMessageAccess(this.deps, { actor, workspaceId, deliveryId, conversationId: stored.conversationId });
    return view;
  }

  /** A delivery of one of the workspace's active mailboxes; only those are in an event log. */
  private async findMailboxDelivery(workspaceId: string, deliveryId: string): Promise<InboundDeliveryRecord> {
    const delivery = await this.deps.deliveries.findDelivery(workspaceId, deliveryId);
    if (!delivery?.mailboxId || !(await this.deps.mailboxes.findActive(workspaceId, delivery.mailboxId))) throw eventNotFound();
    return delivery;
  }
}
