import type { ConnectorChatPort } from "@radioso/connector-api";
import { z } from "zod";

import type { ConversationActivityWriter } from "../../../conversationActivity/contracts/index.js";
import {
  capToSupportedMode,
  effectiveEngagementMode,
  extractCustomerText,
  generateOpaqueToken,
  isGenerationBudgetExhausted,
  parsePlusToken,
  requestDrainBestEffort,
  type EmailChannelDrainDispatcherPort,
  type EmailDomainRepository,
  type EmailInboundRepository,
  type EmailMailboxRepository,
  type EmailThreadRepository,
  type EngagementMode,
  type InboundDeliveryRecord,
  type InboundEventRecord,
  type MailboxService,
  type ProviderDeliveryEvents,
} from "../../../emailChannel/public.js";
import {
  InboundFetchError,
  type DeliveryStatusFacts,
  type InboundEmailMessage,
  type InboundEmailReceiver,
  type InboundEnvelope,
} from "../../../mail/public.js";
import type { MetricsRegistry } from "../../../../shared/observability/metrics/metricsRegistry.js";
import { traceOperation } from "../../../../shared/observability/tracing/operations.js";
import { resolveEngagementDisposition, type EngagementDisposition, type IngestOnlyReason } from "./emailEngagementDisposition.js";
import { classifyInbound } from "./emailInboundClassification.js";
import { routeDeliveredTo, type InboundRouteLookups, type MailboxTarget } from "./emailInboundRouting.js";
import { resolveThread, type ThreadCandidates, type ThreadResolution } from "./emailThreadResolution.js";

/**
 * Stage 1 of the inbound job (research B7): one claimed provider event is fetched, routed to its
 * mailboxes, and each delivery is carried through the durable thread protocol of research B15:
 *
 * 1. record the normalized content and its classification (`fetched`);
 * 2. resolve the thread and decide the disposition under the thread lock, then either drop it or
 *    reserve the conversation and message ids (`resolved`);
 * 3. ingest through the host port with those ids, idempotently (`ingested`);
 * 4. index the thread and its Message-Ids (`done`).
 *
 * Every step resumes from the state the last attempt persisted, so a crash anywhere repeats no
 * write and splits no thread. A retry resumes each delivery from the mailbox it was bound to before
 * it routes again, so a rotated relay token or a changed route never strands one. Each step's write
 * is fenced by the event's claim: a worker whose lease was reclaimed loses its next write and stops,
 * leaving the delivery to the claim that holds the event. The host's ingest supersedes the thread's
 * pending draft, which a newer message makes stale; step 3 schedules the thread's coalesced review
 * for a `run_review_turn` disposition (stage 2, `EmailReviewRunner`).
 */

/** Waits before attempts 2 to 5 of an event (FR-008's bounded retry); a fifth failure is terminal. */
const RETRY_DELAYS_SECONDS: readonly number[] = [30, 120, 600, 1_800];
/** Events one pushed drain asks the worker to claim. */
const DRAIN_BATCH = 5;
const SOURCE_CHANNEL = "email";
const PROCESSING_FAILED = "processing_failed";
/** A delivery whose mailbox was removed before it could finish: it fails visibly, with this code. */
const MAILBOX_REMOVED = "mailbox_removed";
const RECEIPT_TO_INBOX_BUCKETS = [1, 2, 5, 10, 30, 60, 120, 300, 900];

/** Mail on one thread inside this many seconds gets one review (FR-024). */
export const EMAIL_COALESCE_SECONDS = 60;
/** Raw MIME bytes stored per delivery; a larger message is stored truncated. */
export const EMAIL_RAW_MAX_BYTES = 2 * 1024 * 1024;

type ConversationOwnership = "ai_owned" | "human_owned";
type FetchedDeliveryContent = Parameters<EmailInboundRepository["recordFetched"]>[1];
type CustomerText = ReturnType<typeof extractCustomerText>;
type DeliveryClaim = Parameters<EmailInboundRepository["markIndexed"]>[0];

/**
 * The human ownership each ingest-only reason asks for, read from the persisted reason so a
 * resumed delivery hands off exactly as its first attempt decided. A delivery accepted for review
 * asks for none: its review decides.
 */
const HUMAN_OWNERSHIP_BY_REASON: ReadonlyMap<string, string> = new Map<IngestOnlyReason, string>([
  ["operator_only_mailbox", "operator_only_mailbox"],
  ["no_agent", "operator_only_mailbox"],
  ["generation_budget", "generation_budget"],
]);

export type InboundEventOutcome = "processed" | "ignored" | "retrying" | "failed" | "superseded";

/** What a conversation reached by a thread is called by, in its channel context and its link. */
interface ThreadIdentity {
  threadKey: string;
  /** Secret plus token. Never logged, never in the channel context. */
  threadToken: string;
  participantAddress: string;
}

/**
 * The keystone reads and writes of one protocol step, bound to one transaction by composition: a
 * delivery's resolution or indexing here (research B15), and a review revision's set-aside in
 * `EmailReviewRunner` (research B17).
 */
export interface EmailThreadProtocolScope {
  /** Serializes resolution for one participant of one mailbox until the transaction ends. */
  lockThread(input: { mailboxId: string; participantAddress: string }): Promise<void>;
  inbound: Pick<
    EmailInboundRepository,
    | "findForwardReservations"
    | "findReverseReferences"
    | "findReservedThreads"
    | "reserveThread"
    | "settleDropped"
    | "markIndexed"
    | "findDeliveryIdForMessage"
  >;
  threads: Pick<
    EmailThreadRepository,
    | "findIndexedConversations"
    | "findLinkByThreadToken"
    | "findLink"
    | "upsertLink"
    | "recordLatestInbound"
    | "insertIndexEntries"
    | "scheduleReview"
    | "completeReview"
  >;
  /** Null while the conversation is only reserved, not yet ingested. */
  conversations: { ownershipOf(input: { conversationId: string; workspaceId: string }): Promise<ConversationOwnership | null> };
  activity: ConversationActivityWriter;
}

export interface EmailThreadProtocolUnitOfWork {
  run<T>(work: (scope: EmailThreadProtocolScope) => Promise<T>): Promise<T>;
}

export interface EmailInboundProcessorDependencies {
  receiver: Pick<InboundEmailReceiver, "provider" | "fetchMessage">;
  inbound: Pick<
    EmailInboundRepository,
    | "insertClaimedDelivery"
    | "listEventDeliveries"
    | "recordFetched"
    | "settleDropped"
    | "recordIngested"
    | "failDelivery"
    | "settleEvent"
    | "retryEventLater"
  >;
  mailboxes: Pick<
    EmailMailboxRepository,
    "resolveRelayToken" | "findActiveByAddress" | "findActiveById" | "listActive" | "policyEffectiveAt"
  >;
  /** Routing's receiving-domain lookup, and the readiness refresh a provider's domain event asks for (FR-003). */
  domains: Pick<EmailDomainRepository, "findReceivingVerified" | "expediteRefresh">;
  threads: Pick<EmailThreadRepository, "findOutboundMessageIds">;
  receipts: Pick<MailboxService, "recordInboundReceipt">;
  /** Provider delivery events and inbound delivery status reports settle the sends they name. */
  deliveryEvents: Pick<ProviderDeliveryEvents, "applyStatus" | "applyDsnBounce">;
  threadProtocol: EmailThreadProtocolUnitOfWork;
  chat: Pick<ConnectorChatPort, "ingest">;
  drains: EmailChannelDrainDispatcherPort;
  metrics?: Pick<MetricsRegistry, "incrementCounter" | "observeHistogram"> | null;
  /** Failure and degradation lines only, with ids and codes. */
  logger: { warn(fields: Record<string, unknown>, message: string): void };
  clock: () => Date;
  createId: () => string;
  randomBytes: (size: number) => Uint8Array;
  config: {
    inboundDomain: string;
    /** Raw MIME bytes stored per delivery: `EMAIL_RAW_MAX_BYTES` in a deployment. */
    rawMaxBytes: number;
    /** The modes this deployment runs (plan, Questions settled, item 4). */
    supportedModes: readonly EngagementMode[];
    /** Mail on one thread inside it gets one review (FR-024): `EMAIL_COALESCE_SECONDS` in a deployment. */
    coalesceSeconds: number;
  };
}

type Mailbox = NonNullable<Awaited<ReturnType<EmailMailboxRepository["findActiveById"]>>>;

/** What every delivery of one event shares: the claimed event and the fetched content. */
interface EventContent {
  event: InboundEventRecord;
  message: InboundEmailMessage;
  customerText: CustomerText;
  deliveredTo: readonly string[];
}

/** Everything a delivery's steps share: the event, its content and the mailbox's authority. */
interface DeliveryContext extends EventContent {
  mailbox: Mailbox;
  /** Accepted and current policy combined (research B16), capped to the supported modes. */
  authority: { mode: EngagementMode; enabled: boolean };
}

type FetchResult =
  | { ok: true; message: InboundEmailMessage }
  | { ok: false; retryable: boolean; code: string };

/**
 * A step's fenced write lost: the event's claim was reclaimed by another worker, or the delivery
 * moved past the step. This worker stops; the claim that holds the event finishes the delivery.
 */
class DeliveryClaimLost extends Error {
  constructor(readonly step: string) {
    super("email_inbound_claim_lost");
    this.name = "DeliveryClaimLost";
  }
}

/** The claim `event`'s worker writes `delivery` under. */
const claimOf = (event: InboundEventRecord, delivery: Pick<InboundDeliveryRecord, "id">): DeliveryClaim =>
  ({ deliveryId: delivery.id, attempt: event.attempts });

/** Stops the worker when a step's fenced write did not land. */
const requireWon = (won: boolean, step: string): void => {
  if (!won) throw new DeliveryClaimLost(step);
};

export class EmailInboundProcessor {
  constructor(private readonly deps: EmailInboundProcessorDependencies) {}

  async process(event: InboundEventRecord): Promise<InboundEventOutcome> {
    if (event.eventKind === "delivery_status" && event.providerObjectId !== null) {
      return this.applyDeliveryStatus(event, event.providerObjectId);
    }
    if (event.eventKind === "domain_status" && event.providerObjectId !== null) {
      return this.applyDomainStatus(event, event.providerObjectId);
    }
    if (event.eventKind !== "message_received" || event.providerObjectId === null) {
      return this.settle(event, "ignored", null);
    }
    const envelope = readEnvelope(event.envelope);
    const fetched = await this.fetch(event, event.providerObjectId);
    if (!fetched.ok) {
      return fetched.retryable && hasAttemptsLeft(event)
        ? this.retryLater(event, fetched.code)
        : this.failTerminally(event, fetched.code, deliveredToSet(envelope, null));
    }
    try {
      return await this.deliver({ event, message: fetched.message, customerText: await this.extractText(fetched.message), deliveredTo: deliveredToSet(envelope, fetched.message) });
    } catch (error) {
      if (error instanceof DeliveryClaimLost) return this.yieldClaim(event, error.step);
      this.deps.logger.warn(
        { eventId: event.id, attempt: event.attempts, errorName: errorName(error) },
        "email_inbound_processing_failed",
      );
      return hasAttemptsLeft(event)
        ? this.retryLater(event, PROCESSING_FAILED)
        : this.failTerminally(event, PROCESSING_FAILED, deliveredToSet(envelope, fetched.message));
    }
  }

  // ── Event ──────────────────────────────────────────────────────────

  /** A provider event about mail Radioso sent: it settles the send it names, if it names one. */
  private async applyDeliveryStatus(event: InboundEventRecord, providerMessageId: string): Promise<InboundEventOutcome> {
    const status = readDeliveryStatus(event.envelope);
    if (!status) return this.settle(event, "ignored", null);
    try {
      const applied = await this.deps.deliveryEvents.applyStatus({ provider: event.provider, providerMessageId, status });
      return this.settle(event, applied === "foreign" ? "ignored" : "processed", null);
    } catch (error) {
      this.deps.logger.warn({ eventId: event.id, attempt: event.attempts, errorName: errorName(error) }, "email_delivery_status_failed");
      return hasAttemptsLeft(event) ? this.retryLater(event, PROCESSING_FAILED) : this.settle(event, "failed", PROCESSING_FAILED);
    }
  }

  /**
   * A provider event about one of its sending domains (FR-003): the domain it names is made due for
   * its readiness refresh now, which records any transition and retries a failed provider read.
   * A domain no workspace holds is ignored.
   */
  private async applyDomainStatus(event: InboundEventRecord, providerDomainId: string): Promise<InboundEventOutcome> {
    try {
      const expedited = await this.deps.domains.expediteRefresh({ provider: event.provider, providerDomainId });
      return this.settle(event, expedited ? "processed" : "ignored", null);
    } catch (error) {
      this.deps.logger.warn({ eventId: event.id, attempt: event.attempts, errorName: errorName(error) }, "email_domain_status_failed");
      return hasAttemptsLeft(event) ? this.retryLater(event, PROCESSING_FAILED) : this.settle(event, "failed", PROCESSING_FAILED);
    }
  }

  /**
   * Resumes each delivery an earlier attempt opened from the mailbox it was bound to, then routes
   * for mailboxes the event reaches that have none yet. Only an event that reached no mailbox at
   * all is logged as unrouted.
   */
  private async deliver(content: EventContent): Promise<InboundEventOutcome> {
    const { event } = content;
    const opened = await this.deps.inbound.listEventDeliveries(event.id);
    for (const delivery of opened) {
      if (isUnfinished(delivery)) await this.resume(content, delivery);
    }
    const bound = new Set(opened.map((delivery) => delivery.mailboxId));
    const targets = await routeDeliveredTo(content.deliveredTo, this.routeLookups());
    for (const target of targets.mailboxes.filter((candidate) => !bound.has(candidate.mailboxId))) {
      const created = await this.openDelivery(event, target);
      if (created) await this.advance({ ...content, ...created.context }, created.delivery);
    }
    if (opened.length === 0 && targets.mailboxes.length === 0) {
      if (!targets.unrouted) return this.settle(event, "ignored", null);
      await this.recordUnrouted(content, targets.unrouted.workspaceId);
    }
    return this.settle(event, "processed", null);
  }

  /**
   * An earlier attempt's delivery, carried on from its stored binding rather than from routing as it
   * is now. One whose mailbox was removed since cannot finish, and fails visibly instead.
   */
  private async resume(content: EventContent, delivery: InboundDeliveryRecord): Promise<void> {
    if (delivery.mailboxId === null) {
      await this.finishUnrouted(content, delivery);
      return;
    }
    const mailbox = await this.deps.mailboxes.findActiveById(delivery.mailboxId);
    if (!mailbox) {
      requireWon(await this.deps.inbound.failDelivery(claimOf(content.event, delivery), MAILBOX_REMOVED), "fail_delivery");
      this.deps.logger.warn({ eventId: content.event.id, deliveryId: delivery.id, code: MAILBOX_REMOVED }, "email_inbound_delivery_unresumable");
      return;
    }
    await this.advance({ ...content, mailbox, authority: await this.authorityOf(content.event, mailbox) }, delivery);
  }

  /** Lets the event go to the claim that took it over: nothing is settled or retried on its behalf. */
  private yieldClaim(event: InboundEventRecord, step: string): InboundEventOutcome {
    this.deps.logger.warn({ eventId: event.id, attempt: event.attempts, step }, "email_inbound_claim_lost");
    this.count("email_inbound_events_total", "Inbound provider events by kind and final state.", { kind: event.eventKind, state: "superseded" });
    return "superseded";
  }

  private async fetch(event: InboundEventRecord, providerObjectId: string): Promise<FetchResult> {
    const result = await traceOperation({
      name: "email.inbound.fetch",
      attributes: { provider: this.deps.receiver.provider, attempt: event.attempts },
      run: async (): Promise<FetchResult> => {
        try {
          return { ok: true, message: await this.deps.receiver.fetchMessage(providerObjectId) };
        } catch (error) {
          if (error instanceof InboundFetchError) return { ok: false, retryable: error.retryable, code: error.code };
          return { ok: false, retryable: true, code: "fetch_failed" };
        }
      },
      resultAttributes: (outcome) => ({ result: fetchResultLabel(outcome) }),
    });
    this.count("email_inbound_fetch_attempts_total", "Inbound content fetch attempts by result.", { result: fetchResultLabel(result) });
    if (!result.ok) {
      this.deps.logger.warn(
        { eventId: event.id, code: result.code, attempt: event.attempts, retryable: result.retryable },
        "email_inbound_fetch_failed",
      );
    }
    return result;
  }

  private async retryLater(event: InboundEventRecord, code: string): Promise<InboundEventOutcome> {
    const delaySeconds = RETRY_DELAYS_SECONDS[event.attempts - 1] ?? RETRY_DELAYS_SECONDS[RETRY_DELAYS_SECONDS.length - 1];
    const nextAttemptAt = new Date(this.deps.clock().getTime() + delaySeconds * 1000);
    const returned = await this.deps.inbound.retryEventLater(event.id, { attempt: event.attempts, nextAttemptAt, errorCode: code });
    if (!returned) return "superseded";
    await requestDrainBestEffort(this.deps, { maxJobs: DRAIN_BATCH, stage: "inbound", scheduleAt: nextAttemptAt });
    return "retrying";
  }

  /**
   * Gives up on the event, visibly (FR-008): every unfinished delivery, and one for each mailbox
   * the event's addresses reach when the content never arrived, is `failed` with the code, which
   * the event log offers to retry.
   */
  private async failTerminally(event: InboundEventRecord, code: string, deliveredTo: readonly string[]): Promise<InboundEventOutcome> {
    const targets = await routeDeliveredTo(deliveredTo, this.routeLookups());
    try {
      for (const target of targets.mailboxes) await this.openDelivery(event, target);
    } catch (error) {
      if (error instanceof DeliveryClaimLost) return this.yieldClaim(event, error.step);
      throw error;
    }
    for (const delivery of await this.deps.inbound.listEventDeliveries(event.id)) {
      // A lost write means another claim holds the event; its settle below is refused too.
      if (isUnfinished(delivery)) await this.deps.inbound.failDelivery(claimOf(event, delivery), code);
    }
    this.deps.logger.warn({ eventId: event.id, code, attempt: event.attempts }, "email_inbound_terminal_failure");
    return this.settle(event, "failed", code);
  }

  private async settle(
    event: InboundEventRecord,
    state: "processed" | "ignored" | "failed",
    errorCode: string | null,
  ): Promise<InboundEventOutcome> {
    const settled = await this.deps.inbound.settleEvent(event.id, { attempt: event.attempts, state, errorCode });
    this.count("email_inbound_events_total", "Inbound provider events by kind and final state.", { kind: event.eventKind, state });
    return settled ? state : "superseded";
  }

  /**
   * Mail for the inbound or a receiving domain that named no mailbox: logged with its sender,
   * subject, authentication results and raw message, so the event log can show what was dropped
   * (FR-015, FR-016), and never processed further.
   */
  private async recordUnrouted(content: EventContent, workspaceId: string | null): Promise<void> {
    const deliveryId = await this.insertUnderClaim(content.event, {
      inboundEventId: content.event.id,
      workspaceId,
      mailboxId: null,
      routeRule: null,
      acceptedPolicyVersion: null,
    });
    await this.finishUnrouted(content, await this.findDelivery(content.event, deliveryId));
  }

  /** The unrouted delivery's content, then its `no_mailbox` drop, each from where an earlier attempt left it. */
  private async finishUnrouted(content: EventContent, delivery: InboundDeliveryRecord): Promise<void> {
    const claim = claimOf(content.event, delivery);
    let classification = delivery.classification;
    if (delivery.state === "pending") {
      ({ classification } = classifyInbound({
        message: content.message,
        ownAddresses: delivery.workspaceId ? await this.ownAddresses(delivery.workspaceId) : new Set(),
        isRadiosoOutboundId: () => false,
      }));
      const fetched = fetchedContentOf(content.message, classification, content.customerText, this.deps.config.rawMaxBytes);
      requireWon(await this.deps.inbound.recordFetched(claim, fetched), "record_fetched");
    }
    if (delivery.state === "pending" || delivery.state === "fetched") {
      requireWon(
        await this.deps.inbound.settleDropped(claim, { threadMatch: null, threadConflict: false, dispositionReason: "no_mailbox" }),
        "settle_dropped",
      );
      this.countDelivery(classification ?? "unclassified", "drop", "no_mailbox");
    }
  }

  // ── Delivery ───────────────────────────────────────────────────────

  /**
   * The event's delivery for one mailbox, written once under the event's claim, with the policy
   * version in force when the webhook accepted the event (research B16). Null for a mailbox removed
   * since routing.
   */
  private async openDelivery(
    event: InboundEventRecord,
    target: MailboxTarget,
  ): Promise<{ delivery: InboundDeliveryRecord; context: Pick<DeliveryContext, "mailbox" | "authority"> } | null> {
    const mailbox = await this.deps.mailboxes.findActiveById(target.mailboxId);
    if (!mailbox) return null;
    const accepted = await this.acceptedPolicyOf(event, mailbox);
    const deliveryId = await this.insertUnderClaim(event, {
      inboundEventId: event.id,
      workspaceId: mailbox.workspaceId,
      mailboxId: mailbox.id,
      routeRule: target.rule,
      acceptedPolicyVersion: accepted.version,
    });
    return { delivery: await this.findDelivery(event, deliveryId), context: { mailbox, authority: await this.authorityOf(event, mailbox) } };
  }

  /**
   * Writes a delivery of the event while this worker's claim still holds it, under the event's lock:
   * a worker that routed before its lease was reclaimed, on routing that may have changed since,
   * leaves nothing for an event another claim settles, and stops.
   */
  private async insertUnderClaim(
    event: InboundEventRecord,
    input: Parameters<EmailInboundRepository["insertClaimedDelivery"]>[1],
  ): Promise<string> {
    const inserted = await this.deps.inbound.insertClaimedDelivery({ attempt: event.attempts }, input);
    if (!inserted) throw new DeliveryClaimLost("insert_delivery");
    return inserted.deliveryId;
  }

  private async findDelivery(event: InboundEventRecord, deliveryId: string): Promise<InboundDeliveryRecord> {
    const delivery = (await this.deps.inbound.listEventDeliveries(event.id)).find((candidate) => candidate.id === deliveryId);
    if (!delivery) throw new Error("The inbound delivery just written was not found");
    return delivery;
  }

  /** The mailbox policy in force when the webhook accepted the event (research B16). */
  private async acceptedPolicyOf(event: InboundEventRecord, mailbox: Mailbox) {
    return (await this.deps.mailboxes.policyEffectiveAt(mailbox.id, event.receivedAt))
      ?? { version: mailbox.policyVersion, engagementMode: mailbox.engagementMode, enabled: mailbox.enabled };
  }

  /** The accepted and the current policy combined, capped to the deployment's modes. */
  private async authorityOf(event: InboundEventRecord, mailbox: Mailbox): Promise<DeliveryContext["authority"]> {
    const accepted = await this.acceptedPolicyOf(event, mailbox);
    const effective = effectiveEngagementMode(
      { mode: accepted.engagementMode, enabled: accepted.enabled },
      { mode: mailbox.engagementMode, enabled: mailbox.enabled },
    );
    return { mode: capToSupportedMode(effective.mode, this.deps.config.supportedModes), enabled: effective.enabled };
  }

  /** Runs the delivery's remaining protocol steps from the state its last attempt left. */
  private async advance(context: DeliveryContext, delivery: InboundDeliveryRecord): Promise<void> {
    let current = delivery;
    if (current.state === "pending") current = await this.recordContent(context, current);
    if (current.state === "fetched") current = await this.resolveAndReserve(context, current);
    if (current.state === "resolved") current = await this.ingest(context, current);
    if (current.state === "ingested") await this.index(context, current);
  }

  /** Step 0: the normalized content and its structural classification, and the mailbox's receipt. */
  private async recordContent(context: DeliveryContext, delivery: InboundDeliveryRecord): Promise<InboundDeliveryRecord> {
    const { message, mailbox } = context;
    const bounced = message.report
      ? await this.deps.threads.findOutboundMessageIds(mailbox.id, message.report.originalMessageIds)
      : new Set<string>();
    const { classification, bouncedOutboundIds } = classifyInbound({
      message,
      ownAddresses: await this.ownAddresses(mailbox.workspaceId),
      isRadiosoOutboundId: (rfcMessageId) => bounced.has(rfcMessageId),
    });
    // Before the step is recorded, so a failure repeats it; applying a bounce twice is a no-op.
    if (bouncedOutboundIds.length > 0) {
      await this.deps.deliveryEvents.applyDsnBounce({ mailboxId: mailbox.id, rfcMessageIds: bouncedOutboundIds });
    }
    const content = fetchedContentOf(message, classification, context.customerText, this.deps.config.rawMaxBytes);
    requireWon(await this.deps.inbound.recordFetched(claimOf(context.event, delivery), content), "record_fetched");
    await this.deps.receipts.recordInboundReceipt({
      mailboxId: mailbox.id,
      receivedAt: context.event.receivedAt,
      deliveredTo: context.deliveredTo,
    });
    return {
      ...delivery,
      state: "fetched",
      classification,
      senderAddress: content.senderAddress,
      senderDisplayName: content.senderDisplayName,
      subject: content.subject,
      rfcMessageId: content.rfcMessageId,
      referenceIds: content.referenceIds,
      ccAddresses: content.ccAddresses,
    };
  }

  /**
   * Step 1 (one transaction, under the thread lock): resolve the thread, decide the disposition,
   * and either settle a drop or persist the ids the next steps will use.
   */
  private async resolveAndReserve(context: DeliveryContext, delivery: InboundDeliveryRecord): Promise<InboundDeliveryRecord> {
    const { mailbox } = context;
    const participant = delivery.senderAddress ?? "";
    return this.deps.threadProtocol.run(async (scope) => {
      await scope.lockThread({ mailboxId: mailbox.id, participantAddress: participant });
      const { candidates, identities } = await this.threadCandidates(scope, context, delivery);
      const resolution = await traceOperation({
        name: "email.inbound.thread_resolve",
        attributes: correlation(context, delivery),
        run: () => resolveThread(candidates, participant),
        resultAttributes: (resolved) => ({
          matched_by: resolved.kind === "existing" ? resolved.matchedBy : resolved.kind,
          conflict: resolved.kind === "existing" && resolved.conflict,
        }),
      });
      const ownership = resolution.kind === "new"
        ? null
        : await scope.conversations.ownershipOf({ conversationId: resolution.conversationId, workspaceId: mailbox.workspaceId });
      const disposition = await this.decide(context, delivery, resolution, ownership);

      if (disposition.kind === "drop") {
        requireWon(await scope.inbound.settleDropped(claimOf(context.event, delivery), {
          threadMatch: resolution.kind === "existing" ? resolution.matchedBy : null,
          threadConflict: resolution.kind === "existing" && resolution.conflict,
          dispositionReason: disposition.reason,
        }), "settle_dropped");
        if (disposition.noteOnThread && resolution.kind !== "new" && ownership !== null) {
          await scope.activity.record(channelException(resolution.conversationId, mailbox.workspaceId, disposition.reason, delivery.id));
        }
        return { ...delivery, state: "done", disposition: "drop", dispositionReason: disposition.reason };
      }
      if (resolution.kind === "participant_mismatch") {
        throw new Error("A participant mismatch is always dropped");
      }

      const conversationId = resolution.kind === "existing" ? resolution.conversationId : this.deps.createId();
      const identity = (resolution.kind === "existing" ? identities.get(conversationId) : null) ?? this.newThreadIdentity(participant);
      const reservation = {
        threadMatch: resolution.kind === "existing" ? resolution.matchedBy : "new_thread" as const,
        threadConflict: resolution.kind === "existing" && resolution.conflict,
        disposition: disposition.kind,
        dispositionReason: disposition.kind === "ingest_only" ? disposition.reason : "accepted" as const,
        plannedConversationId: conversationId,
        plannedMessageId: this.deps.createId(),
        plannedThreadKey: identity.threadKey,
        plannedThreadToken: identity.threadToken,
      };
      // A lost reservation rolls back with the transaction: the ids allocated here are never used.
      requireWon(await scope.inbound.reserveThread(claimOf(context.event, delivery), reservation), "reserve_thread");
      return { ...delivery, ...reservation, state: "resolved" };
    });
  }

  /** Step 2: the host records the message, and the hand-off, idempotently on the reserved ids. */
  private async ingest(context: DeliveryContext, delivery: InboundDeliveryRecord): Promise<InboundDeliveryRecord> {
    const identity = reservedIdentityOf(delivery);
    const humanOwnershipReason = HUMAN_OWNERSHIP_BY_REASON.get(delivery.dispositionReason ?? "");
    const result = await this.deps.chat.ingest({
      workspaceId: context.mailbox.workspaceId,
      agentId: context.mailbox.agentId,
      // `new` with the reserved id is a no-op for a conversation that exists, so a delivery that
      // joined an in-flight reservation creates the conversation if it gets there first.
      conversation: {
        kind: "new",
        conversationId: identity.conversationId,
        sourceChannel: SOURCE_CHANNEL,
        channelContext: {
          provider: "email",
          mailbox: { id: context.mailbox.id, address: context.mailbox.address },
          threadKey: identity.threadKey,
          participant: { address: identity.participantAddress },
        },
      },
      message: { id: identity.messageId, text: context.customerText.text, receivedAt: context.event.receivedAt },
      humanOwnership: humanOwnershipReason ? { reason: humanOwnershipReason } : null,
    });
    requireWon(
      await this.deps.inbound.recordIngested(claimOf(context.event, delivery), { conversationId: result.conversationId, messageId: result.messageId }),
      "record_ingested",
    );
    this.deps.metrics?.observeHistogram("email_receipt_to_inbox_seconds", {
      help: "Seconds from webhook acceptance to the message being in the inbox.",
      labels: { mode: context.authority.mode },
      value: Math.max(0, (this.deps.clock().getTime() - context.event.receivedAt.getTime()) / 1000),
      buckets: RECEIPT_TO_INBOX_BUCKETS,
    });
    return { ...delivery, state: "ingested", conversationId: result.conversationId, messageId: result.messageId };
  }

  /**
   * Step 3 (one transaction): the step acquired by settling the delivery `done` under the claim,
   * then the thread link, the header projection and the Message-Id index, and the thread's review
   * scheduled when the delivery was accepted for one (research B7); a drain is asked for at its due
   * time once that commits. A worker that does not acquire the step writes nothing, so the review's
   * revision moves once per delivery.
   */
  private async index(context: DeliveryContext, delivery: InboundDeliveryRecord): Promise<void> {
    const identity = reservedIdentityOf(delivery);
    const conversationId = delivery.conversationId ?? identity.conversationId;
    const { mailbox, event } = context;
    const review = await this.deps.threadProtocol.run(async (scope) => {
      requireWon(await scope.inbound.markIndexed(claimOf(event, delivery)), "mark_indexed");
      await scope.threads.upsertLink({
        conversationId,
        workspaceId: mailbox.workspaceId,
        mailboxId: mailbox.id,
        threadKey: identity.threadKey,
        threadToken: identity.threadToken,
        participantAddress: identity.participantAddress,
      });
      await scope.threads.recordLatestInbound(conversationId, {
        subject: delivery.subject,
        participantDisplayName: delivery.senderDisplayName,
        ccAddresses: delivery.ccAddresses,
        inboundAt: event.receivedAt,
      });
      await scope.threads.insertIndexEntries(indexEntriesOf(context, delivery, conversationId));
      const scheduled = delivery.disposition === "run_review_turn"
        ? await scope.threads.scheduleReview(conversationId, {
            dueAt: new Date(this.deps.clock().getTime() + this.deps.config.coalesceSeconds * 1000),
            policyVersion: delivery.acceptedPolicyVersion ?? mailbox.policyVersion,
          })
        : null;
      if (delivery.threadConflict) {
        await scope.activity.record(channelException(conversationId, mailbox.workspaceId, "thread_conflict", delivery.id));
      }
      return scheduled;
    });
    if (review) {
      await requestDrainBestEffort(this.deps, { maxJobs: DRAIN_BATCH, stage: "review", scheduleAt: review.dueAt });
    }
  }

  // ── Rules and lookups ──────────────────────────────────────────────

  private async decide(
    context: DeliveryContext,
    delivery: InboundDeliveryRecord,
    resolution: ThreadResolution,
    ownership: ConversationOwnership | null,
  ): Promise<EngagementDisposition> {
    const classification = delivery.classification ?? "person";
    const disposition = await traceOperation({
      name: "email.inbound.disposition",
      attributes: { ...correlation(context, delivery), classification },
      run: () => resolveEngagementDisposition({
        mailbox: {
          effectiveMode: context.authority.mode,
          enabled: context.authority.enabled,
          hasAgent: context.mailbox.agentId !== null,
        },
        classification,
        thread: resolution.kind === "existing"
          ? { kind: "existing", ownership: ownership ?? "ai_owned" }
          : { kind: resolution.kind },
        // Read as the mailbox was when the delivery opened; the review's own reservation is the
        // atomic check (research B8), so mail racing a full window is still bounded there.
        generationBudgetExhausted: isGenerationBudgetExhausted(context.mailbox, this.deps.clock()),
      }),
      resultAttributes: (decided) => ({ disposition: decided.kind, reason: dispositionReasonOf(decided) }),
    });
    this.countDelivery(classification, disposition.kind, dispositionReasonOf(disposition));
    if (disposition.kind === "ingest_only" && disposition.reason === "generation_budget") {
      this.count("email_budget_hits_total", "Automatic email behavior a budget stopped, by budget.", { budget: "mailbox_generation" });
    }
    return disposition;
  }

  /** The lookups of research B15 step 1: forward (index, then reservations), reverse, then token. */
  private async threadCandidates(
    scope: EmailThreadProtocolScope,
    context: DeliveryContext,
    delivery: InboundDeliveryRecord,
  ): Promise<{ candidates: ThreadCandidates; identities: Map<string, ThreadIdentity> }> {
    const mailboxId = context.mailbox.id;
    const references = delivery.referenceIds;
    const matchedBy = (rfcMessageId: string) => (rfcMessageId === context.message.inReplyTo ? "in_reply_to" as const : "references" as const);
    const indexed = await scope.threads.findIndexedConversations(mailboxId, references);
    const reserved = (await scope.inbound.findForwardReservations(mailboxId, references))
      .filter((match) => match.deliveryId !== delivery.id);
    const reverse = delivery.rfcMessageId
      ? (await scope.inbound.findReverseReferences(mailboxId, delivery.rfcMessageId)).filter((match) => match.deliveryId !== delivery.id)
      : [];
    const forward = [
      ...indexed.map((match) => ({ conversationId: match.conversationId, matchedBy: matchedBy(match.rfcMessageId), source: "index" as const })),
      ...reserved.map((match) => ({ conversationId: match.conversationId, matchedBy: matchedBy(match.rfcMessageId), source: "reservation" as const })),
    ];
    const tokenLink = forward.length === 0 && reverse.length === 0
      ? await this.findByThreadToken(scope, mailboxId, context.deliveredTo)
      : null;
    const identities = await this.threadIdentities(scope, mailboxId, [
      ...forward.map((match) => match.conversationId),
      ...reverse.map((match) => match.conversationId),
      ...(tokenLink ? [tokenLink.conversationId] : []),
    ]);
    return {
      candidates: {
        forward,
        reverse: reverse.map(({ conversationId }) => ({ conversationId })),
        byThreadToken: tokenLink?.conversationId ?? null,
        participantOf: (conversationId) => identities.get(conversationId)?.participantAddress ?? "",
      },
      identities,
    };
  }

  /**
   * The `+tag` of any delivered-to address, as the thread token of one of this mailbox's threads.
   * Forwarded mail carries the tag on the customer's own address, not on the relay address.
   */
  private async findByThreadToken(
    scope: EmailThreadProtocolScope,
    mailboxId: string,
    deliveredTo: readonly string[],
  ): Promise<{ conversationId: string } | null> {
    const tags = deliveredTo.map(parsePlusToken).filter((tag): tag is string => tag !== null);
    // Tokens are issued uppercase; a mail system may fold the local part's case.
    for (const candidate of new Set(tags.flatMap((tag) => [tag, tag.toUpperCase()]))) {
      const link = await scope.threads.findLinkByThreadToken(mailboxId, candidate);
      if (link) return { conversationId: link.conversationId };
    }
    return null;
  }

  /** Each candidate's identity: its link when indexed, else the reservation still in flight. */
  private async threadIdentities(
    scope: EmailThreadProtocolScope,
    mailboxId: string,
    conversationIds: readonly string[],
  ): Promise<Map<string, ThreadIdentity>> {
    const identities = new Map<string, ThreadIdentity>();
    const unlinked: string[] = [];
    for (const conversationId of new Set(conversationIds)) {
      const link = await scope.threads.findLink(conversationId);
      if (link) identities.set(conversationId, link);
      else unlinked.push(conversationId);
    }
    for (const [conversationId, reserved] of await scope.inbound.findReservedThreads(mailboxId, unlinked)) {
      identities.set(conversationId, reserved);
    }
    return identities;
  }

  private newThreadIdentity(participantAddress: string): ThreadIdentity {
    return {
      threadKey: this.deps.createId(),
      threadToken: generateOpaqueToken(this.deps.randomBytes),
      participantAddress,
    };
  }

  /** The workspace's own addresses, which mark self-sent mail: each mailbox and its relay addresses. */
  private async ownAddresses(workspaceId: string): Promise<ReadonlySet<string>> {
    const own = new Set<string>();
    for (const mailbox of await this.deps.mailboxes.listActive(workspaceId)) {
      own.add(mailbox.address.toLowerCase());
      for (const relayToken of [mailbox.relayToken, mailbox.previousRelayToken]) {
        if (relayToken) own.add(`${relayToken}@${this.deps.config.inboundDomain}`.toLowerCase());
      }
    }
    return own;
  }

  private async extractText(message: InboundEmailMessage): Promise<CustomerText> {
    return traceOperation({
      name: "email.inbound.normalize",
      attributes: { raw_bytes: message.raw.length, truncated: message.raw.length > this.deps.config.rawMaxBytes },
      // This slice sends no mail, so no thread holds outbound text to strip from a reply.
      run: () => extractCustomerText(message, []),
      resultAttributes: (extracted) => ({ strip_confidence: extracted.confidence }),
    });
  }

  private routeLookups(): InboundRouteLookups {
    return { inboundDomain: this.deps.config.inboundDomain, mailboxes: this.deps.mailboxes, domains: this.deps.domains };
  }

  private countDelivery(classification: string, disposition: string, reason: string): void {
    this.count("email_inbound_deliveries_total", "Inbound deliveries by classification, disposition and reason.", {
      classification,
      disposition,
      reason,
    });
  }

  private count(name: string, help: string, labels: Record<string, string>): void {
    this.deps.metrics?.incrementCounter(name, { help, labels });
  }
}

const hasAttemptsLeft = (event: InboundEventRecord): boolean => event.attempts <= RETRY_DELAYS_SECONDS.length;

const isUnfinished = (delivery: InboundDeliveryRecord): boolean => delivery.state !== "done" && delivery.state !== "failed";

/** Tokens the provider adapter already reduced the bounce detail to; re-checked when read back. */
const PROVIDER_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const ENHANCED_STATUS_CODE = /^[245]\.\d{1,3}\.\d{1,3}$/u;

const deliveryStatusSchema = z.object({
  status: z.object({
    type: z.enum(["sent", "delivered", "delivery_delayed", "bounced", "complained", "failed", "suppressed"]),
    bounce: z
      .object({
        type: z.string().regex(PROVIDER_TOKEN),
        subType: z.string().regex(PROVIDER_TOKEN).nullable(),
        statusCode: z.string().regex(ENHANCED_STATUS_CODE).nullable(),
      })
      .nullable(),
  }),
});

/** The delivery status the webhook persisted; null when it is not one this processor can read. */
const readDeliveryStatus = (envelope: unknown): DeliveryStatusFacts | null => {
  const parsed = deliveryStatusSchema.safeParse(envelope);
  return parsed.success ? parsed.data.status : null;
};

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

const fetchResultLabel = (result: FetchResult): string => {
  if (result.ok) return "ok";
  return result.retryable ? "retryable_error" : "terminal_error";
};

const dispositionReasonOf = (disposition: EngagementDisposition): string =>
  disposition.kind === "run_review_turn" ? "accepted" : disposition.reason;

const correlation = (context: DeliveryContext, delivery: InboundDeliveryRecord): Record<string, string> => ({
  "radioso.workspace_id": context.mailbox.workspaceId,
  "radioso.email.delivery_id": delivery.id,
});

const channelException = (conversationId: string, workspaceId: string, code: string, deliveryId: string) => ({
  conversationId,
  workspaceId,
  kind: "channel_exception" as const,
  actorUserId: null,
  detail: { code, deliveryId },
});

/** The reserved ids and identity a `resolved` delivery carries into ingest and index. */
const reservedIdentityOf = (delivery: InboundDeliveryRecord): ThreadIdentity & { conversationId: string; messageId: string } => {
  const { plannedConversationId, plannedMessageId, plannedThreadKey, plannedThreadToken } = delivery;
  if (!plannedConversationId || !plannedMessageId || !plannedThreadKey || !plannedThreadToken) {
    throw new Error("A reserved delivery is missing its planned ids");
  }
  return {
    conversationId: plannedConversationId,
    messageId: delivery.messageId ?? plannedMessageId,
    threadKey: plannedThreadKey,
    threadToken: plannedThreadToken,
    participantAddress: delivery.senderAddress ?? "",
  };
};

/** The webhook's verified envelope, read structurally: only the address lists routing needs. */
const readEnvelope = (envelope: unknown): Pick<InboundEnvelope, "to" | "cc" | "receivedFor"> => {
  const record = typeof envelope === "object" && envelope !== null ? (envelope as Record<string, unknown>) : {};
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return { to: strings(record.to), cc: strings(record.cc), receivedFor: strings(record.receivedFor) };
};

/**
 * The delivered-to set (research A2): who the provider delivered for, the delivery headers, and
 * the recipients. Routing decides which of them name a mailbox; the message's `To` alone never does.
 */
const deliveredToSet = (
  envelope: Pick<InboundEnvelope, "to" | "cc" | "receivedFor">,
  message: Pick<InboundEmailMessage, "deliveredTo" | "to" | "cc"> | null,
): string[] => {
  const seen = new Set<string>();
  const addresses: string[] = [];
  const all = [...envelope.receivedFor, ...(message?.deliveredTo ?? []), ...envelope.to, ...envelope.cc, ...(message?.to ?? []), ...(message?.cc ?? [])];
  for (const address of all.map((value) => value.trim())) {
    const key = address.toLowerCase();
    if (address.length > 0 && !seen.has(key)) {
      seen.add(key);
      addresses.push(address);
    }
  }
  return addresses;
};

/** `References` with `In-Reply-To`, each once: the ids a reply's thread can be found by. */
const referenceIdsOf = (message: Pick<InboundEmailMessage, "references" | "inReplyTo">): string[] =>
  [...new Set([...message.references, ...(message.inReplyTo ? [message.inReplyTo] : [])])];

const fetchedContentOf = (
  message: InboundEmailMessage,
  classification: FetchedDeliveryContent["classification"],
  customerText: CustomerText,
  rawMaxBytes: number,
): FetchedDeliveryContent => ({
  classification,
  senderAddress: message.from?.address.trim().toLowerCase() ?? null,
  senderDisplayName: message.from?.displayName ?? null,
  subject: customerText.subject,
  rfcMessageId: message.rfcMessageId,
  referenceIds: referenceIdsOf(message),
  ccAddresses: message.cc,
  receivedFor: message.deliveredTo,
  authResults: message.authentication,
  spamVerdict: message.spamVerdict,
  attachments: message.attachments,
  bodyText: customerText.text,
  stripConfidence: customerText.confidence,
  rawMime: message.raw.subarray(0, rawMaxBytes),
  rawSizeBytes: message.raw.length,
  rawTruncated: message.raw.length > rawMaxBytes,
});

const indexEntriesOf = (context: DeliveryContext, delivery: InboundDeliveryRecord, conversationId: string) => {
  const base = { workspaceId: context.mailbox.workspaceId, mailboxId: context.mailbox.id, conversationId };
  const own = delivery.rfcMessageId
    ? [{
        ...base,
        messageId: delivery.messageId,
        direction: "inbound" as const,
        origin: "inbound" as const,
        rfcMessageId: delivery.rfcMessageId,
        subject: delivery.subject,
        ccAddresses: delivery.ccAddresses,
        attachments: context.message.attachments,
        inboundDeliveryId: delivery.id,
      }]
    : [];
  const referenced = delivery.referenceIds
    .filter((rfcMessageId) => rfcMessageId !== delivery.rfcMessageId)
    .map((rfcMessageId) => ({
      ...base,
      messageId: null,
      direction: "referenced" as const,
      origin: "referenced" as const,
      rfcMessageId,
      subject: null,
      ccAddresses: [],
      attachments: [],
      inboundDeliveryId: null,
    }));
  return [...own, ...referenced];
};
