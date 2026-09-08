import type {
  AppError,
  StorageCollection,
  StorageDeleteRequest,
  StorageGetRequest,
  StoragePutRequest,
  StorageQueryRequest,
  storageDeleteResultSchema,
  storageGetResultSchema,
  storagePutResultSchema,
  storageQueryResultSchema,
} from "@radioso/app-contract";
import type { z } from "zod";

import type { AppStorageResult } from "../domain/results.js";
import type {
  AppStorageCollectionScope,
  AppStorageInstallationScope,
  AppStorageLiveUsage,
} from "./appStorageRepository.js";

/**
 * Result shapes come from the contract's own schemas rather than being restated
 * here, so a change to what `storage.get` answers cannot leave this port
 * describing the previous shape.
 */
export type StorageGetResult = z.infer<typeof storageGetResultSchema>;
export type StoragePutResult = z.infer<typeof storagePutResultSchema>;
export type StorageDeleteResult = z.infer<typeof storageDeleteResultSchema>;
export type StorageQueryResult = z.infer<typeof storageQueryResultSchema>;

/**
 * Every operation carries the installation it belongs to and the collection
 * declaration resolved for it. Neither is derivable from the request, and a
 * caller that could omit either would be a caller that could read another
 * installation's records.
 */
export interface AppStorageOperation<TRequest> extends AppStorageInstallationScope {
  collection: StorageCollection;
  request: TRequest;
}

export interface AppStorageService {
  get(input: AppStorageOperation<StorageGetRequest>): Promise<AppStorageResult<StorageGetResult>>;
  put(input: AppStorageOperation<StoragePutRequest>): Promise<AppStorageResult<StoragePutResult>>;
  delete(input: AppStorageOperation<StorageDeleteRequest>): Promise<AppStorageResult<StorageDeleteResult>>;
  query(input: AppStorageOperation<StorageQueryRequest>): Promise<AppStorageResult<StorageQueryResult>>;
  usage(
    input: AppStorageInstallationScope & { collection: StorageCollection },
  ): Promise<AppStorageResult<AppStorageLiveUsage>>;
  /**
   * The schema versions this collection's rows carry, for the compatibility
   * matrix's stored-writer observation. It lives here because the answer is a
   * storage fact: a release admission that had to derive it would be a caller
   * reading storage tables it does not own.
   */
  storedSchemaVersions(scope: AppStorageCollectionScope): Promise<AppStorageResult<number[]>>;
}

/**
 * One line of an export, or the failure that ended it. A stream that simply
 * stopped would be indistinguishable from one that finished, and the difference
 * is whether the operator has all of the customer's data or some of it.
 */
export type AppStorageExportEvent =
  | { kind: "line"; collectionId: string; line: string }
  | { kind: "error"; error: AppError };

/**
 * Admission and streaming are separate answers. Whether an export may run at all
 * is decided once, under the installation's state row, and reported as a result;
 * what follows is the data.
 */
export type AppStorageExportAdmission =
  | { ok: false; error: AppError }
  | { ok: true; stream: AsyncIterable<AppStorageExportEvent> };

export interface AppStorageDeletionSummary {
  recordCount: number;
  collectionCount: number;
}

/**
 * Disposition is the operator's side of managed storage: revoke access without
 * deleting, hand the data back, hold it for a bounded period, or remove it.
 *
 * Revoking takes the App's authority away and leaves the operator's intact, so an
 * export after a revocation is the expected order rather than a hole. What no
 * disposition survives is deletion: the installation keeps a tombstone, and every
 * operation against it is refused until the workspace itself is gone — except
 * deletion, which answers with the tombstone's own counts, because a caller that
 * lost the first response has to be able to ask again.
 *
 * Workspace deletion is not here. A workspace's storage goes with the workspace
 * row through the foreign key cascade, and a second path that removed the same
 * rows without holding any installation's fence could only race the first.
 */
export interface AppStorageDisposition {
  revokeAccess(scope: AppStorageInstallationScope): Promise<AppStorageResult<void>>;
  restoreAccess(scope: AppStorageInstallationScope): Promise<AppStorageResult<void>>;
  export(scope: AppStorageInstallationScope): Promise<AppStorageExportAdmission>;
  retain(
    input: AppStorageInstallationScope & { until: Date },
  ): Promise<AppStorageResult<{ retainUntil: Date }>>;
  deleteInstallationStorage(
    scope: AppStorageInstallationScope,
  ): Promise<AppStorageResult<AppStorageDeletionSummary>>;
  /**
   * Publishes the audit intents dispositions committed alongside their changes.
   * Exposed rather than scheduled: the runtime that owns background work decides
   * the cadence, and a trail that is a few seconds behind is still a trail that
   * agrees with the data.
   */
  drainAuditOutbox(): Promise<{ publishedCount: number }>;
}

export interface AppStorageExpirySweepResult {
  deletedCount: number;
  batchCount: number;
}

export interface AppStorageRetentionSweepResult {
  installationCount: number;
  recordCount: number;
}

/**
 * The two maintenance passes managed storage needs. Neither enforces a rule a
 * read already enforces: an expired record is invisible before the expiry sweep
 * reaches it, and a retained installation's data is unreachable by its App
 * throughout. What the passes do is make the deletion real — space back for the
 * first, and the operator's promise that the data stops existing for the second.
 */
export interface AppStorageSweeper {
  runExpirySweep(): Promise<AppStorageExpirySweepResult>;
  runRetentionSweep(): Promise<AppStorageRetentionSweepResult>;
}

/**
 * What a rebuild did, or why it cannot be finished. A value stored before its
 * field was indexed was never measured against the index's bounds, so a rebuild
 * can meet one the index cannot hold; it reports that as a deterministic outcome
 * with a count, rather than raising the database's own error at the operator.
 */
export type AppStorageIndexRebuildResult =
  | { outcome: "rebuilt"; rebuiltCount: number; batchCount: number }
  | { outcome: "incompatible_records"; indexId: string; incompatibleCount: number };

/**
 * Builds a declared index over records written before it was declared. An index
 * entry exists per record, so an index a candidate release adds answers nothing
 * about older records until this has run — which is why release admission reports
 * the rebuild as a condition of activating that release rather than a follow-up.
 */
export interface AppStorageIndexRebuilder {
  rebuildIndex(
    input: AppStorageInstallationScope & { collection: StorageCollection; indexId: string },
  ): Promise<AppStorageResult<AppStorageIndexRebuildResult>>;
}
