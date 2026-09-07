import type { AppStorageRepositoryPort } from "../ports/appStorageRepository.js";
import type { AppStorageExpirySweeper, AppStorageExpirySweepResult } from "../ports/appStorageService.js";

interface AppStorageExpirySweeperOptions {
  repository: AppStorageRepositoryPort;
  now?: () => Date;
  /** Rows one statement removes. Deleting a whole backlog in one statement holds locks for as long as the backlog is large. */
  batchSize?: number;
  /** Batches one sweep runs. A sweep is a maintenance pass, not a job that owns the connection until the backlog is empty. */
  maxBatches?: number;
}

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_BATCHES = 20;

/**
 * Removes records whose TTL has passed. Reads already hide an expired record
 * whether or not a sweep has run, so this reclaims space rather than enforcing
 * expiry — which is what lets it stop at a ceiling and leave the rest for the
 * next pass instead of running until the backlog is gone.
 */
export const createAppStorageExpirySweeper = (
  options: AppStorageExpirySweeperOptions,
): AppStorageExpirySweeper => {
  const { repository } = options;
  const clock = options.now ?? ((): Date => new Date());
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;

  return {
    async runExpirySweep(): Promise<AppStorageExpirySweepResult> {
      let deletedCount = 0;
      let batchCount = 0;

      while (batchCount < maxBatches) {
        const deleted = await repository.deleteExpiredRecords({ now: clock(), limit: batchSize });
        batchCount += 1;
        deletedCount += deleted;
        // A short batch means the backlog is drained; a full one means there may
        // be more, and the ceiling above decides how much of it this pass takes.
        if (deleted < batchSize) break;
      }

      return { deletedCount, batchCount };
    },
  };
};
