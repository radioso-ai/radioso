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

interface ClaimEmailDomainInput {
  workspaceId: string;
  domain: string;
  provider: string;
  createdByUserId: string | null;
}

/** What the provider reported for a claimed domain once it holds the registration. */
interface DomainRegistrationWrite {
  providerDomainId: string;
  providerRegion: string | null;
  dnsRecords: readonly DnsRecordView[];
  sendingStatus: DomainSendingStatus;
  receivingStatus: DomainReceivingStatus;
  nextCheckAt: Date;
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

/** A claim can lose a race to another claim and then to that claim's removal; each try settles one. */
const CLAIM_ATTEMPTS = 3;

/**
 * Sending (and direct-receiving) domains. A removed domain keeps its row for history.
 *
 * An active row with no `provider_domain_id` is a registration claim: the workspace holds the
 * domain, but the provider's answer for it has not been recorded yet. The claim is taken before
 * the provider is called, so an answer lost on the way back can be recovered by the same
 * workspace, and by no other.
 */
export class EmailDomainRepository {
  constructor(private readonly db: Db) {}

  /**
   * The active row holding `domain`: a new registration claim for `workspaceId`, or the row,
   * claimed or registered, that already holds it in this workspace or another.
   */
  async claim(input: ClaimEmailDomainInput): Promise<EmailDomainRecord> {
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      const claimed = await this.db
        .insertInto("email_domains")
        .values({
          workspace_id: input.workspaceId,
          domain: input.domain,
          provider: input.provider,
          created_by_user_id: input.createdByUserId,
        })
        .onConflict((oc) => oc.column("domain").where("removed_at", "is", null).doNothing())
        .returningAll()
        .executeTakeFirst();
      if (claimed) return mapDomain(claimed);
      const holder = await this.findActiveByDomain(input.domain);
      if (holder) return holder;
    }
    throw new Error("The email domain claim did not settle");
  }

  /** Records the provider's registration on a claim. Null unless the row is still an active claim. */
  async recordRegistration(domainId: string, registration: DomainRegistrationWrite): Promise<EmailDomainRecord | null> {
    const row = await this.db
      .updateTable("email_domains")
      .set({
        provider_domain_id: registration.providerDomainId,
        provider_region: registration.providerRegion,
        dns_records: toJsonb(registration.dnsRecords),
        sending_status: registration.sendingStatus,
        receiving_status: registration.receivingStatus,
        last_checked_at: currentTimestamp(),
        next_check_at: registration.nextCheckAt,
        status_changed_at: currentTimestamp(),
        updated_at: currentTimestamp(),
      })
      .where("id", "=", domainId)
      .where("provider_domain_id", "is", null)
      .where("removed_at", "is", null)
      .returningAll()
      .executeTakeFirst();
    return row ? mapDomain(row) : null;
  }

  /** Drops a claim the provider will not register. Nothing references a claim, so it leaves no history. */
  async releaseClaim(domainId: string): Promise<void> {
    await this.db
      .deleteFrom("email_domains")
      .where("id", "=", domainId)
      .where("provider_domain_id", "is", null)
      .where("removed_at", "is", null)
      .execute();
  }

  /** Whether an active row holds this provider registration, as one that adopted it does. */
  async isProviderDomainActive(provider: string, providerDomainId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("email_domains")
      .select("id")
      .where("provider", "=", provider)
      .where("provider_domain_id", "=", providerDomainId)
      .where("removed_at", "is", null)
      .executeTakeFirst();
    return row !== undefined;
  }

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

  /**
   * A provider's domain event (FR-003): the active domain registered under `providerDomainId` falls
   * due for its readiness refresh now, so the sweep's refresh records any transition and retries a
   * failed read. False when no active domain holds that registration.
   */
  async expediteRefresh(input: { provider: string; providerDomainId: string }): Promise<boolean> {
    const result = await this.db
      .updateTable("email_domains")
      .set({ next_check_at: currentTimestamp(), updated_at: currentTimestamp() })
      .where("provider", "=", input.provider)
      .where("provider_domain_id", "=", input.providerDomainId)
      .where("removed_at", "is", null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
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
