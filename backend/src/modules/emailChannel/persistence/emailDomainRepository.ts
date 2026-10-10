import { sql, type Selectable } from "kysely";

import type { DnsRecordView } from "../../mail/public.js";
import { currentTimestamp, toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { DB, Db } from "../../../shared/infra/kysely/types.js";
import { readEnum, readOptionalEnum } from "./columnValues.js";

export type DomainRegistrationStatus = "registering" | "needs_reconciliation" | "registered";
export type DomainSendingStatus = "pending" | "verified" | "failed";
export type DomainReceivingStatus = "not_requested" | "pending" | "verified" | "failed";
type ProviderCleanupStatus = "pending" | "done" | "failed";

const REGISTRATION_STATUSES: readonly DomainRegistrationStatus[] = ["registering", "needs_reconciliation", "registered"];
const SENDING_STATUSES: readonly DomainSendingStatus[] = ["pending", "verified", "failed"];
const RECEIVING_STATUSES: readonly DomainReceivingStatus[] = ["not_requested", "pending", "verified", "failed"];
const CLEANUP_STATUSES: readonly ProviderCleanupStatus[] = ["pending", "done", "failed"];
/** A removed domain whose provider cleanup has not finished: its name is still being removed. */
const REMOVING_CLEANUP_STATUSES: readonly ProviderCleanupStatus[] = ["pending", "failed"];
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
  registrationStatus: DomainRegistrationStatus;
  dnsRecords: readonly DnsRecordView[];
  sendingStatus: DomainSendingStatus;
  receivingStatus: DomainReceivingStatus;
  receivingConfirmedByUserId: string | null;
  receivingConfirmedAt: Date | null;
  lastCheckedAt: Date | null;
  nextCheckAt: Date | null;
  statusChangedAt: Date | null;
  /** Bumped by each provider event about the domain; a refresh acknowledges only the version it read. */
  refreshRequestedVersion: number;
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

/** Who holds a domain once a claim is attempted, or that a removal of the name is still being cleaned up. */
type DomainClaim = { status: "held"; domain: EmailDomainRecord } | { status: "removal_pending" };

/** An operator's adoption of the provider's registration on a claim waiting for reconciliation. */
type DomainAdoption =
  | { status: "adopted"; domain: EmailDomainRecord }
  | { status: "removal_pending" }
  | { status: "not_awaiting" };

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
  /** The `refreshRequestedVersion` the domain had when the provider was read. */
  requestedVersion: number;
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
  registrationStatus: readEnum(row.registration_status, REGISTRATION_STATUSES, "email_domains.registration_status"),
  dnsRecords: readDnsRecords(row.dns_records),
  sendingStatus: readEnum(row.sending_status, SENDING_STATUSES, "email_domains.sending_status"),
  receivingStatus: readEnum(row.receiving_status, RECEIVING_STATUSES, "email_domains.receiving_status"),
  receivingConfirmedByUserId: row.receiving_confirmed_by_user_id,
  receivingConfirmedAt: row.receiving_confirmed_at,
  lastCheckedAt: row.last_checked_at,
  nextCheckAt: row.next_check_at,
  statusChangedAt: row.status_changed_at,
  refreshRequestedVersion: row.refresh_requested_version,
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
 * domain, but no provider registration is recorded for it yet (`registering`), or the provider
 * already holds the name and only an operator's reconcile adopts that registration
 * (`needs_reconciliation`). The claim is taken before the provider is called, so no other
 * workspace can register the name meanwhile.
 *
 * A removed row whose provider cleanup is `pending` or `failed` is a removal still being cleaned
 * up. While one exists, its name can be neither claimed nor adopted: `claim` and
 * `adoptRegistration` lock the name's active and removing rows and check that state, so an
 * adoption never records a registration the cleanup is about to delete.
 */
export class EmailDomainRepository {
  constructor(private readonly db: Db) {}

  /**
   * A new registration claim for `workspaceId`, or the active row, claimed or registered, that
   * already holds `domain` in this workspace or another. `removal_pending` while a removal of the
   * name is still being cleaned up at the provider.
   */
  async claim(input: ClaimEmailDomainInput): Promise<DomainClaim> {
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      const settled = await this.inTransaction(async (trx): Promise<DomainClaim | null> => {
        const rows = await lockDomainName(trx, input.domain);
        const holder = rows.find((row) => row.removed_at === null);
        if (holder) return { status: "held", domain: mapDomain(holder) };
        if (rows.length > 0) return { status: "removal_pending" };
        const claimed = await trx
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
        return claimed ? { status: "held", domain: mapDomain(claimed) } : null;
      });
      if (settled) return settled;
    }
    throw new Error("The email domain claim did not settle");
  }

  /**
   * Records the registration a create on this claim returned. Null unless the row is still an
   * active claim, in either unfinished status: a create's own answer needs no reconciliation.
   */
  async recordRegistration(domainId: string, registration: DomainRegistrationWrite): Promise<EmailDomainRecord | null> {
    const row = await this.db
      .updateTable("email_domains")
      .set(registrationColumns(registration))
      .where("id", "=", domainId)
      .where("provider_domain_id", "is", null)
      .where("removed_at", "is", null)
      .returningAll()
      .executeTakeFirst();
    return row ? mapDomain(row) : null;
  }

  /** The provider already holds the claimed name. Null unless the row is still a `registering` claim. */
  async markNeedsReconciliation(domainId: string): Promise<EmailDomainRecord | null> {
    const row = await this.db
      .updateTable("email_domains")
      .set({ registration_status: "needs_reconciliation", updated_at: currentTimestamp() })
      .where("id", "=", domainId)
      .where("registration_status", "=", "registering")
      .where("removed_at", "is", null)
      .returningAll()
      .executeTakeFirst();
    return row ? mapDomain(row) : null;
  }

  /** Whether a removal of `domain` is still being cleaned up at the provider. */
  async isRemovalPending(domain: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("email_domains")
      .select("id")
      .where("domain", "=", domain)
      .where("provider_cleanup_status", "in", REMOVING_CLEANUP_STATUSES)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * An operator's reconcile: records the provider's existing registration on a claim waiting for
   * reconciliation. Refused while a removal of the name is still being cleaned up, checked under
   * the name's row locks, so the registration adopted is never one that cleanup deletes.
   */
  async adoptRegistration(domainId: string, registration: DomainRegistrationWrite): Promise<DomainAdoption> {
    return this.inTransaction(async (trx): Promise<DomainAdoption> => {
      const claim = await trx.selectFrom("email_domains").select("domain").where("id", "=", domainId).executeTakeFirst();
      if (!claim) return { status: "not_awaiting" };
      const rows = await lockDomainName(trx, claim.domain);
      if (rows.some((row) => row.removed_at !== null)) return { status: "removal_pending" };
      const row = await trx
        .updateTable("email_domains")
        .set(registrationColumns(registration))
        .where("id", "=", domainId)
        .where("registration_status", "=", "needs_reconciliation")
        .where("removed_at", "is", null)
        .returningAll()
        .executeTakeFirst();
      return row ? { status: "adopted", domain: mapDomain(row) } : { status: "not_awaiting" };
    });
  }

  /**
   * A create answered after its claim was removed: the registration is this claim's own, so it is
   * handed to the claim's cleanup. False once that cleanup has finished, which leaves the
   * registration to be reconciled when the name is added again.
   */
  async recordRemovedClaimRegistration(
    domainId: string,
    registration: { providerDomainId: string; providerRegion: string | null },
  ): Promise<boolean> {
    const result = await this.db
      .updateTable("email_domains")
      .set({
        provider_domain_id: registration.providerDomainId,
        provider_region: registration.providerRegion,
        registration_status: "registered",
        provider_cleanup_status: "pending",
        next_check_at: currentTimestamp(),
        updated_at: currentTimestamp(),
      })
      .where("id", "=", domainId)
      .where("provider_domain_id", "is", null)
      .where("removed_at", "is not", null)
      .where("provider_cleanup_status", "in", REMOVING_CLEANUP_STATUSES)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
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
        registration_status: "registered",
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

  /**
   * Locks the domain row `FOR SHARE`, removed or not, for the rest of the caller's transaction: a
   * send's commitment reads its sending readiness under it, so a readiness refresh or a removal
   * either committed first, and is read here, or waits until the send has frozen.
   */
  async lockForSend(domainId: string): Promise<EmailDomainRecord | null> {
    const row = await this.db.selectFrom("email_domains").selectAll().where("id", "=", domainId).forShare().executeTakeFirst();
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

  /**
   * Records a refresh's reading. Null when the domain was removed, or when a provider event arrived
   * after the read: that newer request stays due, and the next refresh reads past it.
   */
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
      .where("refresh_requested_version", "=", readiness.requestedVersion)
      .returningAll()
      .executeTakeFirst();
    return row ? mapDomain(row) : null;
  }

  /**
   * Pushes the next refresh out without touching readiness, after a provider call failed. A
   * provider event since `requestedVersion` keeps the domain due instead.
   */
  async deferRefresh(domainId: string, nextCheckAt: Date, requestedVersion: number): Promise<void> {
    await this.db
      .updateTable("email_domains")
      .set({ next_check_at: nextCheckAt, updated_at: currentTimestamp() })
      .where("id", "=", domainId)
      .where("removed_at", "is", null)
      .where("refresh_requested_version", "=", requestedVersion)
      .execute();
  }

  /**
   * A provider's domain event (FR-003): the active domain registered under `providerDomainId` falls
   * due for its readiness refresh now, and its request version moves on, so a refresh already
   * reading the provider leaves this request in place. False when no active domain holds that
   * registration.
   */
  async expediteRefresh(input: { provider: string; providerDomainId: string }): Promise<boolean> {
    const result = await this.db
      .updateTable("email_domains")
      .set((eb) => ({
        next_check_at: currentTimestamp(),
        refresh_requested_version: eb("refresh_requested_version", "+", 1),
        updated_at: currentTimestamp(),
      }))
      .where("provider", "=", input.provider)
      .where("provider_domain_id", "=", input.providerDomainId)
      .where("removed_at", "is", null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * The typed confirmation for direct receiving (FR-006a), with the readiness it produced. The
   * confirmation always lands; a provider event since the read keeps the domain due.
   */
  async confirmReceiving(
    domainId: string,
    input: { confirmedByUserId: string | null; readiness: DomainReadinessWrite },
  ): Promise<EmailDomainRecord | null> {
    const { readiness } = input;
    const row = await this.db
      .updateTable("email_domains")
      .set({
        receiving_confirmed_by_user_id: input.confirmedByUserId,
        receiving_confirmed_at: currentTimestamp(),
        sending_status: readiness.sendingStatus,
        receiving_status: readiness.receivingStatus,
        dns_records: toJsonb(readiness.dnsRecords),
        last_checked_at: currentTimestamp(),
        next_check_at: sql<Date>`CASE WHEN refresh_requested_version = ${readiness.requestedVersion} THEN ${readiness.nextCheckAt} ELSE now() END`,
        ...(readiness.statusChanged ? { status_changed_at: currentTimestamp() } : {}),
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
   * provider-side cleanup is left pending for the sweep, due immediately. A claim is removed the
   * same way, with no provider call.
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
      .where("provider_cleanup_status", "in", REMOVING_CLEANUP_STATUSES)
      .where((eb) => eb.or([eb("next_check_at", "is", null), eb("next_check_at", "<=", currentTimestamp())]))
      .orderBy("removed_at", "asc")
      .limit(limit)
      .execute();
    return rows.map(mapDomain);
  }

  /**
   * Settles one cleanup attempt of the registration `providerDomainId` (null: there was none to
   * remove). `done` is final. An attempt is ignored once the cleanup finished, or once a late
   * registration was handed to the row after the attempt read it.
   */
  async recordCleanup(
    domainId: string,
    outcome: { status: "done" | "failed"; retryAt: Date | null; providerDomainId: string | null },
  ): Promise<void> {
    await this.db
      .updateTable("email_domains")
      .set({ provider_cleanup_status: outcome.status, next_check_at: outcome.retryAt, updated_at: currentTimestamp() })
      .where("id", "=", domainId)
      .where("removed_at", "is not", null)
      .where("provider_cleanup_status", "in", REMOVING_CLEANUP_STATUSES)
      .where((eb) => outcome.providerDomainId === null
        ? eb("provider_domain_id", "is", null)
        : eb("provider_domain_id", "=", outcome.providerDomainId))
      .execute();
  }

  private inTransaction<T>(work: (trx: Db) => Promise<T>): Promise<T> {
    return this.db.isTransaction ? work(this.db) : this.db.transaction().execute(work);
  }
}

const registrationColumns = (registration: DomainRegistrationWrite) => ({
  provider_domain_id: registration.providerDomainId,
  provider_region: registration.providerRegion,
  registration_status: "registered",
  dns_records: toJsonb(registration.dnsRecords),
  sending_status: registration.sendingStatus,
  receiving_status: registration.receivingStatus,
  last_checked_at: currentTimestamp(),
  next_check_at: registration.nextCheckAt,
  status_changed_at: currentTimestamp(),
  updated_at: currentTimestamp(),
});

/**
 * Locks, until the transaction ends, the rows that decide whether `domain` may be claimed or
 * adopted: its active row and any removal of it still being cleaned up.
 */
const lockDomainName = (trx: Db, domain: string): Promise<DomainRow[]> =>
  trx
    .selectFrom("email_domains")
    .selectAll()
    .where("domain", "=", domain)
    .where((eb) => eb.or([eb("removed_at", "is", null), eb("provider_cleanup_status", "in", REMOVING_CLEANUP_STATUSES)]))
    .orderBy("id")
    .forUpdate()
    .execute();
