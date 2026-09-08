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

      try {
        let rebuiltCount = 0;
        let batchCount = 0;
        let after: string | null = null;

        while (batchCount < maxBatches) {
          const progress = await repository.rebuildIndexBatch({
            scope,
            index: { id: index.id, field: index.field, fieldType: field.type },
            after,
            limit: batchSize,
          });

          // A rebuild against a revoked installation is still the operator's, but
          // one against a tombstoned installation has nothing left to build over.
          if (!progress.admitted) {
            return storageFailure("denied", "Storage for this installation is not available");
          }

          batchCount += 1;
          rebuiltCount += progress.value.rebuiltCount;
          if (progress.value.rebuiltCount < batchSize || progress.value.lastKey === null) {
            return storageSuccess({ rebuiltCount, batchCount });
          }
          after = progress.value.lastKey;
        }

        return storageFailure(
          "internal",
          `Rebuilding index ${index.id} did not finish within the batches one rebuild takes`,
        );
      } catch (error) {
        return classifyStorageFailure(error);
      }
    },
  };
};
