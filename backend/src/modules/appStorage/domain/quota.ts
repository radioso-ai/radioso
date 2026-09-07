import type { StorageCollection } from "@radioso/app-contract";

export interface AppStorageCollectionUsage {
  recordCount: number;
  byteSize: number;
}

/**
 * The ceiling a write is admitted against. A collection declares a record count
 * and a per-record byte size; per-record bytes are settled during validation, so
 * what a write still has to check atomically is whether a new key fits under the
 * count. Total bytes are tracked for operator-visible usage, not as a second
 * ceiling — the manifest declares none.
 */
interface AppStorageQuotaCeiling {
  maxRecords: number;
}

export const resolveQuotaCeiling = (collection: StorageCollection): AppStorageQuotaCeiling => ({
  maxRecords: collection.quotas.maxRecords,
});

/** Only a new key consumes a slot; rewriting an existing record does not. */
export const exceedsRecordQuota = (
  usage: AppStorageCollectionUsage,
  ceiling: AppStorageQuotaCeiling,
  addsNewKey: boolean,
): boolean => addsNewKey && usage.recordCount + 1 > ceiling.maxRecords;
