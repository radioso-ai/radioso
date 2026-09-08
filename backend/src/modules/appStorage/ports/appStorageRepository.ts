import type { BoundedJsonRecord, StorageFieldType } from "@radioso/app-contract";

import type { AppStorageIndexEntry, AppStorageIndexColumn } from "../domain/indexEntries.js";
import type { AppStorageCollectionUsage } from "../domain/quota.js";

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

export interface AppStorageInstallationState {
  accessRevokedAt: Date | null;
  retainUntil: Date | null;
  /** Set by installation deletion and cleared only by workspace deletion. */
  deletedAt: Date | null;
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

export interface AppStoragePutCommand {
  scope: AppStorageCollectionScope;
  key: string;
  value: BoundedJsonRecord;
  byteSize: number;
  schemaVersion: number;
  /**
   * The interval, not a deadline. A write can wait on a lock for an unbounded
   * time, so the deadline is computed in SQL from the transaction that stores the
   * row rather than from a clock the caller read before it queued.
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
  | { outcome: "quota_exceeded" };

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

/** One batch of an index rebuild: the records after `after`, in key order. */
export interface AppStorageIndexRebuildBatch {
  scope: AppStorageCollectionScope;
  index: { id: string; field: string; fieldType: StorageFieldType };
  after: string | null;
  limit: number;
}

export interface AppStorageIndexRebuildProgress {
  rebuiltCount: number;
  lastKey: string | null;
}

export interface ExportedAppStorageRecord extends StoredAppStorageRecord {
  collectionId: string;
}

export interface AppStorageInstallationDeletion {
  recordCount: number;
  collectionCount: number;
}

/**
 * The persistence port the storage domain depends on. It moves rows, holds the
 * ceilings a write must be checked against atomically, and owns the lock order —
 * collection usage row first, record rows second — that keeps a sweep and a write
 * from waiting on each other. It owns no policy about what a record may contain
 * or which operations a collection permits.
 */
export interface AppStorageRepositoryPort {
  findInstallationState(scope: AppStorageInstallationScope): Promise<AppStorageInstallationState | null>;
  setAccessRevoked(
    scope: AppStorageInstallationScope,
    revokedAt: Date | null,
  ): Promise<AppStorageAdmitted<void>>;
  setRetention(
    scope: AppStorageInstallationScope,
    retainUntil: Date | null,
  ): Promise<AppStorageAdmitted<void>>;
  findRecord(
    scope: AppStorageCollectionScope,
    key: string,
  ): Promise<AppStorageAdmitted<StoredAppStorageRecord | null>>;
  putRecord(command: AppStoragePutCommand): Promise<AppStorageAdmitted<AppStoragePutOutcome>>;
  deleteRecord(command: AppStorageDeleteCommand): Promise<AppStorageAdmitted<AppStorageDeleteOutcome>>;
  queryByIndex(query: AppStorageQuery): Promise<AppStorageAdmitted<StoredAppStorageRecord[]>>;
  readCollectionUsage(
    scope: AppStorageCollectionScope,
  ): Promise<AppStorageAdmitted<AppStorageCollectionUsage>>;
  rebuildIndexBatch(
    batch: AppStorageIndexRebuildBatch,
  ): Promise<AppStorageAdmitted<AppStorageIndexRebuildProgress>>;
  /** Collections holding at least one expired row, for the sweep to work through. */
  listCollectionsWithExpiredRecords(limit: number): Promise<AppStorageCollectionScope[]>;
  /** Removes one bounded batch of a single collection's expired rows and settles its counter. */
  reclaimExpiredRecords(input: { scope: AppStorageCollectionScope; limit: number }): Promise<number>;
  listInstallationsDueForRetention(limit: number): Promise<AppStorageInstallationScope[]>;
  streamInstallationRecords(input: {
    scope: AppStorageInstallationScope;
    batchSize: number;
  }): AsyncIterable<ExportedAppStorageRecord>;
  deleteInstallationRecords(
    scope: AppStorageInstallationScope,
  ): Promise<AppStorageAdmitted<AppStorageInstallationDeletion>>;
  deleteWorkspaceRecords(workspaceId: string): Promise<{ recordCount: number; installationCount: number }>;
}
