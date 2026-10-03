import type { Selectable } from "kysely";

import type { DnsRecordView } from "../../mail/public.js";
import { currentTimestamp, toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { DB, Db } from "../../../shared/infra/kysely/types.js";
import { readEnum, readOptionalEnum } from "./columnValues.js";

export type DomainSendingStatus = "pending" | "verified" | "failed";
export type DomainReceivingStatus = "not_requested" | "pending" | "verified" | "failed";
type ProviderCleanupStatus = "pending" | "done" | "failed";

const SENDING_STATUSES: readonly DomainSendingStatus[] = ["pending", "verified", "failed"];
const RECEIVING_STATUSES: readonly DomainReceivingStatus[] = ["not_requested", "pending", "verified", "failed"];
const CLEANUP_STATUSES: readonly ProviderCleanupStatus[] = ["pending", "done", "failed"];
const RECORD_PURPOSES: readonly DnsRecordView["purpose"][] = ["dkim", "spf", "return_path", "receiving_mx", "dmarc"];
const RECORD_TYPES: readonly DnsRecordView["type"][] = ["TXT", "MX", "CNAME"];
const RECORD_STATUSES: readonly DnsRecordView["status"][] = ["pending", "verified", "failed", "advisory"];

export interface EmailDomainRecord {
  id: string;
  workspaceId: string;
  /** Lowercase IDNA A-label. */
  domain: string;
  provider: string;
  providerDomainId: string | null;
  providerRegion: string | null;
  dnsRecords: readonly DnsRecordView[];
  sendingStatus: DomainSendingStatus;
  receivingStatus: DomainReceivingStatus;
  receivingConfirmedByUserId: string | null;
  receivingConfirmedAt: Date | null;
  lastCheckedAt: Date | null;
  nextCheckAt: Date | null;
  statusChangedAt: Date | null;
  removedAt: Date | null;
  providerCleanupStatus: ProviderCleanupStatus | null;
  createdByUserId: string | null;
  createdAt: Date;
}

interface InsertEmailDomainInput {
  workspaceId: string;
  domain: string;
  provider: string;
  providerDomainId: string;
  providerRegion: string | null;
  dnsRecords: readonly DnsRecordView[];
  sendingStatus: DomainSendingStatus;
  receivingStatus: DomainReceivingStatus;
  nextCheckAt: Date;
  createdByUserId: string | null;
}

interface DomainReadinessWrite {
  sendingStatus: DomainSendingStatus;
  receivingStatus: DomainReceivingStatus;
  dnsRecords: readonly DnsRecordView[];
  nextCheckAt: Date;
  /** Whether either capability's status differs from the stored one. */
  statusChanged: boolean;
}

type DomainRow = Selectable<DB["email_domains"]>;

const isRecordObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readDnsRecord = (value: unknown): DnsRecordView | null => {
  if (!isRecordObject(value)) return null;
  const { purpose, type, name, value: recordValue, priority, status } = value;
  if (
    typeof purpose !== "string" || !(RECORD_PURPOSES as readonly string[]).includes(purpose)
    || typeof type !== "string" || !(RECORD_TYPES as readonly string[]).includes(type)
    || typeof name !== "string" || typeof recordValue !== "string"
    || typeof status !== "string" || !(RECORD_STATUSES as readonly string[]).includes(status)
  ) {
    return null;
  }
  return {
    purpose: purpose as DnsRecordView["purpose"],
    type: type as DnsRecordView["type"],
    name,
    value: recordValue,
    ...(typeof priority === "number" ? { priority } : {}),
    status: status as DnsRecordView["status"],
  };
};

const readDnsRecords = (value: unknown): DnsRecordView[] =>
  Array.isArray(value) ? value.map(readDnsRecord).filter((record): record is DnsRecordView => record !== null) : [];

const mapDomain = (row: DomainRow): EmailDomainRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  domain: row.domain,
  provider: row.provider,
  providerDomainId: row.provider_domain_id,
  providerRegion: row.provider_region,
  dnsRecords: readDnsRecords(row.dns_records),
  sendingStatus: readEnum(row.sending_status, SENDING_STATUSES, "email_domains.sending_status"),
  receivingStatus: readEnum(row.receiving_status, RECEIVING_STATUSES, "email_domains.receiving_status"),
  receivingConfirmedByUserId: row.receiving_confirmed_by_user_id,
  receivingConfirmedAt: row.receiving_confirmed_at,
  lastCheckedAt: row.last_checked_at,
  nextCheckAt: row.next_check_at,
  statusChangedAt: row.status_changed_at,
  removedAt: row.removed_at,
  providerCleanupStatus: readOptionalEnum(row.provider_cleanup_status, CLEANUP_STATUSES, "email_domains.provider_cleanup_status"),
  createdByUserId: row.created_by_user_id,
  createdAt: row.created_at,
});

/** Sending (and direct-receiving) domains. A removed domain keeps its row for history. */
export class EmailDomainRepository {
  constructor(private readonly db: Db) {}

  /** Null when the domain is already active, in this workspace or another. */
  async insertActive(input: InsertEmailDomainInput): Promise<EmailDomainRecord | null> {
    const row = await this.db
      .insertInto("email_domains")
      .values({
        workspace_id: input.workspaceId,
        domain: input.domain,
        provider: input.provider,
        provider_domain_id: input.providerDomainId,
        provider_region: input.providerRegion,
        dns_records: toJsonb(input.dnsRecords),
        sending_status: input.sendingStatus,
        receiving_status: input.receivingStatus,
        last_checked_at: currentTimestamp(),
        next_check_at: input.nextCheckAt,
        status_changed_at: currentTimestamp(),
        created_by_user_id: input.createdByUserId,
      })
      .onConflict((oc) => oc.column("domain").where("removed_at", "is", null).doNothing())
      .returningAll()
      .executeTakeFirst();
    return row ? mapDomain(row) : null;
  }

  async findActiveByDomain(domain: string): Promise<EmailDomainRecord | null> {
    const row = await this.db
      .selectFrom("email_domains")
      .selectAll()
      .where("domain", "=", domain)
      .where("removed_at", "is", null)
      .executeTakeFirst();
    return row ? mapDomain(row) : null;
  }

  async findActive(workspaceId: string, domainId: string): Promise<EmailDomainRecord | null> {
    const row = await this.db
      .selectFrom("email_domains")
      .selectAll()
      .where("id", "=", domainId)
      .where("workspace_id", "=", workspaceId)
      .where("removed_at", "is", null)
      .executeTakeFirst();
    return row ? mapDomain(row) : null;
  }

  /** Any domain, removed or not: history and conversation facts still name it. */
  async findById(domainId: string): Promise<EmailDomainRecord | null> {
    const row = await this.db.selectFrom("email_domains").selectAll().where("id", "=", domainId).executeTakeFirst();
    return row ? mapDomain(row) : null;
  }

  async listActive(workspaceId: string): Promise<EmailDomainRecord[]> {
    const rows = await this.db
      .selectFrom("email_domains")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("removed_at", "is", null)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    return rows.map(mapDomain);
  }

  /** The direct-receiving rule's lookup: an active domain whose receiving status is verified. */
  async findReceivingVerified(domain: string): Promise<{ workspaceId: string } | null> {
    const row = await this.db
      .selectFrom("email_domains")
      .select("workspace_id")
      .where("domain", "=", domain)
      .where("receiving_status", "=", "verified")
      .where("removed_at", "is", null)
      .executeTakeFirst();
    return row ? { workspaceId: row.workspace_id } : null;
  }

  /** Active domains whose readiness refresh is due by the database clock. */
  async listDueForRefresh(limit: number): Promise<EmailDomainRecord[]> {
    const rows = await this.db
      .selectFrom("email_domains")
      .selectAll()
      .where("removed_at", "is", null)
      .where("next_check_at", "<=", currentTimestamp())
      .orderBy("next_check_at", "asc")
      .limit(limit)
      .execute();
    return rows.map(mapDomain);
  }

  async recordReadiness(domainId: string, readiness: DomainReadinessWrite): Promise<EmailDomainRecord | null> {
    const row = await this.db
      .updateTable("email_domains")
      .set({
        sending_status: readiness.sendingStatus,
        receiving_status: readiness.receivingStatus,
        dns_records: toJsonb(readiness.dnsRecords),
        last_checked_at: currentTimestamp(),
        next_check_at: readiness.nextCheckAt,
        ...(readiness.statusChanged ? { status_changed_at: currentTimestamp() } : {}),
        updated_at: currentTimestamp(),
      })
      .where("id", "=", domainId)
      .where("removed_at", "is", null)
      .returningAll()
      .executeTakeFirst();
    return row ? mapDomain(row) : null;
  }

  /** Pushes the next refresh out without touching readiness, after a provider call failed. */
  async deferRefresh(domainId: string, nextCheckAt: Date): Promise<void> {
    await this.db
      .updateTable("email_domains")
      .set({ next_check_at: nextCheckAt, updated_at: currentTimestamp() })
      .where("id", "=", domainId)
      .where("removed_at", "is", null)
      .execute();
  }

  /** The typed confirmation for direct receiving (FR-006a), with the readiness it produced. */
  async confirmReceiving(
    domainId: string,
    input: { confirmedByUserId: string | null; readiness: DomainReadinessWrite },
  ): Promise<EmailDomainRecord | null> {
    const row = await this.db
      .updateTable("email_domains")
      .set({
        receiving_confirmed_by_user_id: input.confirmedByUserId,
        receiving_confirmed_at: currentTimestamp(),
        sending_status: input.readiness.sendingStatus,
        receiving_status: input.readiness.receivingStatus,
        dns_records: toJsonb(input.readiness.dnsRecords),
        last_checked_at: currentTimestamp(),
        next_check_at: input.readiness.nextCheckAt,
        ...(input.readiness.statusChanged ? { status_changed_at: currentTimestamp() } : {}),
        updated_at: currentTimestamp(),
      })
      .where("id", "=", domainId)
      .where("removed_at", "is", null)
      .returningAll()
      .executeTakeFirst();
    return row ? mapDomain(row) : null;
  }

  /**
   * Revokes the domain's authority at once (FR-006b): every lookup filters removed rows. The
   * provider-side cleanup is left pending for the sweep, due immediately.
   */
  async markRemoved(workspaceId: string, domainId: string): Promise<EmailDomainRecord | null> {
    const row = await this.db
      .updateTable("email_domains")
      .set({
        removed_at: currentTimestamp(),
        provider_cleanup_status: "pending",
        next_check_at: currentTimestamp(),
        updated_at: currentTimestamp(),
      })
      .where("id", "=", domainId)
      .where("workspace_id", "=", workspaceId)
      .where("removed_at", "is", null)
      .returningAll()
      .executeTakeFirst();
    return row ? mapDomain(row) : null;
  }

  /** Removed domains whose provider cleanup is pending, or failed and due for another try. */
  async listCleanupDue(limit: number): Promise<EmailDomainRecord[]> {
    const rows = await this.db
      .selectFrom("email_domains")
      .selectAll()
      .where("removed_at", "is not", null)
      .where("provider_cleanup_status", "in", ["pending", "failed"])
      .where((eb) => eb.or([eb("next_check_at", "is", null), eb("next_check_at", "<=", currentTimestamp())]))
      .orderBy("removed_at", "asc")
      .limit(limit)
      .execute();
    return rows.map(mapDomain);
  }

  async recordCleanup(domainId: string, outcome: { status: "done" | "failed"; retryAt: Date | null }): Promise<void> {
    await this.db
      .updateTable("email_domains")
      .set({ provider_cleanup_status: outcome.status, next_check_at: outcome.retryAt, updated_at: currentTimestamp() })
      .where("id", "=", domainId)
      .where("removed_at", "is not", null)
      .execute();
  }
}
