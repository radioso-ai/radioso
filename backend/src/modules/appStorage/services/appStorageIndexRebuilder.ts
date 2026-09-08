import { indexColumnForFieldType } from "../domain/indexEntries.js";
import {
  classifyStorageFailure,
  storageFailure,
  storageSuccess,
  type AppStorageResult,
} from "../domain/results.js";
import type { AppStorageRepositoryPort } from "../ports/appStorageRepository.js";
import type {
  AppStorageIndexRebuildResult,
  AppStorageIndexRebuilder,
} from "../ports/appStorageService.js";

interface AppStorageIndexRebuilderOptions {
  repository: AppStorageRepositoryPort;
  /** Records one transaction rebuilds. A rebuild holds the collection's lock, so it takes it in pages. */
  batchSize?: number;
  /** Batches one rebuild runs before it refuses to continue, so a runaway loop cannot outlive the release it belongs to. */
  maxBatches?: number;
}

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_MAX_BATCHES = 10_000;

/**
 * Builds one declared index over records written before it was declared.
 *
 * An index entry is per record, so an index a candidate release adds answers
 * nothing about records an earlier release wrote — a query by it would silently
 * return a page of the collection rather than the collection. That is why release
 * admission reports the rebuild as a condition of activating the release instead
 * of a follow-up: the alternative is a correct-looking query with missing rows.
 *
 * The rebuild is generic. It reads the index's declared field and field type off
 * the collection the App declared and derives the entry the same way a write
 * does, so nothing here knows what any particular App keeps in its collections.
 *
 * It works in key-ordered pages under the same lock order every write takes —
 * installation state, then the collection's counter, then record rows — so it
 * neither blocks a collection for the length of the rebuild nor deadlocks against
 * a put running beside it.
 *
 * Working in pages is what makes it safe to run beside writes, and also what
 * would make it lose them: a key the first pass rebuilt can be rewritten by an
 * older release that knows nothing of this index, and the cursor never comes
 * back. So the rebuild is fenced by a marker on the installation's state row
 * instead of by a lock held for its whole length — while the marker is set every
 * put maintains the index, and a closing pass over the records written since
 * catches whatever landed behind the cursor before the marker was cleared.
 */
export const createAppStorageIndexRebuilder = (
  options: AppStorageIndexRebuilderOptions,
): AppStorageIndexRebuilder => {
  const { repository } = options;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;

  return {
    async rebuildIndex(input): Promise<AppStorageResult<AppStorageIndexRebuildResult>> {
      const index = input.collection.indexes.find((declared) => declared.id === input.indexId);
      if (!index) {
        return storageFailure(
          "invalid_input",
          `Collection ${input.collection.id} does not declare the index ${input.indexId}`,
        );
      }

      const field = input.collection.recordSchema.fields.find((declared) => declared.key === index.field);
      if (!field || indexColumnForFieldType(field.type) === null) {
        return storageFailure("invalid_input", `Index ${index.id} does not name an indexable field`);
      }

      const scope = {
        workspaceId: input.workspaceId,
        installationId: input.installationId,
        collectionId: input.collection.id,
      };

      const descriptor = { id: index.id, field: index.field, fieldType: field.type };

      try {
        // The index is marked pending before a single record is read. From here
        // every put maintains an entry for it as well as for the indexes the
        // writing release declares, so an older release that rewrites a key the
        // first pass already visited does not drop the entry the rebuild put
        // there. `startVersion` is where the closing pass starts looking.
        const started = await repository.beginIndexRebuild({ scope, index: descriptor });
        if (!started.admitted) {
          return storageFailure("denied", "Storage for this installation is not available");
        }

        let rebuiltCount = 0;
        let batchCount = 0;
        let incompatibleCount = 0;

        /** One key-ordered sweep of the collection, optionally limited to what a version marks as new. */
        const pass = async (
          minVersion: number | null,
        ): Promise<AppStorageResult<AppStorageIndexRebuildResult> | null> => {
          let after: string | null = null;

          while (batchCount < maxBatches) {
            const progress = await repository.rebuildIndexBatch({
              scope,
              index: descriptor,
              after,
              limit: batchSize,
              minVersion,
            });

            // A rebuild against a revoked installation is still the operator's,
            // but one against a tombstoned installation has nothing to build over.
            if (!progress.admitted) {
              return storageFailure("denied", "Storage for this installation is not available");
            }

            batchCount += 1;
            rebuiltCount += progress.value.rebuiltCount;
            incompatibleCount += progress.value.incompatibleCount;
            if (progress.value.rebuiltCount < batchSize || progress.value.lastKey === null) return null;
            after = progress.value.lastKey;
          }

          return storageFailure(
            "internal",
            `Rebuilding index ${index.id} did not finish within the batches one rebuild takes`,
          );
        };

        const first = await pass(null);
        if (first) return first;

        // The convergence pass. The batches above ran one transaction at a time,
        // so a write could land behind the cursor while they were running; every
        // such write carries a version at or past the marker, which is exactly
        // the set this pass revisits.
        const converged = await pass(started.value.startVersion);
        if (converged) return converged;

        // A value stored before its field was indexed was never measured against
        // the index's bounds. Leaving the marker set keeps writes maintaining the
        // index while an operator decides, and the outcome names the count rather
        // than activating a release whose query would silently skip those records.
        if (incompatibleCount > 0) {
          return storageSuccess({
            outcome: "incompatible_records",
            indexId: index.id,
            incompatibleCount,
          });
        }

        const finished = await repository.finishIndexRebuild({ scope, indexId: index.id });
        if (!finished.admitted) {
          return storageFailure("denied", "Storage for this installation is not available");
        }

        return storageSuccess({ outcome: "rebuilt", rebuiltCount, batchCount });
      } catch (error) {
        return classifyStorageFailure(error);
      }
    },
  };
};
