import { randomUUID } from "node:crypto";

import type { EmailDomainRecord, EmailDomainRepository } from "../../src/modules/emailChannel/persistence/emailDomainRepository.js";
import type {
  EmailMailboxRecord,
  EmailMailboxRepository,
  MailboxPolicyVersion,
} from "../../src/modules/emailChannel/persistence/emailMailboxRepository.js";

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
