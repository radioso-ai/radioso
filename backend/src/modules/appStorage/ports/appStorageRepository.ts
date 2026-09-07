import type { BoundedJsonRecord } from "@radioso/app-contract";

import type { AppStorageIndexEntry, AppStorageIndexColumn } from "../domain/indexEntries.js";
import type { AppStorageCollectionUsage } from "../domain/quota.js";

/** Isolation is the key, not a filter: every scope starts with both identifiers. */
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
}

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
  expiresAt: Date | null;
  expectedVersion: number | null;
  indexEntries: readonly AppStorageIndexEntry[];
  /**
   * The record-count ceiling the collection declares. The check has to happen
   * inside the write's own transaction, or two concurrent puts each read a
   * count below the ceiling and both commit.
   */
  maxRecords: number;
  now: Date;
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
  now: Date;
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
  now: Date;
}

export interface ExportedAppStorageRecord extends StoredAppStorageRecord {
  collectionId: string;
}

/**
 * The persistence port the storage domain depends on. It moves rows and holds
 * the ceilings a write must be checked against atomically; it owns no policy
 * about what a record may contain or which operations a collection permits.
 */
export interface AppStorageRepositoryPort {
  findInstallationState(scope: AppStorageInstallationScope): Promise<AppStorageInstallationState | null>;
  setAccessRevoked(scope: AppStorageInstallationScope, revokedAt: Date | null): Promise<void>;
  setRetention(scope: AppStorageInstallationScope, retainUntil: Date | null): Promise<void>;
  findRecord(
    scope: AppStorageCollectionScope,
    key: string,
    now: Date,
  ): Promise<StoredAppStorageRecord | null>;
  putRecord(command: AppStoragePutCommand): Promise<AppStoragePutOutcome>;
  deleteRecord(command: AppStorageDeleteCommand): Promise<AppStorageDeleteOutcome>;
  queryByIndex(query: AppStorageQuery): Promise<StoredAppStorageRecord[]>;
  readCollectionUsage(scope: AppStorageCollectionScope): Promise<AppStorageCollectionUsage>;
  deleteExpiredRecords(input: { now: Date; limit: number }): Promise<number>;
  streamInstallationRecords(input: {
    scope: AppStorageInstallationScope;
    batchSize: number;
  }): AsyncIterable<ExportedAppStorageRecord>;
  deleteInstallationRecords(
    scope: AppStorageInstallationScope,
  ): Promise<{ recordCount: number; collectionCount: number }>;
  deleteWorkspaceRecords(workspaceId: string): Promise<{ recordCount: number; installationCount: number }>;
}
