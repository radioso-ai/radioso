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
 * How many incompatible records a rebuild names before it stops looking. The
 * rebuild has already failed by then, and the remaining passes would only make
 * the count larger and the set of keys held in memory unbounded.
 */
const INCOMPATIBLE_CEILING = 1_000;

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
 * catches whatever landed behind the cursor.
 *
 * The marker has an owner and an end. Each rebuild takes a generation, so two
 * overlapping rebuilds of one index cannot clear each other's marker; converging
 * stamps the rebuild rather than clearing it, and hands back the token the
 * activation presents to clear it in the same transaction that starts serving the
 * index. A rebuild that will not be activated cancels its own marker — on a
 * refusal, on a failure, and on anything raised — so an answer this run produced
 * never leaves every future write maintaining an index nobody queries.
 *
 * Running out of batches is the one ending that keeps the marker. The budget
 * bounds a single run rather than the rebuild, and the entries built so far are
 * worth keeping maintained; the marker's lease, renewed by each batch, is what
 * collects it if no further run ever comes.
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
      const unavailable = (): AppStorageResult<AppStorageIndexRebuildResult> =>
        storageFailure("denied", "Storage for this installation is not available");

      // The index is marked pending before a single record is read. From here
      // every put maintains an entry for it as well as for the indexes the
      // writing release declares, so an older release that rewrites a key the
      // first pass already visited does not drop the entry the rebuild put there.
      // `startVersion` is where the closing pass starts looking.
      let started;
      try {
        started = await repository.beginIndexRebuild({ scope, index: descriptor });
      } catch (error) {
        return classifyStorageFailure(error);
      }

      if (!started.admitted) return unavailable();
      if (started.value.outcome === "generation_exhausted") {
        return storageFailure(
          "internal",
          `Storage cannot identify another rebuild on collection ${input.collection.id}`,
        );
      }

      const { startVersion, generation } = started.value;

      /**
       * From here the run owns a marker, so every way out has to say what becomes
       * of it. A run that ends without either converging or cancelling leaves
       * every later write to the collection maintaining an index no release is
       * going to query; the lease on the marker is the backstop for a process
       * that dies outright, not a substitute for cleaning up after an answer this
       * run actually produced.
       *
       * Cancelling is itself compare-and-set and best effort: the marker may
       * already belong to a newer run, and what the caller is owed is the failure
       * that brought us here rather than a second one about the cleanup.
       */
      const cancelOwned = async (): Promise<void> => {
        try {
          await repository.cancelIndexRebuild({ scope, indexId: index.id, generation });
        } catch {
          // The marker's lease is what collects it if this did not.
        }
      };

      try {
        let rebuiltCount = 0;
        let batchCount = 0;

        /**
         * The records whose stored value the index cannot hold, as of the last
         * time each one was looked at. A running count would accumulate history:
         * a record that was too long in the first pass and was corrected before
         * the convergence pass would still be charged against the rebuild, and the
         * candidate would be refused over a value that is no longer there. Every
         * write since the marker went up carries a version at or past it, so the
         * convergence pass revisits exactly the records that could have changed —
         * which makes the latest observation of each key its current state.
         */
        const incompatible = new Set<string>();

        /**
         * How a pass ended. `null` is the ordinary end of a pass; anything else is
         * the run's own answer, and the caller of a pass decides what the marker
         * owes it.
         */
        type PassEnd =
          | null
          /** The marker belongs to another run now, or its lease was collected. */
          | { kind: "superseded" }
          /** Enough records are past the index bound that counting more proves nothing. */
          | { kind: "incompatible" }
          | { kind: "failed"; result: AppStorageResult<AppStorageIndexRebuildResult> }
          /** The batch budget ran out with records still to visit. */
          | { kind: "budget" };

        /** One key-ordered sweep of the collection, optionally limited to what a version marks as new. */
        const pass = async (minVersion: number | null): Promise<PassEnd> => {
          let after: string | null = null;

          while (batchCount < maxBatches) {
            const progress = await repository.rebuildIndexBatch({
              scope,
              index: descriptor,
              generation,
              after,
              limit: batchSize,
              minVersion,
            });

            // A rebuild against a revoked installation is still the operator's,
            // but one against a tombstoned installation has nothing to build over.
            if (!progress.admitted) return { kind: "failed", result: unavailable() };

            // The marker is no longer this run's. Another rebuild of the same
            // index took it over, or its lease ran out and it was collected —
            // either way this run owns nothing and must not cancel what it does
            // not own.
            if (progress.value.stale) return { kind: "superseded" };

            batchCount += 1;
            rebuiltCount += progress.value.rebuiltCount;
            for (const key of progress.value.visitedKeys) incompatible.delete(key);
            for (const key of progress.value.incompatibleKeys) incompatible.add(key);
            if (incompatible.size >= INCOMPATIBLE_CEILING) return { kind: "incompatible" };

            if (progress.value.rebuiltCount < batchSize || progress.value.lastKey === null) return null;
            after = progress.value.lastKey;
          }

          return { kind: "budget" };
        };

        const first = await pass(null);
        // The convergence pass. The batches above ran one transaction at a time,
        // so a write could land behind the cursor while they were running; every
        // such write carries a version at or past the marker, which is exactly
        // the set this pass revisits.
        const ended = first === null ? await pass(startVersion) : first;

        if (ended?.kind === "superseded") {
          // The marker belongs to the run that took it over. Clearing it here
          // would take down the rebuild that is still scanning under it.
          return storageSuccess({ outcome: "superseded", indexId: index.id });
        }

        if (ended?.kind === "failed") {
          await cancelOwned();
          return ended.result;
        }

        if (ended?.kind === "budget") {
          // The batch budget is a limit on one run, not on the rebuild. The
          // marker stays up under its renewed lease, so the entries built so far
          // keep being maintained and another run continues from a fresh
          // generation; if none comes, the lease is what collects it.
          return storageSuccess({
            outcome: "in_progress",
            indexId: index.id,
            rebuiltCount,
            batchCount,
          });
        }

        // A value stored before its field was indexed was never measured against
        // the index's bounds, and one is still there now. The rebuild will not be
        // activated, so its marker comes down: leaving it up would make every
        // future write maintain an index no release is ever going to query.
        if (incompatible.size > 0) {
          await cancelOwned();
          return storageSuccess({
            outcome: "incompatible_records",
            indexId: index.id,
            incompatibleCount: incompatible.size,
          });
        }

        const finished = await repository.finishIndexRebuild({ scope, indexId: index.id, generation });
        if (!finished.admitted) {
          await cancelOwned();
          return unavailable();
        }

        // Another rebuild of this index took the marker over while this one ran.
        // It owns the convergence now, and this run has nothing to hand an
        // activation — including a cancellation.
        if (finished.value.outcome === "stale") {
          return storageSuccess({ outcome: "superseded", indexId: index.id });
        }

        // The closing look at current state, under the fence that would have
        // stamped the rebuild converged. The batches each saw one page at a
        // moment already past; this is the one observation that decides whether
        // the index can be activated at all.
        if (finished.value.outcome === "incompatible_records") {
          await cancelOwned();
          return storageSuccess({
            outcome: "incompatible_records",
            indexId: index.id,
            incompatibleCount: finished.value.incompatibleCount,
          });
        }

        // The marker stays up until activation clears it with this token, in one
        // transaction with the release taking over: between here and there an
        // older release can still rewrite a record, and the marker is the only
        // thing making that write maintain the index.
        return storageSuccess({
          outcome: "rebuilt",
          rebuiltCount,
          batchCount,
          completionToken: finished.value.completionToken,
        });
      } catch (error) {
        await cancelOwned();
        return classifyStorageFailure(error);
      }
    },
  };
};
