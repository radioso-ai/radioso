import type {
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
import type { AppStorageCollectionUsage } from "../domain/quota.js";
import type { AppStorageInstallationScope } from "./appStorageRepository.js";

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
  ): Promise<AppStorageResult<AppStorageCollectionUsage>>;
}

/** One JSON Lines record of an export, tagged with the collection it belongs to. */
export interface AppStorageExportLine {
  collectionId: string;
  line: string;
}

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
 * operation against it is refused until the workspace itself is gone.
 */
export interface AppStorageDisposition {
  revokeAccess(scope: AppStorageInstallationScope): Promise<AppStorageResult<void>>;
  restoreAccess(scope: AppStorageInstallationScope): Promise<AppStorageResult<void>>;
  exportRecords(scope: AppStorageInstallationScope): AsyncIterable<AppStorageExportLine>;
  retain(
    input: AppStorageInstallationScope & { until: Date },
  ): Promise<AppStorageResult<{ retainUntil: Date }>>;
  deleteInstallationStorage(
    scope: AppStorageInstallationScope,
  ): Promise<AppStorageResult<AppStorageDeletionSummary>>;
  deleteWorkspaceStorage(input: { workspaceId: string }): Promise<{
    recordCount: number;
    installationCount: number;
  }>;
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

export interface AppStorageIndexRebuildResult {
  rebuiltCount: number;
  batchCount: number;
}

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
