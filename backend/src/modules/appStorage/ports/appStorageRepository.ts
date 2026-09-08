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
   * count below the ceiling and both commit.
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
   * Records whose stored value is past what the index can hold. A field that was
   * not indexed when it was written was never bounded, so the rebuild counts them
   * and leaves them out rather than letting the database refuse the batch.
   */
  incompatibleCount: number;
}

export interface AppStorageIndexRebuildStart {
  /** The collection's next version at the moment the index became pending. */
  startVersion: number;
}

export interface ExportedAppStorageRecord extends StoredAppStorageRecord {
  collectionId: string;
}

/**
 * An admitted export. The records are read inside one repeatable-read transaction
 * that stays open for the life of the iterable, so every page sees one database
 * state — and a failure part-way through is raised, never delivered as the end of
 * the data.
 */
export interface AppStorageExportSnapshot {
  records: AsyncIterable<ExportedAppStorageRecord>;
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
 * The persistence port the storage domain depends on. It moves rows, holds the
 * ceilings a write must be checked against atomically, and owns the lock order —
 * installation state row, then the collection's counter row, then record rows —
 * that keeps a sweep, a write, a rebuild, and a deletion from waiting on each
 * other. It owns no policy about what a record may contain or which operations a
 * collection permits.
 */
export interface AppStorageRepositoryPort {
  findInstallationState(scope: AppStorageInstallationScope): Promise<AppStorageInstallationState | null>;
  setAccessRevoked(
    scope: AppStorageInstallationScope,
    revokedAt: Date | null,
  ): Promise<AppStorageAdmitted<void>>;
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
  /** Marks an index pending, so writes maintain it while the rebuild runs. */
  beginIndexRebuild(input: {
    scope: AppStorageCollectionScope;
    index: AppStorageIndexDescriptor;
  }): Promise<AppStorageAdmitted<AppStorageIndexRebuildStart>>;
  rebuildIndexBatch(
    batch: AppStorageIndexRebuildBatch,
  ): Promise<AppStorageAdmitted<AppStorageIndexRebuildProgress>>;
  /** Clears the pending marker once the rebuild and its convergence pass are done. */
  finishIndexRebuild(input: {
    scope: AppStorageCollectionScope;
    indexId: string;
  }): Promise<AppStorageAdmitted<void>>;
  /**
   * Claims the collections the expiry sweep works next, least recently swept
   * first, skipping the ones another pass already holds.
   */
  claimCollectionsForExpirySweep(limit: number): Promise<AppStorageCollectionScope[]>;
  /** Removes one bounded batch of a single collection's expired rows and settles its counter. */
  reclaimExpiredRecords(input: { scope: AppStorageCollectionScope; limit: number }): Promise<number>;
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
   * Publishes committed audit intents. The entries are claimed with the publish,
   * so an entry a publisher failed on is left for the next pass rather than lost.
   */
  drainAuditOutbox(input: {
    limit: number;
    publish: (event: AppStorageAuditEvent) => Promise<void>;
  }): Promise<number>;
}
