import { randomUUID } from "node:crypto";

import type { EmailDomainRecord, EmailDomainRepository } from "../../src/modules/emailChannel/persistence/emailDomainRepository.js";
import type { EmailInboundRepository } from "../../src/modules/emailChannel/persistence/emailInboundRepository.js";
import type {
  EmailMailboxRecord,
  EmailMailboxRepository,
  MailboxPolicyVersion,
} from "../../src/modules/emailChannel/persistence/emailMailboxRepository.js";
import type {
  EmailThreadLinkRecord,
  EmailThreadRepository,
} from "../../src/modules/emailChannel/persistence/emailThreadRepository.js";

type Clock = () => Date;
type Args<T extends (...args: never[]) => unknown> = Parameters<T>;

/** In-memory `email_domains`, honouring the active-domain uniqueness and the database clock. */
export class InMemoryEmailDomains implements Pick<
  EmailDomainRepository,
  | "insertActive"
  | "findActiveByDomain"
  | "findActive"
  | "findById"
  | "listActive"
  | "findReceivingVerified"
  | "listDueForRefresh"
  | "recordReadiness"
  | "deferRefresh"
  | "confirmReceiving"
  | "markRemoved"
  | "listCleanupDue"
  | "recordCleanup"
> {
  readonly records = new Map<string, EmailDomainRecord>();

  constructor(private readonly clock: Clock) {}

  seed(overrides: Partial<EmailDomainRecord> & { workspaceId: string; domain: string }): EmailDomainRecord {
    const record: EmailDomainRecord = {
      id: randomUUID(),
      provider: "local",
      providerDomainId: `provider-${overrides.domain}`,
      providerRegion: null,
      dnsRecords: [],
      sendingStatus: "pending",
      receivingStatus: "not_requested",
      receivingConfirmedByUserId: null,
      receivingConfirmedAt: null,
      lastCheckedAt: null,
      nextCheckAt: null,
      statusChangedAt: null,
      removedAt: null,
      providerCleanupStatus: null,
      createdByUserId: null,
      createdAt: this.clock(),
      ...overrides,
    };
    this.records.set(record.id, record);
    return record;
  }

  async insertActive(input: Args<EmailDomainRepository["insertActive"]>[0]) {
    if (await this.findActiveByDomain(input.domain)) return null;
    return this.seed({
      ...input,
      dnsRecords: [...input.dnsRecords],
      lastCheckedAt: this.clock(),
      statusChangedAt: this.clock(),
    });
  }

  async findActiveByDomain(domain: string) {
    return [...this.records.values()].find((record) => record.domain === domain && record.removedAt === null) ?? null;
  }

  async findActive(workspaceId: string, domainId: string) {
    const record = this.records.get(domainId);
    return record && record.workspaceId === workspaceId && record.removedAt === null ? record : null;
  }

  async findById(domainId: string) {
    return this.records.get(domainId) ?? null;
  }

  async listActive(workspaceId: string) {
    return [...this.records.values()].filter((record) => record.workspaceId === workspaceId && record.removedAt === null);
  }

  async findReceivingVerified(domain: string) {
    const record = [...this.records.values()]
      .find((candidate) => candidate.domain === domain && candidate.receivingStatus === "verified" && candidate.removedAt === null);
    return record ? { workspaceId: record.workspaceId } : null;
  }

  async listDueForRefresh(limit: number) {
    const now = this.clock().getTime();
    return [...this.records.values()]
      .filter((record) => record.removedAt === null && record.nextCheckAt !== null && record.nextCheckAt.getTime() <= now)
      .slice(0, limit);
  }

  async recordReadiness(domainId: string, readiness: Args<EmailDomainRepository["recordReadiness"]>[1]) {
    const record = this.records.get(domainId);
    if (!record || record.removedAt) return null;
    return this.update(record, {
      sendingStatus: readiness.sendingStatus,
      receivingStatus: readiness.receivingStatus,
      dnsRecords: [...readiness.dnsRecords],
      lastCheckedAt: this.clock(),
      nextCheckAt: readiness.nextCheckAt,
      ...(readiness.statusChanged ? { statusChangedAt: this.clock() } : {}),
    });
  }

  async deferRefresh(domainId: string, nextCheckAt: Date) {
    const record = this.records.get(domainId);
    if (record && !record.removedAt) this.update(record, { nextCheckAt });
  }

  async confirmReceiving(domainId: string, input: Args<EmailDomainRepository["confirmReceiving"]>[1]) {
    const record = this.records.get(domainId);
    if (!record || record.removedAt) return null;
    this.update(record, { receivingConfirmedByUserId: input.confirmedByUserId, receivingConfirmedAt: this.clock() });
    return this.recordReadiness(domainId, input.readiness);
  }

  async markRemoved(workspaceId: string, domainId: string) {
    const record = await this.findActive(workspaceId, domainId);
    return record
      ? this.update(record, { removedAt: this.clock(), providerCleanupStatus: "pending", nextCheckAt: this.clock() })
      : null;
  }

  async listCleanupDue(limit: number) {
    const now = this.clock().getTime();
    return [...this.records.values()]
      .filter((record) => record.removedAt !== null
        && (record.providerCleanupStatus === "pending" || record.providerCleanupStatus === "failed")
        && (record.nextCheckAt === null || record.nextCheckAt.getTime() <= now))
      .slice(0, limit);
  }

  async recordCleanup(domainId: string, outcome: Args<EmailDomainRepository["recordCleanup"]>[1]) {
    const record = this.records.get(domainId);
    if (record?.removedAt) this.update(record, { providerCleanupStatus: outcome.status, nextCheckAt: outcome.retryAt });
  }

  private update(record: EmailDomainRecord, patch: Partial<EmailDomainRecord>): EmailDomainRecord {
    const next = { ...record, ...patch };
    this.records.set(record.id, next);
    return next;
  }
}

/** In-memory `email_mailboxes` and `email_mailbox_policies`. */
export class InMemoryEmailMailboxes implements Pick<
  EmailMailboxRepository,
  | "createWithPolicy"
  | "findActive"
  | "findActiveById"
  | "findById"
  | "listActive"
  | "countActiveOnDomain"
  | "resolveRelayToken"
  | "findActiveByAddress"
  | "policyEffectiveAt"
  | "updateSettings"
  | "rotateRelayToken"
  | "startSetupCheck"
  | "recordReceipt"
  | "markRemoved"
  | "lockForPolicyChange"
  | "appendPolicyVersion"
> {
  readonly records = new Map<string, EmailMailboxRecord>();
  readonly history: MailboxPolicyVersion[] = [];
  /** Every call, in order, so a test can assert the lock came first. */
  readonly calls: string[] = [];

  constructor(private readonly clock: Clock) {}

  seed(overrides: Partial<EmailMailboxRecord> & { workspaceId: string; domainId: string; address: string }): EmailMailboxRecord {
    const record: EmailMailboxRecord = {
      id: randomUUID(),
      agentId: null,
      displayName: "Support",
      relayToken: "RELAYTOKENRELAYTOKENRELAYT",
      previousRelayToken: null,
      previousRelayTokenExpiresAt: null,
      engagementMode: "operator_only",
      enabled: true,
      policyVersion: 1,
      threadSendBudget: 3,
      hourlyGenerationBudget: 30,
      threadContextMessages: 10,
      spamOptIn: false,
      silenceThresholdHours: 72,
      plusAddressVerifiedAt: null,
      setupCheckStep: null,
      setupCheckStartedAt: null,
      lastReceivedAt: null,
      removedAt: null,
      createdByUserId: null,
      createdAt: this.clock(),
      updatedAt: this.clock(),
      ...overrides,
    };
    this.records.set(record.id, record);
    return record;
  }

  async createWithPolicy(input: Args<EmailMailboxRepository["createWithPolicy"]>[0]) {
    this.calls.push("createWithPolicy");
    if ([...this.records.values()].some((record) => record.address === input.address && record.removedAt === null)) return null;
    const record = this.seed({ ...input, policyVersion: 1 });
    this.history.push({
      mailboxId: record.id,
      version: 1,
      engagementMode: record.engagementMode,
      enabled: record.enabled,
      agentId: record.agentId,
      effectiveAt: this.clock(),
      changedByUserId: record.createdByUserId,
    });
    return record;
  }

  async findActive(workspaceId: string, mailboxId: string) {
    const record = this.records.get(mailboxId);
    return record && record.workspaceId === workspaceId && record.removedAt === null ? record : null;
  }

  async findActiveById(mailboxId: string) {
    const record = this.records.get(mailboxId);
    return record && record.removedAt === null ? record : null;
  }

  async findById(mailboxId: string) {
    return this.records.get(mailboxId) ?? null;
  }

  async listActive(workspaceId: string) {
    return [...this.records.values()].filter((record) => record.workspaceId === workspaceId && record.removedAt === null);
  }

  async countActiveOnDomain(domainId: string) {
    return [...this.records.values()].filter((record) => record.domainId === domainId && record.removedAt === null).length;
  }

  async resolveRelayToken(relayToken: string) {
    const now = this.clock().getTime();
    const active = [...this.records.values()].filter((record) => record.removedAt === null);
    const current = active.find((record) => record.relayToken === relayToken);
    if (current) return { mailboxId: current.id, workspaceId: current.workspaceId, generation: "current" as const };
    const previous = active.find((record) => record.previousRelayToken === relayToken
      && record.previousRelayTokenExpiresAt !== null && record.previousRelayTokenExpiresAt.getTime() > now);
    return previous ? { mailboxId: previous.id, workspaceId: previous.workspaceId, generation: "previous" as const } : null;
  }

  async findActiveByAddress(address: string) {
    const record = [...this.records.values()].find((candidate) => candidate.address === address && candidate.removedAt === null);
    return record ? { mailboxId: record.id, workspaceId: record.workspaceId } : null;
  }

  async policyEffectiveAt(mailboxId: string, at: Date) {
    return this.history
      .filter((version) => version.mailboxId === mailboxId && version.effectiveAt.getTime() <= at.getTime())
      .sort((a, b) => b.effectiveAt.getTime() - a.effectiveAt.getTime() || b.version - a.version)[0] ?? null;
  }

  async updateSettings(workspaceId: string, mailboxId: string, settings: Args<EmailMailboxRepository["updateSettings"]>[2]) {
    this.calls.push("updateSettings");
    const record = await this.findActive(workspaceId, mailboxId);
    return record ? this.update(record, settings) : null;
  }

  async rotateRelayToken(workspaceId: string, mailboxId: string, input: Args<EmailMailboxRepository["rotateRelayToken"]>[2]) {
    const record = await this.findActive(workspaceId, mailboxId);
    return record
      ? this.update(record, {
          previousRelayToken: record.relayToken,
          previousRelayTokenExpiresAt: new Date(this.clock().getTime() + input.graceSeconds * 1000),
          relayToken: input.relayToken,
        })
      : null;
  }

  async startSetupCheck(workspaceId: string, mailboxId: string, step: Args<EmailMailboxRepository["startSetupCheck"]>[2]) {
    const record = await this.findActive(workspaceId, mailboxId);
    return record ? this.update(record, { setupCheckStep: step, setupCheckStartedAt: this.clock() }) : null;
  }

  async recordReceipt(mailboxId: string, input: Args<EmailMailboxRepository["recordReceipt"]>[1]) {
    const record = this.records.get(mailboxId);
    if (!record) return;
    const later = (current: Date | null) =>
      current && current.getTime() > input.receivedAt.getTime() ? current : input.receivedAt;
    this.update(record, {
      lastReceivedAt: later(record.lastReceivedAt),
      ...(input.plusAddressProven ? { plusAddressVerifiedAt: later(record.plusAddressVerifiedAt) } : {}),
    });
  }

  async markRemoved(workspaceId: string, mailboxId: string) {
    const record = await this.findActive(workspaceId, mailboxId);
    return record ? this.update(record, { removedAt: this.clock() }) : null;
  }

  async lockForPolicyChange(workspaceId: string, mailboxId: string) {
    this.calls.push("lockForPolicyChange");
    return this.findActive(workspaceId, mailboxId);
  }

  async appendPolicyVersion(input: Args<EmailMailboxRepository["appendPolicyVersion"]>[0]) {
    this.calls.push("appendPolicyVersion");
    const record = this.records.get(input.mailboxId);
    if (!record || record.removedAt || record.policyVersion !== input.expectedVersion) return null;
    const version = input.expectedVersion + 1;
    this.history.push({
      mailboxId: record.id,
      version,
      engagementMode: input.engagementMode,
      enabled: input.enabled,
      agentId: input.agentId,
      effectiveAt: this.clock(),
      changedByUserId: input.changedByUserId,
    });
    return this.update(record, {
      engagementMode: input.engagementMode,
      enabled: input.enabled,
      agentId: input.agentId,
      policyVersion: version,
    });
  }

  private update(record: EmailMailboxRecord, patch: Partial<EmailMailboxRecord>): EmailMailboxRecord {
    const next = { ...record, ...patch, updatedAt: this.clock() };
    this.records.set(record.id, next);
    return next;
  }
}

/** Runs the work against the in-memory mailboxes; counts the units it ran. */
export const inMemoryPolicyChanges = (mailboxes: InMemoryEmailMailboxes) => {
  const unit = {
    runs: 0,
    run<T>(work: (scope: { mailboxes: InMemoryEmailMailboxes }) => Promise<T>): Promise<T> {
      unit.runs += 1;
      return work({ mailboxes });
    },
  };
  return unit;
};

type InboundEvent = Awaited<ReturnType<EmailInboundRepository["claimDueEvents"]>>[number];
type InboundDelivery = Awaited<ReturnType<EmailInboundRepository["listEventDeliveries"]>>[number];
type FetchedContent = Args<EmailInboundRepository["recordFetched"]>[1];

/** A stored delivery with the content columns the repository never reads back in bulk. */
export interface InMemoryDelivery extends InboundDelivery {
  bodyText: string | null;
  rawMime: Buffer | null;
  rawSizeBytes: number | null;
  rawTruncated: boolean;
}

const RESERVED_STATES: readonly InboundDelivery["state"][] = ["resolved", "ingested", "done"];

/**
 * In-memory `email_inbound_events` and `email_inbound_deliveries`, honouring the dedupe keys, the
 * claim fence and the delivery state machine. Every write is appended to `log` when one is given.
 */
export class InMemoryEmailInbound implements Pick<
  EmailInboundRepository,
  | "insertEvent"
  | "claimDueEvents"
  | "settleEvent"
  | "retryEventLater"
  | "releaseExpiredLeases"
  | "insertDelivery"
  | "listEventDeliveries"
  | "recordFetched"
  | "reserveThread"
  | "settleDropped"
  | "findForwardReservations"
  | "findReverseReferences"
  | "findReservedThreads"
  | "recordIngested"
  | "settleDelivery"
  | "purgeUnattachedBefore"
> {
  readonly events = new Map<string, InboundEvent>();
  readonly deliveries = new Map<string, InMemoryDelivery>();

  constructor(private readonly clock: Clock, private readonly log: string[] = []) {}

  /** A pending event, as the webhook leaves it. */
  seedEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
    const event: InboundEvent = {
      id: randomUUID(),
      provider: "local",
      providerEventId: `msg_${randomUUID()}`,
      eventKind: "message_received",
      providerObjectId: randomUUID(),
      envelope: {},
      state: "pending",
      attempts: 0,
      nextAttemptAt: this.clock(),
      leaseUntil: null,
      lastErrorCode: null,
      receivedAt: this.clock(),
      processedAt: null,
      ...overrides,
    };
    this.events.set(event.id, event);
    return event;
  }

  async insertEvent(input: Args<EmailInboundRepository["insertEvent"]>[0]) {
    const existing = [...this.events.values()].find((event) => event.provider === input.provider
      && (event.providerEventId === input.providerEventId
        || (input.eventKind === "message_received" && input.providerObjectId !== null
          && event.eventKind === "message_received" && event.providerObjectId === input.providerObjectId)));
    if (existing) return { eventId: existing.id, duplicate: true };
    const event = this.seedEvent({ ...input });
    this.log.push("insertEvent");
    return { eventId: event.id, duplicate: false };
  }

  async claimDueEvents(input: { limit: number; leaseSeconds: number }) {
    const now = this.clock().getTime();
    const due = [...this.events.values()]
      .filter((event) => (event.state === "pending" && event.nextAttemptAt.getTime() <= now)
        || (event.state === "processing" && event.leaseUntil !== null && event.leaseUntil.getTime() < now))
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, input.limit);
    return due.map((event) => this.updateEvent(event, {
      state: "processing",
      attempts: event.attempts + 1,
      leaseUntil: new Date(now + input.leaseSeconds * 1000),
    }));
  }

  async settleEvent(eventId: string, input: Args<EmailInboundRepository["settleEvent"]>[1]) {
    const event = this.events.get(eventId);
    if (!event || event.attempts !== input.attempt || event.state !== "processing") return false;
    this.updateEvent(event, { state: input.state, lastErrorCode: input.errorCode, leaseUntil: null, processedAt: this.clock() });
    this.log.push(`settleEvent:${input.state}`);
    return true;
  }

  async retryEventLater(eventId: string, input: Args<EmailInboundRepository["retryEventLater"]>[1]) {
    const event = this.events.get(eventId);
    if (!event || event.attempts !== input.attempt || event.state !== "processing") return false;
    this.updateEvent(event, { state: "pending", nextAttemptAt: input.nextAttemptAt, lastErrorCode: input.errorCode, leaseUntil: null });
    this.log.push("retryEventLater");
    return true;
  }

  async releaseExpiredLeases(limit: number) {
    const now = this.clock().getTime();
    const expired = [...this.events.values()]
      .filter((event) => event.state === "processing" && event.leaseUntil !== null && event.leaseUntil.getTime() < now)
      .slice(0, limit);
    for (const event of expired) this.updateEvent(event, { state: "pending", leaseUntil: null, nextAttemptAt: this.clock() });
    return expired.length;
  }

  async insertDelivery(input: Args<EmailInboundRepository["insertDelivery"]>[0]) {
    const existing = [...this.deliveries.values()]
      .find((delivery) => delivery.inboundEventId === input.inboundEventId && delivery.mailboxId === input.mailboxId);
    if (existing) return { deliveryId: existing.id, duplicate: true };
    const delivery: InMemoryDelivery = {
      id: randomUUID(),
      inboundEventId: input.inboundEventId,
      workspaceId: input.workspaceId,
      mailboxId: input.mailboxId,
      routeRule: input.routeRule,
      acceptedPolicyVersion: input.acceptedPolicyVersion,
      state: input.settled ? "done" : "pending",
      classification: null,
      disposition: input.settled?.disposition ?? null,
      dispositionReason: input.settled?.dispositionReason ?? null,
      senderAddress: null,
      senderDisplayName: null,
      subject: null,
      rfcMessageId: null,
      referenceIds: [],
      ccAddresses: [],
      receivedFor: [],
      threadMatch: null,
      threadConflict: false,
      plannedConversationId: null,
      plannedMessageId: null,
      plannedThreadKey: null,
      plannedThreadToken: null,
      conversationId: null,
      messageId: null,
      lastErrorCode: null,
      createdAt: this.clock(),
      processedAt: input.settled ? this.clock() : null,
      bodyText: null,
      rawMime: null,
      rawSizeBytes: null,
      rawTruncated: false,
    };
    this.deliveries.set(delivery.id, delivery);
    this.log.push("insertDelivery");
    return { deliveryId: delivery.id, duplicate: false };
  }

  async listEventDeliveries(inboundEventId: string) {
    return [...this.deliveries.values()]
      .filter((delivery) => delivery.inboundEventId === inboundEventId)
      .map((delivery) => ({ ...delivery }));
  }

  async recordFetched(deliveryId: string, content: FetchedContent) {
    return this.transition(deliveryId, "pending", "recordFetched", {
      state: "fetched",
      classification: content.classification,
      senderAddress: content.senderAddress,
      senderDisplayName: content.senderDisplayName,
      subject: content.subject,
      rfcMessageId: content.rfcMessageId,
      referenceIds: [...content.referenceIds],
      ccAddresses: [...content.ccAddresses],
      receivedFor: [...content.receivedFor],
      bodyText: content.bodyText,
      rawMime: content.rawMime,
      rawSizeBytes: content.rawSizeBytes,
      rawTruncated: content.rawTruncated,
    });
  }

  async reserveThread(deliveryId: string, reservation: Args<EmailInboundRepository["reserveThread"]>[1]) {
    return this.transition(deliveryId, "fetched", "reserveThread", { state: "resolved", ...reservation });
  }

  async settleDropped(deliveryId: string, drop: Args<EmailInboundRepository["settleDropped"]>[1]) {
    return this.transition(deliveryId, "fetched", "settleDropped", {
      state: "done",
      disposition: "drop",
      dispositionReason: drop.dispositionReason,
      threadMatch: drop.threadMatch,
      threadConflict: drop.threadConflict,
      processedAt: this.clock(),
    });
  }

  async findForwardReservations(mailboxId: string, rfcMessageIds: readonly string[]) {
    return this.reserved(mailboxId)
      .filter((delivery) => delivery.rfcMessageId !== null && rfcMessageIds.includes(delivery.rfcMessageId))
      .map((delivery) => ({
        deliveryId: delivery.id,
        rfcMessageId: delivery.rfcMessageId ?? "",
        conversationId: delivery.conversationId ?? delivery.plannedConversationId ?? "",
        state: delivery.state,
      }));
  }

  async findReverseReferences(mailboxId: string, rfcMessageId: string) {
    return this.reserved(mailboxId)
      .filter((delivery) => delivery.referenceIds.includes(rfcMessageId))
      .map((delivery) => ({
        deliveryId: delivery.id,
        conversationId: delivery.conversationId ?? delivery.plannedConversationId ?? "",
        state: delivery.state,
      }));
  }

  async findReservedThreads(mailboxId: string, conversationIds: readonly string[]) {
    const threads = new Map<string, { threadKey: string; threadToken: string; participantAddress: string }>();
    for (const delivery of this.reserved(mailboxId)) {
      const conversationId = delivery.conversationId ?? delivery.plannedConversationId;
      if (!conversationId || !conversationIds.includes(conversationId) || threads.has(conversationId)) continue;
      if (!delivery.plannedThreadKey || !delivery.plannedThreadToken) continue;
      threads.set(conversationId, {
        threadKey: delivery.plannedThreadKey,
        threadToken: delivery.plannedThreadToken,
        participantAddress: delivery.senderAddress ?? "",
      });
    }
    return threads;
  }

  async recordIngested(deliveryId: string, input: { conversationId: string; messageId: string }) {
    return this.transition(deliveryId, "resolved", "recordIngested", { state: "ingested", ...input });
  }

  async settleDelivery(deliveryId: string, input: { state: "done" | "failed"; errorCode: string | null }) {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery || delivery.state === "done" || delivery.state === "failed") return false;
    this.deliveries.set(deliveryId, { ...delivery, state: input.state, lastErrorCode: input.errorCode, processedAt: this.clock() });
    this.log.push(`settleDelivery:${input.state}`);
    return true;
  }

  async purgeUnattachedBefore(cutoff: Date, limit: number) {
    const deliveries = [...this.deliveries.values()]
      .filter((delivery) => delivery.conversationId === null && delivery.createdAt.getTime() < cutoff.getTime())
      .slice(0, limit);
    for (const delivery of deliveries) this.deliveries.delete(delivery.id);
    const attached = new Set([...this.deliveries.values()].map((delivery) => delivery.inboundEventId));
    const events = [...this.events.values()]
      .filter((event) => ["processed", "ignored", "failed"].includes(event.state)
        && event.receivedAt.getTime() < cutoff.getTime() && !attached.has(event.id))
      .slice(0, limit);
    for (const event of events) this.events.delete(event.id);
    return { deliveries: deliveries.length, events: events.length };
  }

  private reserved(mailboxId: string): InMemoryDelivery[] {
    return [...this.deliveries.values()]
      .filter((delivery) => delivery.mailboxId === mailboxId && RESERVED_STATES.includes(delivery.state));
  }

  private transition(
    deliveryId: string,
    from: InboundDelivery["state"],
    operation: string,
    patch: Partial<InMemoryDelivery>,
  ): boolean {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery || delivery.state !== from) return false;
    this.deliveries.set(deliveryId, { ...delivery, ...patch });
    this.log.push(operation);
    return true;
  }

  private updateEvent(event: InboundEvent, patch: Partial<InboundEvent>): InboundEvent {
    const next = { ...event, ...patch };
    this.events.set(event.id, next);
    return { ...next };
  }
}

type ThreadIndexEntry = Args<EmailThreadRepository["insertIndexEntries"]>[0][number];

/** In-memory `email_thread_links` and `email_thread_messages`. Writes are appended to `log`. */
export class InMemoryEmailThreads implements Pick<
  EmailThreadRepository,
  | "upsertLink"
  | "findLink"
  | "findLinkByThreadToken"
  | "participantsOf"
  | "recordLatestInbound"
  | "insertIndexEntries"
  | "findIndexedConversations"
  | "findOutboundMessageIds"
> {
  readonly links = new Map<string, EmailThreadLinkRecord>();
  readonly index: ThreadIndexEntry[] = [];

  constructor(private readonly log: string[] = []) {}

  async upsertLink(input: Args<EmailThreadRepository["upsertLink"]>[0]) {
    if (!this.links.has(input.conversationId)) {
      this.links.set(input.conversationId, {
        ...input,
        latestSubject: null,
        latestParticipantDisplayName: null,
        latestCcAddresses: [],
        latestInboundAt: null,
        autoSendsSinceRenewal: 0,
        budgetRenewedAt: null,
        reviewRevision: 0,
        reviewCompletedRevision: 0,
        reviewDueAt: null,
        reviewPolicyVersion: null,
      });
    }
    this.log.push("upsertLink");
    return { ...this.links.get(input.conversationId)! };
  }

  async findLink(conversationId: string) {
    return this.links.get(conversationId) ?? null;
  }

  async findLinkByThreadToken(mailboxId: string, threadToken: string) {
    return [...this.links.values()].find((link) => link.mailboxId === mailboxId && link.threadToken === threadToken) ?? null;
  }

  async participantsOf(conversationIds: readonly string[]) {
    return new Map([...this.links.values()]
      .filter((link) => conversationIds.includes(link.conversationId))
      .map((link) => [link.conversationId, link.participantAddress] as const));
  }

  async recordLatestInbound(conversationId: string, input: Args<EmailThreadRepository["recordLatestInbound"]>[1]) {
    const link = this.links.get(conversationId);
    if (!link || (link.latestInboundAt && link.latestInboundAt.getTime() > input.inboundAt.getTime())) return false;
    this.links.set(conversationId, {
      ...link,
      latestSubject: input.subject,
      latestParticipantDisplayName: input.participantDisplayName,
      latestCcAddresses: [...input.ccAddresses],
      latestInboundAt: input.inboundAt,
    });
    return true;
  }

  async insertIndexEntries(entries: readonly ThreadIndexEntry[]) {
    let written = 0;
    for (const entry of entries) {
      if (this.index.some((existing) => existing.mailboxId === entry.mailboxId && existing.rfcMessageId === entry.rfcMessageId)) continue;
      this.index.push(entry);
      written += 1;
    }
    this.log.push("insertIndexEntries");
    return written;
  }

  async findIndexedConversations(mailboxId: string, rfcMessageIds: readonly string[]) {
    return this.index
      .filter((entry) => entry.mailboxId === mailboxId && rfcMessageIds.includes(entry.rfcMessageId))
      .map((entry) => ({ rfcMessageId: entry.rfcMessageId, conversationId: entry.conversationId }));
  }

  async findOutboundMessageIds(mailboxId: string, rfcMessageIds: readonly string[]) {
    return new Set(this.index
      .filter((entry) => entry.mailboxId === mailboxId && entry.direction === "outbound" && rfcMessageIds.includes(entry.rfcMessageId))
      .map((entry) => entry.rfcMessageId));
  }
}
