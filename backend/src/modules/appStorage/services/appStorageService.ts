import type { StorageOperation } from "@radioso/app-contract";

import { resolveExpiresAt } from "../domain/expiry.js";
import { buildStorageIndexEntries } from "../domain/indexEntries.js";
import { isOperationAllowed, namesDeclaredCollection } from "../domain/operations.js";
import { resolveQuotaCeiling } from "../domain/quota.js";
import { resolveStorageQuery } from "../domain/queryBounds.js";
import { validateStorageRecord } from "../domain/recordValidation.js";
import { storageFailure, storageSuccess, type AppStorageResult } from "../domain/results.js";
import type {
  AppStorageCollectionScope,
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
  now?: () => Date;
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

/**
 * The storage half of the host capability surface. Every operation is admitted
 * against three things the App does not control: the collection declaration the
 * operator approved at install, the installation's current access, and the
 * quotas and versions the repository enforces inside the write itself.
 *
 * Nothing here throws. A caller gets a value or one of the runtime protocol's
 * error codes, because the gateway in front of this cannot be left to guess
 * which failures belong to the App and which belong to the host.
 */
export const createAppStorageService = (options: AppStorageServiceOptions): AppStorageService => {
  const { repository } = options;
  const clock = options.now ?? ((): Date => new Date());

  /**
   * The two checks every operation shares, in the order that costs least: a
   * request naming a collection other than the one resolved for it is refused
   * before any read, and access revoked by disable or quarantine is refused
   * before any effect.
   */
  const admit = async <TRequest extends { collection: string }>(
    input: AppStorageOperation<TRequest>,
  ): Promise<AppStorageResult<never> | null> => {
    if (!namesDeclaredCollection(input.collection, input.request.collection)) {
      return storageFailure(
        "invalid_input",
        `This installation declares no collection named ${input.request.collection}`,
      );
    }

    const state = await repository.findInstallationState({
      workspaceId: input.workspaceId,
      installationId: input.installationId,
    });
    if (state?.accessRevokedAt) {
      return storageFailure("denied", "Storage access for this installation is revoked");
    }

    return null;
  };

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

  const scopeOf = (input: AppStorageOperation<unknown>): AppStorageCollectionScope => ({
    workspaceId: input.workspaceId,
    installationId: input.installationId,
    collectionId: input.collection.id,
  });

  return {
    async get(input): Promise<AppStorageResult<StorageGetResult>> {
      const refusal = await admit(input);
      if (refusal) return refusal;
      const denied = requireOperation<StorageGetResult>(input, "get");
      if (denied) return denied;

      const now = clock();
      const record = await repository.findRecord(scopeOf(input), input.request.key, now);
      return storageSuccess({ record: record ? toStorageRecord(record) : null });
    },

    async put(input): Promise<AppStorageResult<StoragePutResult>> {
      const refusal = await admit(input);
      if (refusal) return refusal;
      const denied = requireOperation<StoragePutResult>(input, "put");
      if (denied) return denied;

      const validation = validateStorageRecord(input.collection, input.request.record);
      if (!validation.ok) return storageFailure(validation.code, validation.message);

      const now = clock();
      const outcome = await repository.putRecord({
        scope: scopeOf(input),
        key: input.request.key,
        value: validation.record,
        byteSize: validation.byteSize,
        schemaVersion: input.collection.schemaVersion,
        expiresAt: resolveExpiresAt(input.collection, now),
        expectedVersion: input.request.expectedVersion ?? null,
        indexEntries: buildStorageIndexEntries(input.collection, validation.record),
        maxRecords: resolveQuotaCeiling(input.collection).maxRecords,
        now,
      });

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
      }
    },

    async delete(input): Promise<AppStorageResult<StorageDeleteResult>> {
      const refusal = await admit(input);
      if (refusal) return refusal;
      const denied = requireOperation<StorageDeleteResult>(input, "delete");
      if (denied) return denied;

      const outcome = await repository.deleteRecord({
        scope: scopeOf(input),
        key: input.request.key,
        expectedVersion: input.request.expectedVersion ?? null,
        now: clock(),
      });

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
    },

    async query(input): Promise<AppStorageResult<StorageQueryResult>> {
      const refusal = await admit(input);
      if (refusal) return refusal;

      const resolved = resolveStorageQuery(input.collection, input.request);
      if (!resolved.ok) return { ok: false, error: resolved.error };

      // One row past the page decides whether another page exists, so a caller
      // never pays for a second count over the same index to find out.
      const rows = await repository.queryByIndex({
        scope: scopeOf(input),
        indexId: resolved.value.indexId,
        column: resolved.value.equals.column,
        value: resolved.value.equals.value,
        limit: resolved.value.limit + 1,
        cursor: resolved.value.cursor,
        now: clock(),
      });

      const page = rows.slice(0, resolved.value.limit);
      const hasMore = rows.length > page.length;

      return storageSuccess({
        records: page.map(toStorageRecord),
        // The cursor a page resumes after is its own last key, so it is absent
        // exactly when the index held nothing past this page.
        cursor: hasMore ? page[page.length - 1]?.key : undefined,
      });
    },

    async usage(input): Promise<AppStorageResult<{ recordCount: number; byteSize: number }>> {
      const usage = await repository.readCollectionUsage({
        workspaceId: input.workspaceId,
        installationId: input.installationId,
        collectionId: input.collection.id,
      });
      return storageSuccess(usage);
    },
  };
};
