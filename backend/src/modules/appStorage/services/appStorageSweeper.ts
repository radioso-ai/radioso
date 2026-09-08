import type { AppStorageAuditPort } from "../ports/appStorageAudit.js";
import type {
  AppStorageInstallationScope,
  AppStorageRepositoryPort,
} from "../ports/appStorageRepository.js";
import type {
  AppStorageExpirySweepResult,
  AppStorageRetentionSweepResult,
  AppStorageSweeper,
} from "../ports/appStorageService.js";

interface AppStorageSweeperOptions {
  repository: AppStorageRepositoryPort;
  audit: AppStorageAuditPort;
  /** Rows one statement removes. Deleting a whole backlog at once holds the collection's lock for as long as the backlog is large. */
  batchSize?: number;
  /** Batches one expiry pass runs. A sweep is maintenance, not a job that owns the connection until the backlog is empty. */
  maxBatches?: number;
  /** Installations one retention pass reclaims, so a large workspace is not deleted inside a single pass. */
  maxInstallations?: number;
}

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_BATCHES = 20;
const DEFAULT_MAX_INSTALLATIONS = 50;

/**
 * The two maintenance passes managed storage needs, and the difference between
 * them is what each one is for.
 *
 * Expiry reclaims space. A record past its deadline is already invisible to a
 * read and already outside the quota a write is admitted against, because a put,
 * a delete, and a usage read each give back their own collection's expired rows
 * under the counter lock before they decide anything. So this pass can stop at a
 * ceiling and leave the rest for the next one without changing what anybody
 * observes.
 *
 * Retention is the opposite: nothing else enforces it. An operator who removed an
 * App and chose to hold its data for a bounded period made a promise that the data
 * stops existing at a named instant, and this pass is what keeps it. Each due
 * installation is reclaimed in one transaction that removes its records, their
 * index entries, and its counters and leaves the tombstone behind, and the audit
 * event that follows carries what was removed.
 */
export const createAppStorageSweeper = (options: AppStorageSweeperOptions): AppStorageSweeper => {
  const { repository, audit } = options;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
  const maxInstallations = options.maxInstallations ?? DEFAULT_MAX_INSTALLATIONS;

  /**
   * Works one collection at a time. The pass approaches the counter row first and
   * the record rows second — the order every write takes — so a sweep and a put
   * queue behind each other instead of deadlocking.
   */
  const sweepCollections = async (): Promise<AppStorageExpirySweepResult> => {
    let deletedCount = 0;
    let batchCount = 0;

    while (batchCount < maxBatches) {
      const collections = await repository.listCollectionsWithExpiredRecords(maxBatches - batchCount);
      if (collections.length === 0) break;

      let progressed = false;
      for (const scope of collections) {
        if (batchCount >= maxBatches) break;
        const deleted = await repository.reclaimExpiredRecords({ scope, limit: batchSize });
        batchCount += 1;
        deletedCount += deleted;
        if (deleted > 0) progressed = true;
      }

      // A round that reclaimed nothing means what the listing saw is gone —
      // another pass, or a write that reclaimed its own collection, took it.
      if (!progressed) break;
    }

    return { deletedCount, batchCount };
  };

  const reclaimInstallation = async (
    scope: AppStorageInstallationScope,
  ): Promise<{ recordCount: number; reclaimed: boolean }> => {
    try {
      const removed = await repository.deleteInstallationRecords(scope);
      if (!removed.admitted) return { recordCount: 0, reclaimed: false };

      await audit.record({
        workspaceId: scope.workspaceId,
        installationId: scope.installationId,
        eventType: "app.data.deletion.completed",
        eventStatus: "success",
        metadata: {
          reason: "retention_elapsed",
          recordCount: removed.value.recordCount,
          collectionCount: removed.value.collectionCount,
        },
      });

      return { recordCount: removed.value.recordCount, reclaimed: true };
    } catch {
      // A failed reclamation is the case the trail exists for: the deadline
      // passed and the data is still here, and the next pass has to try again.
      await audit.record({
        workspaceId: scope.workspaceId,
        installationId: scope.installationId,
        eventType: "app.data.deletion.completed",
        eventStatus: "failure",
        metadata: { reason: "retention_elapsed" },
      });
      return { recordCount: 0, reclaimed: false };
    }
  };

  return {
    runExpirySweep: sweepCollections,

    async runRetentionSweep(): Promise<AppStorageRetentionSweepResult> {
      const due = await repository.listInstallationsDueForRetention(maxInstallations);
      let installationCount = 0;
      let recordCount = 0;

      for (const scope of due) {
        const outcome = await reclaimInstallation(scope);
        if (!outcome.reclaimed) continue;
        installationCount += 1;
        recordCount += outcome.recordCount;
      }

      return { installationCount, recordCount };
    },
  };
};
