import type {
  AppStorageInstallationScope,
  AppStorageRepositoryPort,
} from "../ports/appStorageRepository.js";
import type {
  AppStorageExpirySweepResult,
  AppStorageIndexRebuildSweepResult,
  AppStorageRetentionSweepResult,
  AppStorageSweeper,
} from "../ports/appStorageService.js";

interface AppStorageSweeperOptions {
  repository: AppStorageRepositoryPort;
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
 * index entries, and its counters, leaves the tombstone behind, and writes the
 * audit intent describing what it removed — one transaction, so the trail cannot
 * name a deletion that rolled back or omit one that did not.
 */
export const createAppStorageSweeper = (options: AppStorageSweeperOptions): AppStorageSweeper => {
  const { repository } = options;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
  const maxInstallations = options.maxInstallations ?? DEFAULT_MAX_INSTALLATIONS;

  /**
   * Works one collection at a time, and claims one at a time.
   *
   * Listing and claiming are separate steps because they answer different
   * questions under different constraints. The listing is fairness — least
   * recently swept first, so a collection whose expired rows keep arriving cannot
   * be picked every round while another keeps its own backlog forever — and it
   * takes no locks, because taking counter rows in fairness order is exactly how a
   * sweep meets an installation deletion holding them in collection order. The
   * claim is authority: it takes the installation's fence, then that one
   * collection's counter row, and writes a lease that outlives its own
   * transaction, so a second worker cannot take the collection in the moment
   * between the claim committing and the reclamation starting.
   *
   * The reclaim then approaches the installation's state row first, the counter
   * row second, and record rows third, which is the order every write takes, so a
   * sweep, a put, and an installation deletion queue behind each other instead of
   * deadlocking.
   */
  const sweepCollections = async (): Promise<AppStorageExpirySweepResult> => {
    let deletedCount = 0;
    let batchCount = 0;
    let skippedCount = 0;

    while (batchCount < maxBatches) {
      const candidates = await repository.listExpirySweepCandidates(maxBatches - batchCount);
      if (candidates.length === 0) break;

      let progressed = false;
      for (const scope of candidates) {
        if (batchCount >= maxBatches) break;

        const claim = await repository.claimCollectionForExpirySweep({ scope });
        if (!claim.claimed) {
          skippedCount += 1;
          continue;
        }

        const deleted = await repository.reclaimExpiredRecords({
          scope,
          limit: batchSize,
          leaseToken: claim.leaseToken,
        });
        batchCount += 1;
        deletedCount += deleted;
        if (deleted > 0) progressed = true;
      }

      // A round that reclaimed nothing means what the listing saw is gone —
      // another pass, or a write that reclaimed its own collection, took it.
      if (!progressed) break;
    }

    return { deletedCount, batchCount, skippedCount };
  };

  /**
   * Reclaims one due installation. The listing that produced this scope was a
   * decision made outside any lock, so the repository rechecks the deadline while
   * holding the state row: an operator who extended the hold in between keeps the
   * data, and this pass reports it as not due rather than as a failure.
   *
   * The deletion and the event that describes it commit together, which is why
   * nothing is recorded here on the way out — a trail written afterwards could
   * describe a deletion that rolled back, or miss one that did not.
   */
  const reclaimInstallation = async (
    scope: AppStorageInstallationScope,
  ): Promise<{ recordCount: number; reclaimed: boolean; failed: boolean }> => {
    try {
      const removed = await repository.reclaimRetainedInstallation({
        scope,
        audit: (summary) => ({
          eventType: "app.data.deletion.completed",
          eventStatus: "success",
          metadata: {
            reason: "retention_elapsed",
            recordCount: summary.recordCount,
            collectionCount: summary.collectionCount,
          },
        }),
      });

      if (removed.outcome !== "reclaimed") return { recordCount: 0, reclaimed: false, failed: false };
      return { recordCount: removed.summary.recordCount, reclaimed: true, failed: false };
    } catch {
      // A failed reclamation is the case the trail exists for: the deadline
      // passed and the data is still here, and the next pass has to try again.
      // This event has no state change to ride along with — nothing committed —
      // so it goes to the outbox on its own.
      //
      // Recording it is itself allowed to fail. The pass has already learned what
      // it needs to report about this installation, and an outbox write that
      // failed must not take the remaining installations down with it.
      try {
        await repository.enqueueAuditEvent({
          scope,
          intent: {
            eventType: "app.data.deletion.completed",
            eventStatus: "failure",
            metadata: { reason: "retention_elapsed" },
          },
        });
      } catch {
        // The failure is still reported through `failureCount`.
      }
      return { recordCount: 0, reclaimed: false, failed: true };
    }
  };

  /**
   * Drops the rebuild markers whose lease has run out.
   *
   * A rebuild renews its marker's lease every batch, and once more when it
   * converges so the activation has a window. A marker past its deadline
   * therefore belongs to a run that died — and until it goes, every write to that
   * collection keeps maintaining an index no release is going to query. The
   * listing is fairness-free and lock-free, in deadline order; each deadline is
   * read again under the installation's state row, so a rebuild that renewed its
   * lease in between keeps it.
   */
  const sweepAbandonedRebuilds = async (): Promise<AppStorageIndexRebuildSweepResult> => {
    const installations = await repository.listAbandonedIndexRebuilds(maxInstallations);
    let cancelledCount = 0;
    let installationCount = 0;

    for (const scope of installations) {
      const dropped = await repository.cancelAbandonedIndexRebuilds({ scope });
      if (dropped.cancelledCount === 0) continue;
      cancelledCount += dropped.cancelledCount;
      installationCount += 1;
    }

    return { installationCount, cancelledCount };
  };

  return {
    runExpirySweep: sweepCollections,
    runIndexRebuildSweep: sweepAbandonedRebuilds,

    /**
     * A pass that reported a failed reclamation the same way as one that was
     * merely no longer due would leave an operator unable to tell an extended
     * hold from data that is past its deadline and still here, so the two are
     * counted apart.
     */
    async runRetentionSweep(): Promise<AppStorageRetentionSweepResult> {
      const due = await repository.listInstallationsDueForRetention(maxInstallations);
      let installationCount = 0;
      let recordCount = 0;
      let failureCount = 0;

      for (const scope of due) {
        const outcome = await reclaimInstallation(scope);
        if (outcome.failed) failureCount += 1;
        if (!outcome.reclaimed) continue;
        installationCount += 1;
        recordCount += outcome.recordCount;
      }

      return { installationCount, recordCount, failureCount };
    },
  };
};
