import type { BoundedJsonRecord, StorageFieldType } from "@radioso/app-contract";

import type { AppStorageIndexEntry, AppStorageIndexColumn } from "../domain/indexEntries.js";
import type { AppStorageCollectionUsage } from "../domain/quota.js";
import type { AppStorageAuditEvent, AppStorageAuditIntent } from "./appStorageAudit.js";

/**
 * Both identifiers travel together because neither alone names an installation's
 * data. Every statement the repository issues carries both, and every operation
 * also locks the installation's state row: the scoped predicate is what keeps one
 * installation's rows out of another's result, and the state row is what keeps an
 * operation from committing across the revocation or deletion that outranks it.
 */
export interface AppStorageInstallationScope {
  workspaceId: string;
  installationId: string;
}

export interface AppStorageCollectionScope extends AppStorageInstallationScope {
  collectionId: string;
}

/**
 * A transaction the repository opened, passed back to it by a caller that needs
 * one of its operations to commit with work of its own. It is opaque on purpose:
 * the port describes what may share a transaction, and the persistence library
 * that provides it stays behind the port.
 */
export interface AppStorageTransactionHandle {
  readonly appStorageTransaction: unique symbol;
}

export interface AppStorageInstallationDeletion {
  recordCount: number;
  collectionCount: number;
}

export interface AppStorageInstallationState {
  accessRevokedAt: Date | null;
  retainUntil: Date | null;
  /** Set by installation deletion and cleared only by workspace deletion. */
  deletedAt: Date | null;
  /** What the deletion removed, kept so a repeated deletion answers the same way. */
  deletionSummary: AppStorageInstallationDeletion | null;
}

/**
 * The answer to "was this operation still allowed at the point it would have
 * taken effect". It is not a return code the caller may skip: admission is
 * decided inside the operation's own transaction, holding the state row, so a
 * revocation cannot land between the check and the write.
 */
export type AppStorageAdmitted<TValue> = { admitted: true; value: TValue } | { admitted: false };

/**
 * What a change to the App's storage access did. Restoring access is refused
 * while a retention hold stands: the hold is a promise that the data stops
 * existing at a named instant, and an App reading and writing data scheduled for
 * destruction is the state the promise exists to prevent. Cancelling the hold is
 * the operator's own explicit step.
 */
export type AppStorageAccessTransition =
  | { outcome: "applied" }
  | { outcome: "retention_active"; retainUntil: Date };

export interface StoredAppStorageRecord {
  key: string;
  version: number;
  schemaVersion: number;
  updatedAt: Date;
  value: BoundedJsonRecord;
}

/** A declared index, in the shape both a write and a rebuild derive an entry from. */
export interface AppStorageIndexDescriptor {
  id: string;
  field: string;
  fieldType: StorageFieldType;
}

export interface AppStoragePutCommand {
  scope: AppStorageCollectionScope;
  key: string;
  value: BoundedJsonRecord;
  byteSize: number;
  schemaVersion: number;
  /**
   * The interval, not a deadline. A write can wait on a lock for an unbounded
   * time, so the deadline is computed from the database clock read after the
   * write's own locks are held rather than from a clock the caller read before it
   * queued.
   */
  ttlSeconds: number | null;
  expectedVersion: number | null;
  indexEntries: readonly AppStorageIndexEntry[];
  /**
   * The record-count ceiling the collection declares. The check has to happen
   * inside the write's own transaction, or two concurrent puts each read a
   * count below the ceiling and both commit. It also bounds the exact live count
   * a write falls back to when reclamation could not finish.
   */
  maxRecords: number;
}

export type AppStoragePutOutcome =
  | { outcome: "stored"; version: number }
  | { outcome: "version_conflict" }
  | { outcome: "not_found" }
  | { outcome: "quota_exceeded" }
  /** The collection's version counter reached the last value a JSON number carries exactly. */
  | { outcome: "version_exhausted" };

export interface AppStorageDeleteCommand {
  scope: AppStorageCollectionScope;
  key: string;
  expectedVersion: number | null;
}

export type AppStorageDeleteOutcome =
  | { outcome: "deleted" }
  | { outcome: "missing" }
  | { outcome: "not_found" }
  | { outcome: "version_conflict" };

export interface AppStorageQuery {
  scope: AppStorageCollectionScope;
  indexId: string;
  column: AppStorageIndexColumn;
  value: string | number | boolean | Date;
  /** Callers read one past the page they intend to return, to learn whether another page exists. */
  limit: number;
  cursor: string | null;
}

/**
 * What a collection holds, and whether reclaiming it is finished. A read gives
 * back a bounded batch of expired rows rather than the whole expired population,
 * so `reclaimPending` is how an operator learns the counters are still ahead of
 * the rows and the sweep has work left.
 */
export interface AppStorageLiveUsage extends AppStorageCollectionUsage {
  reclaimPending: boolean;
}

/** One batch of an index rebuild: the records after `after`, in key order. */
export interface AppStorageIndexRebuildBatch {
  scope: AppStorageCollectionScope;
  index: AppStorageIndexDescriptor;
  after: string | null;
  limit: number;
  /**
   * The convergence pass' filter. A rebuild marks the index pending before its
   * first batch, so every write from that point maintains it; the pass that
   * closes the rebuild revisits only records written since, which are exactly the
   * ones carrying a version at or above the marker.
   */
  minVersion: number | null;
}

export interface AppStorageIndexRebuildProgress {
  rebuiltCount: number;
  lastKey: string | null;
  /**
   * The keys this batch looked at, and the ones whose stored value is past what
   * the index can hold. A field that was not indexed when it was written was
   * never bounded, so the rebuild reports which records carry such a value and
   * leaves them out rather than letting the database refuse the batch.
   *
   * They are keys rather than a count because a count accumulates history: a
   * record that was too long in the first pass and was corrected before the
   * convergence pass would still be charged against the rebuild. Keys let the
   * caller keep the latest observation of each record and judge current state.
   */
  visitedKeys: string[];
  incompatibleKeys: string[];
}

export interface AppStorageIndexRebuildStart {
  /** The collection's next version at the moment the index became pending. */
  startVersion: number;
  /**
   * This rebuild's identity. Finishing and cancelling are compare-and-set against
   * it, so a second rebuild of the same index cannot clear the marker the first
   * one is still scanning under, and a stale run cannot undo a newer one.
   */
  generation: number;
}

/**
 * Whether the rebuild that asked is still the one the marker belongs to.
 * `finished` carries the token an activation later presents to clear the marker
 * inside its own transaction; `stale` means another rebuild took over and this
 * run has nothing to finish.
 */
export type AppStorageIndexRebuildFinish =
  | { outcome: "finished"; completionToken: string }
  | { outcome: "stale" };

export type AppStorageIndexRebuildCancel = { outcome: "cancelled" } | { outcome: "stale" };

/** Clearing a finished rebuild's marker, as the activation that owns it sees it. */
export type AppStorageIndexRebuildCompletion = { outcome: "completed" } | { outcome: "stale" };

export interface ExportedAppStorageRecord extends StoredAppStorageRecord {
  collectionId: string;
}

/**
 * An admitted export, and the transaction it has not opened yet.
 *
 * Admission opens nothing. A snapshot whose transaction began at admission would
 * be a transaction held open by a caller that never read from it — an abandoned
 * export would pin an MVCC snapshot and a pooled connection indefinitely. So the
 * repeatable-read transaction opens on the first read, the state row is read
 * again inside it, and the expiry cutoff is taken immediately after that read and
 * reused for every page, so no row is judged live by one clock and excluded by a
 * later one.
 *
 * `close` is the caller's; the idle timeout is the snapshot's own. A consumer
 * that stalled between pages, or one that was admitted and never read, is aborted
 * rather than left holding a connection.
 */
export interface AppStorageExportSnapshot {
  read(): AsyncIterable<ExportedAppStorageRecord>;
  close(): Promise<void>;
}

export type AppStorageRetentionReclaim =
  | { outcome: "reclaimed"; summary: AppStorageInstallationDeletion }
  /** The deadline moved or was lifted between the listing and the lock. */
  | { outcome: "not_due" }
  | { outcome: "tombstoned" };

export interface AppStorageInstallationDeletionResult extends AppStorageInstallationDeletion {
  /** True when the tombstone was already there and these counts come from it. */
  alreadyDeleted: boolean;
}

/**
 * A collection the expiry sweep may work, and the durable claim that authorises
 * one worker to work it. Discovery and claiming are separate because a claim
 * takes locks and a listing must not: a pass that locked several collections'
 * counter rows in fairness order would meet an installation deletion holding
 * those rows in collection order.
 */
export type AppStorageSweepClaim =
  | { claimed: true; leaseToken: string }
  /** Tombstoned, already leased by a live worker, or taken by another pass. */
  | { claimed: false };

/** One event as the outbox holds it, with the identity every delivery attempt carries. */
export interface AppStorageAuditOutboxEntry extends AppStorageAuditEvent {
  attemptCount: number;
}

export interface AppStorageAuditOutboxClaim {
  claimToken: string;
  entries: AppStorageAuditOutboxEntry[];
}

/**
 * The persistence port the storage domain depends on. It moves rows, holds the
 * ceilings a write must be checked against atomically, and owns the lock order —
 * installation state row, then the collection's counter row, then record rows —
 * that keeps a sweep, a write, a rebuild, and a deletion from waiting on each
 * other. It owns no policy about what a record may contain or which operations a
 * collection permits.
 */
export interface AppStorageRepositoryPort {
  findInstallationState(scope: AppStorageInstallationScope): Promise<AppStorageInstallationState | null>;
  /**
   * Revokes or restores the App's storage access. Restoration is decided here
   * rather than by the caller, while the state row is held: a retention hold and
   * a live App are a combination no orchestration above this line can be trusted
   * to keep apart.
   */
  setAccessRevoked(
    scope: AppStorageInstallationScope,
    revokedAt: Date | null,
  ): Promise<AppStorageAdmitted<AppStorageAccessTransition>>;
  /**
   * Holds the data for a bounded period. Retained data is data the App may no
   * longer reach, so the same transaction revokes access when it is not already
   * revoked — the alternative is a hold whose data stays live and is deleted out
   * from under a running App when the deadline passes.
   */
  setRetention(input: {
    scope: AppStorageInstallationScope;
    retainUntil: Date;
    audit: (applied: { retainUntil: Date; accessRevokedAt: Date }) => AppStorageAuditIntent;
  }): Promise<AppStorageAdmitted<{ retainUntil: Date; accessRevokedAt: Date }>>;
  /**
   * Lifts a retention hold. It is its own operation rather than a side effect of
   * restoring access, because ending a promise that data will be destroyed is a
   * decision an operator makes and the trail has to show; access stays revoked
   * until it is restored on purpose.
   */
  cancelRetention(input: {
    scope: AppStorageInstallationScope;
    audit: (cleared: { retainUntil: Date }) => AppStorageAuditIntent;
  }): Promise<AppStorageAdmitted<{ retainUntil: Date | null }>>;
  findRecord(
    scope: AppStorageCollectionScope,
    key: string,
  ): Promise<AppStorageAdmitted<StoredAppStorageRecord | null>>;
  putRecord(command: AppStoragePutCommand): Promise<AppStorageAdmitted<AppStoragePutOutcome>>;
  deleteRecord(command: AppStorageDeleteCommand): Promise<AppStorageAdmitted<AppStorageDeleteOutcome>>;
  queryByIndex(query: AppStorageQuery): Promise<AppStorageAdmitted<StoredAppStorageRecord[]>>;
  readCollectionUsage(scope: AppStorageCollectionScope): Promise<AppStorageAdmitted<AppStorageLiveUsage>>;
  /**
   * The distinct schema versions this collection's rows actually carry. It is the
   * authoritative input to the compatibility matrix's stored-writer observation,
   * so nothing outside this module has to reach into storage tables to build one.
   */
  listStoredSchemaVersions(scope: AppStorageCollectionScope): Promise<AppStorageAdmitted<number[]>>;
  /** Marks an index pending under a fresh generation, so writes maintain it while the rebuild runs. */
  beginIndexRebuild(input: {
    scope: AppStorageCollectionScope;
    index: AppStorageIndexDescriptor;
  }): Promise<AppStorageAdmitted<AppStorageIndexRebuildStart>>;
  rebuildIndexBatch(
    batch: AppStorageIndexRebuildBatch,
  ): Promise<AppStorageAdmitted<AppStorageIndexRebuildProgress>>;
  /**
   * Records that this generation's rebuild converged. The marker stays set: an
   * older release can still rewrite a record between here and activation, and
   * only the marker keeps that write maintaining the index. What comes back is
   * the token activation presents to clear it.
   */
  finishIndexRebuild(input: {
    scope: AppStorageCollectionScope;
    indexId: string;
    generation: number;
  }): Promise<AppStorageAdmitted<AppStorageIndexRebuildFinish>>;
  /**
   * Clears a finished rebuild's marker inside a transaction the caller owns, so
   * an activation can hand the index over and stop maintaining it in one commit
   * rather than in two steps a write can land between.
   */
  completeIndexRebuild(
    transaction: AppStorageTransactionHandle,
    input: { scope: AppStorageCollectionScope; indexId: string; completionToken: string },
  ): Promise<AppStorageIndexRebuildCompletion>;
  /** Drops a rebuild that will not be activated, so writes stop maintaining an index nobody will use. */
  cancelIndexRebuild(input: {
    scope: AppStorageCollectionScope;
    indexId: string;
    generation: number;
  }): Promise<AppStorageAdmitted<AppStorageIndexRebuildCancel>>;
  /** Runs work inside one repository transaction, for callers that have to commit with it. */
  runInTransaction<TValue>(
    work: (transaction: AppStorageTransactionHandle) => Promise<TValue>,
  ): Promise<TValue>;
  /**
   * The collections the expiry sweep could work next, least recently swept first.
   * It takes no lock and makes no claim: it is a listing, and every decision it
   * suggests is rechecked by the claim.
   */
  listExpirySweepCandidates(limit: number): Promise<AppStorageCollectionScope[]>;
  /**
   * Claims exactly one collection, under its own installation's fence and then
   * its counter row, and writes a durable lease before committing. One unit at a
   * time is the point: holding several unfenced counter rows in sweep order is
   * what used to meet an installation deletion holding them in collection order.
   */
  claimCollectionForExpirySweep(input: {
    scope: AppStorageCollectionScope;
  }): Promise<AppStorageSweepClaim>;
  /**
   * Removes one bounded batch of a single collection's expired rows under the
   * lease the claim wrote, settles its counter, and releases the lease.
   */
  reclaimExpiredRecords(input: {
    scope: AppStorageCollectionScope;
    limit: number;
    leaseToken: string;
  }): Promise<number>;
  listInstallationsDueForRetention(limit: number): Promise<AppStorageInstallationScope[]>;
  /**
   * Deletes a retained installation's data, rechecking under the state-row lock
   * that its deadline is still past — an operator who extended the hold between
   * the listing and this call must not lose the data to the listing's decision.
   */
  reclaimRetainedInstallation(input: {
    scope: AppStorageInstallationScope;
    audit: (summary: AppStorageInstallationDeletion) => AppStorageAuditIntent;
  }): Promise<AppStorageRetentionReclaim>;
  openInstallationExport(input: {
    scope: AppStorageInstallationScope;
    batchSize: number;
    /** How long a snapshot may sit unread before it is aborted. */
    idleTimeoutMs?: number;
  }): Promise<AppStorageAdmitted<AppStorageExportSnapshot>>;
  deleteInstallationRecords(input: {
    scope: AppStorageInstallationScope;
    audit: (summary: AppStorageInstallationDeletion) => AppStorageAuditIntent;
  }): Promise<AppStorageInstallationDeletionResult>;
  /** Records an audit intent that belongs to no state change of its own. */
  enqueueAuditEvent(input: {
    scope: AppStorageInstallationScope;
    intent: AppStorageAuditIntent;
  }): Promise<void>;
  /**
   * Leases a bounded batch of committed intents and commits the lease. Publishing
   * happens after this returns, outside any transaction: a drain that published
   * while holding one would need a second pooled connection to reach the audit
   * store and would hold row locks across the publisher's latency.
   */
  claimAuditOutboxBatch(input: {
    limit: number;
    leaseSeconds: number;
  }): Promise<AppStorageAuditOutboxClaim>;
  /** Removes the entries this claim published, by the token that leased them. */
  acknowledgeAuditOutbox(input: { claimToken: string; eventIds: readonly string[] }): Promise<number>;
}
