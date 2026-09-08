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
import type { AppStorageInstallationScope, AppStorageLiveUsage } from "./appStorageRepository.js";

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
 * An admitted export, and the snapshot the caller now owns.
 *
 * Owning it is the point. `stream` opens the database snapshot on the first read
 * and holds it until the data runs out; an export that is admitted and never read
 * therefore holds nothing, and one whose consumer walks away is closed either by
 * `close` or by the snapshot's own idle timeout rather than left open.
 */
export interface AppStorageExportSnapshotStream {
  stream(): AsyncIterable<AppStorageExportEvent>;
  close(): Promise<void>;
}

/**
 * Admission and streaming are separate answers. Whether an export may run at all
 * is decided once, against the installation's state, and reported as a result;
 * what follows is the data.
 */
export type AppStorageExportAdmission =
  | { ok: false; error: AppError }
  | { ok: true; snapshot: AppStorageExportSnapshotStream };

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
  /**
   * Gives the App its storage back. It is refused while a retention hold stands:
   * a hold is a promise that the data stops existing at a named instant, and an
   * App writing into data scheduled for destruction is the state the promise
   * exists to prevent. Lifting the hold is `cancelRetention`, on purpose.
   */
  restoreAccess(scope: AppStorageInstallationScope): Promise<AppStorageResult<void>>;
  export(scope: AppStorageInstallationScope): Promise<AppStorageExportAdmission>;
  retain(
    input: AppStorageInstallationScope & { until: Date },
  ): Promise<AppStorageResult<{ retainUntil: Date }>>;
  /**
   * Lifts a retention hold and says so in the trail. Access stays revoked: ending
   * a scheduled destruction and handing the data back to the App are two
   * decisions, and an operator makes them one at a time.
   */
  cancelRetention(
    scope: AppStorageInstallationScope,
  ): Promise<AppStorageResult<{ retainUntil: Date | null }>>;
  deleteInstallationStorage(
    scope: AppStorageInstallationScope,
  ): Promise<AppStorageResult<AppStorageDeletionSummary>>;
  /**
   * Publishes the audit intents dispositions committed alongside their changes.
   * Exposed rather than scheduled: the runtime that owns background work decides
   * the cadence, and a trail that is a few seconds behind is still a trail that
   * agrees with the data.
   *
   * Delivery is at-least-once. Entries are leased, published outside any
   * transaction, and only then acknowledged, so a publish whose acknowledgement
   * did not commit is published again under the same event id.
   */
  drainAuditOutbox(): Promise<AppStorageAuditDrainResult>;
}

export interface AppStorageAuditDrainResult {
  publishedCount: number;
  /** Entries whose publish failed. Their lease expires and the next pass retries them. */
  failureCount: number;
}

export interface AppStorageExpirySweepResult {
  deletedCount: number;
  batchCount: number;
  /** Collections another worker's live lease already covered. */
  skippedCount: number;
}

export interface AppStorageRetentionSweepResult {
  installationCount: number;
  recordCount: number;
  /**
   * Installations whose reclamation failed. A pass that reported these the same
   * way as installations that were merely no longer due would leave an operator
   * unable to tell a hold that was extended from data that is past its deadline
   * and still here.
   */
  failureCount: number;
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
 *
 * A finished rebuild carries the token activation presents to clear the pending
 * marker inside its own transaction. The marker stays up until then on purpose:
 * an older release can still rewrite a record between the last batch and the
 * activation, and the marker is the only thing making that write maintain the
 * index the candidate is about to query.
 */
export type AppStorageIndexRebuildResult =
  | { outcome: "rebuilt"; rebuiltCount: number; batchCount: number; completionToken: string }
  | { outcome: "incompatible_records"; indexId: string; incompatibleCount: number }
  /** Another rebuild of the same index took the marker over; this run owns nothing. */
  | { outcome: "superseded"; indexId: string };

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
