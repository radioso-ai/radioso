import type { StorageOperation } from "@radioso/app-contract";

import { resolveTtlSeconds } from "../domain/expiry.js";
import { buildStorageIndexEntries } from "../domain/indexEntries.js";
import { isOperationAllowed, namesDeclaredCollection } from "../domain/operations.js";
import { resolveQuotaCeiling } from "../domain/quota.js";
import { resolveStorageQuery } from "../domain/queryBounds.js";
import { validateStorageRecord } from "../domain/recordValidation.js";
import {
  classifyStorageFailure,
  storageFailure,
  storageSuccess,
  type AppStorageResult,
} from "../domain/results.js";
import type {
  AppStorageAdmitted,
  AppStorageCollectionScope,
  AppStorageDeleteOutcome,
  AppStorageLiveUsage,
  AppStorageRepositoryPort,
  StoredAppStorageRecord,
} from "../ports/appStorageRepository.js";
import type {
  AppStorageOperation,
  AppStorageService,
  StorageDeleteResult,
  StorageGetResult,
  StoragePutResult,
  StorageQueryResult,
} from "../ports/appStorageService.js";

interface AppStorageServiceOptions {
  repository: AppStorageRepositoryPort;
}

/**
 * What an App observes of one record. The stored row carries a schema version and
 * a byte size the host uses for compatibility and quota accounting; neither is an
 * App's business, so neither crosses back over the wire.
 */
const toStorageRecord = (record: StoredAppStorageRecord): NonNullable<StorageGetResult["record"]> => ({
  key: record.key,
  version: record.version,
  updatedAt: record.updatedAt.toISOString(),
  record: record.value,
});

const revoked = <TValue>(): AppStorageResult<TValue> =>
  storageFailure("denied", "Storage access for this installation is not available");

/**
 * The storage half of the host capability surface. Every operation is admitted
 * against three things the App does not control: the collection declaration the
 * operator approved at install, the installation's current access, and the
 * quotas and versions the repository enforces inside the write itself.
 *
 * Access is not checked here. A check before the write is a check a revocation
 * can land behind, so the repository decides it inside the operation's own
 * transaction while holding the installation's state row, and what reaches this
 * layer is an operation that either took effect or was refused at the point it
 * would have.
 *
 * Nothing here throws. A caller gets a value or one of the runtime protocol's
 * error codes, because the gateway in front of this cannot be left to guess
 * which failures belong to the App and which belong to the host — including the
 * ones the database raises, which arrive as `unavailable` or `internal`.
 */
export const createAppStorageService = (options: AppStorageServiceOptions): AppStorageService => {
  const { repository } = options;

  /**
   * The one check that costs nothing: a request naming a collection other than
   * the one resolved for it is refused before any read.
   */
  const namesItsOwnCollection = <TRequest extends { collection: string }>(
    input: AppStorageOperation<TRequest>,
  ): AppStorageResult<never> | null =>
    namesDeclaredCollection(input.collection, input.request.collection)
      ? null
      : storageFailure(
          "invalid_input",
          `This installation declares no collection named ${input.request.collection}`,
        );

  /**
   * `allowedOperations` is the App's own declaration of what it does with a
   * collection, and the operator approved that list at install. Holding the
   * storage permission is not holding every operation.
   */
  const requireOperation = <TValue>(
    input: AppStorageOperation<unknown>,
    operation: StorageOperation,
  ): AppStorageResult<TValue> | null =>
    isOperationAllowed(input.collection, operation)
      ? null
      : storageFailure("denied", `Collection ${input.collection.id} does not allow ${operation}`);

  const scopeOf = (input: {
    workspaceId: string;
    installationId: string;
    collection: { id: string };
  }): AppStorageCollectionScope => ({
    workspaceId: input.workspaceId,
    installationId: input.installationId,
    collectionId: input.collection.id,
  });

  /**
   * Runs the persistence half and turns anything it raises into a typed result.
   * A driver error carries the statement that failed, and the statement carries
   * the record, so none of it is allowed into the message.
   */
  const attempt = async <TValue>(
    operation: () => Promise<AppStorageResult<TValue>>,
  ): Promise<AppStorageResult<TValue>> => {
    try {
      return await operation();
    } catch (error) {
      return classifyStorageFailure(error);
    }
  };

  const mapAdmitted = <TRow, TValue>(
    admitted: AppStorageAdmitted<TRow>,
    onValue: (value: TRow) => AppStorageResult<TValue>,
  ): AppStorageResult<TValue> => (admitted.admitted ? onValue(admitted.value) : revoked());

  return {
    async get(input): Promise<AppStorageResult<StorageGetResult>> {
      const misnamed = namesItsOwnCollection(input);
      if (misnamed) return misnamed;
      const notAllowed = requireOperation<StorageGetResult>(input, "get");
      if (notAllowed) return notAllowed;

      return attempt(async () => {
        const found = await repository.findRecord(scopeOf(input), input.request.key);
        return mapAdmitted(found, (record) =>
          storageSuccess({ record: record ? toStorageRecord(record) : null }),
        );
      });
    },

    async put(input): Promise<AppStorageResult<StoragePutResult>> {
      const misnamed = namesItsOwnCollection(input);
      if (misnamed) return misnamed;
      const notAllowed = requireOperation<StoragePutResult>(input, "put");
      if (notAllowed) return notAllowed;

      const validation = validateStorageRecord(input.collection, input.request.record);
      if (!validation.ok) return storageFailure(validation.code, validation.message);

      return attempt(async () => {
        const written = await repository.putRecord({
          scope: scopeOf(input),
          key: input.request.key,
          value: validation.record,
          byteSize: validation.byteSize,
          schemaVersion: input.collection.schemaVersion,
          ttlSeconds: resolveTtlSeconds(input.collection),
          expectedVersion: input.request.expectedVersion ?? null,
          indexEntries: buildStorageIndexEntries(input.collection, validation.record),
          maxRecords: resolveQuotaCeiling(input.collection).maxRecords,
        });

        return mapAdmitted(written, (outcome) => {
          switch (outcome.outcome) {
            case "stored":
              return storageSuccess({ version: outcome.version });
            case "quota_exceeded":
              return storageFailure(
                "quota_exceeded",
                `Collection ${input.collection.id} holds the ${input.collection.quotas.maxRecords} records it admits`,
              );
            case "version_conflict":
              return storageFailure("version_conflict", "The record changed since the version this write expected");
            case "not_found":
              return storageFailure("not_found", "A fenced write found no record under this key");
            // The collection's version counter reached the last value a JSON
            // number carries exactly. Continuing would hand two writes the same
            // fence, so the collection stops writing and says so in the one way
            // that does not blame the caller for it.
            case "version_exhausted":
              return storageFailure(
                "internal",
                "Storage cannot accept further writes to this collection",
              );
          }
        });
      });
    },

    async delete(input): Promise<AppStorageResult<StorageDeleteResult>> {
      const misnamed = namesItsOwnCollection(input);
      if (misnamed) return misnamed;
      const notAllowed = requireOperation<StorageDeleteResult>(input, "delete");
      if (notAllowed) return notAllowed;

      return attempt(async () => {
        const removed = await repository.deleteRecord({
          scope: scopeOf(input),
          key: input.request.key,
          expectedVersion: input.request.expectedVersion ?? null,
        });

        return mapAdmitted<AppStorageDeleteOutcome, StorageDeleteResult>(removed, (outcome) => {
          switch (outcome.outcome) {
            case "deleted":
              return storageSuccess({ deleted: true });
            // An unfenced delete of a key that is not there is the state the caller
            // asked for, so it succeeds having removed nothing.
            case "missing":
              return storageSuccess({ deleted: false });
            case "not_found":
              return storageFailure("not_found", "A fenced delete found no record under this key");
            case "version_conflict":
              return storageFailure("version_conflict", "The record changed since the version this delete expected");
          }
        });
      });
    },

    async query(input): Promise<AppStorageResult<StorageQueryResult>> {
      const misnamed = namesItsOwnCollection(input);
      if (misnamed) return misnamed;

      const resolved = resolveStorageQuery(input.collection, input.request);
      if (!resolved.ok) return { ok: false, error: resolved.error };

      return attempt(async () => {
        // One row past the page decides whether another page exists, so a caller
        // never pays for a second count over the same index to find out.
        const found = await repository.queryByIndex({
          scope: scopeOf(input),
          indexId: resolved.value.indexId,
          column: resolved.value.equals.column,
          value: resolved.value.equals.value,
          limit: resolved.value.limit + 1,
          cursor: resolved.value.cursor,
        });

        return mapAdmitted(found, (rows) => {
          const page = rows.slice(0, resolved.value.limit);
          const hasMore = rows.length > page.length;

          return storageSuccess({
            records: page.map(toStorageRecord),
            // The cursor a page resumes after is its own last key, so it is absent
            // exactly when the index held nothing past this page.
            cursor: hasMore ? page[page.length - 1]?.key : undefined,
          });
        });
      });
    },

    async usage(input): Promise<AppStorageResult<AppStorageLiveUsage>> {
      return attempt(async () => {
        const read = await repository.readCollectionUsage(scopeOf(input));
        return mapAdmitted(read, (usage) => storageSuccess(usage));
      });
    },

    async storedSchemaVersions(scope): Promise<AppStorageResult<number[]>> {
      return attempt(async () => {
        const found = await repository.listStoredSchemaVersions(scope);
        return mapAdmitted(found, (versions) => storageSuccess(versions));
      });
    },
  };
};
