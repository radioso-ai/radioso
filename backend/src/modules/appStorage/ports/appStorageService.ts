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
 */
export interface AppStorageDisposition {
  revokeAccess(scope: AppStorageInstallationScope): Promise<void>;
  restoreAccess(scope: AppStorageInstallationScope): Promise<void>;
  exportRecords(scope: AppStorageInstallationScope): AsyncIterable<AppStorageExportLine>;
  retain(input: AppStorageInstallationScope & { until: Date }): Promise<void>;
  deleteInstallationStorage(scope: AppStorageInstallationScope): Promise<AppStorageDeletionSummary>;
  deleteWorkspaceStorage(input: { workspaceId: string }): Promise<{
    recordCount: number;
    installationCount: number;
  }>;
}

export interface AppStorageExpirySweepResult {
  deletedCount: number;
  batchCount: number;
}

export interface AppStorageExpirySweeper {
  runExpirySweep(): Promise<AppStorageExpirySweepResult>;
}
