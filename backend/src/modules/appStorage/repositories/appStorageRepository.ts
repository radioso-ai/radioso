import type { BoundedJsonRecord } from "@radioso/app-contract";
import type { Kysely, Transaction } from "kysely";

import { currentTimestamp, nowPlusSeconds, toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { DB } from "../../../shared/infra/kysely/schema.js";
import { buildStorageIndexEntry, type AppStorageIndexEntry } from "../domain/indexEntries.js";
import { exceedsRecordQuota, type AppStorageCollectionUsage } from "../domain/quota.js";
import type {
  AppStorageAdmitted,
  AppStorageCollectionScope,
  AppStorageDeleteCommand,
  AppStorageDeleteOutcome,
  AppStorageIndexRebuildBatch,
  AppStorageIndexRebuildProgress,
  AppStorageInstallationDeletion,
  AppStorageInstallationScope,
  AppStorageInstallationState,
  AppStoragePutCommand,
  AppStoragePutOutcome,
  AppStorageQuery,
  AppStorageRepositoryPort,
  ExportedAppStorageRecord,
  StoredAppStorageRecord,
} from "../ports/appStorageRepository.js";

interface RecordRow {
  record_key: string;
  version: string | number | bigint;
  schema_version: number;
  updated_at: Date;
  value: unknown;
}

interface ExportRow extends RecordRow {
  collection_id: string;
}

/** Where an export resumes: the last (collection, key) pair a page yielded. */
interface ExportCursor {
  collectionId: string;
  recordKey: string;
}

/** The counter row's contents, plus the version the next write in the collection takes. */
interface LockedCollectionUsage extends AppStorageCollectionUsage {
  nextVersion: number;
}

/**
 * Which lock an operation takes on the installation's state row. Anything that
 * changes rows takes it exclusively, so a revocation or a deletion cannot commit
 * between the moment the operation was admitted and the moment it takes effect;
 * a read only has to keep the row still while it looks at it.
 */
type FenceMode = "share" | "update";

interface FenceOptions {
  mode: FenceMode;
  /**
   * Revocation is about the App's authority, not the operator's. A runtime call
   * is refused while access is revoked; an export or a retention change is the
   * operator acting on data the App can no longer reach, and is not.
   */
  denyWhenRevoked: boolean;
}

const denied = { admitted: false } as const;
const admit = <TValue>(value: TValue): AppStorageAdmitted<TValue> => ({ admitted: true, value });

const mapRecord = (row: RecordRow): StoredAppStorageRecord => ({
  key: row.record_key,
  version: Number(row.version),
  schemaVersion: row.schema_version,
  updatedAt: new Date(row.updated_at),
  // The column holds what `validateStorageRecord` admitted, and nothing else
  // writes it, so the stored shape is the shape that was validated.
  value: (row.value ?? {}) as BoundedJsonRecord,
});

const EXPORT_PAGE_MINIMUM = 1;

/**
 * The physical model behind managed App Storage: generic record rows, generic
 * index-entry rows, a maintained per-collection counter, and one state row per
 * installation. It is Radioso's and replaceable — an App declares collections and
 * never observes a table.
 *
 * Two rules hold across every method here, and everything else follows from them.
 *
 * Locks are taken in one order: the installation state row, then the collection's
 * counter row, then record rows. A sweep, a put, a delete, and a rebuild all
 * approach the same rows from the same side, so none of them can be left waiting
 * on a lock another already holds in the opposite order.
 *
 * Liveness is decided by the database's own clock inside the transaction that
 * acts on it. A caller's timestamp is read before it queues for a lock and can be
 * arbitrarily old by the time it wins one, which is how a record past its
 * deadline gets renewed instead of reclaimed.
 */
export class AppStorageRepository implements AppStorageRepositoryPort {
  constructor(private readonly db: Kysely<DB>) {}

  async findInstallationState(
    scope: AppStorageInstallationScope,
  ): Promise<AppStorageInstallationState | null> {
    const row = await this.db
      .selectFrom("app_storage_installation_state")
      .select(["access_revoked_at", "retain_until", "deleted_at"])
      .where("workspace_id", "=", scope.workspaceId)
      .where("installation_id", "=", scope.installationId)
      .executeTakeFirst();

    if (!row) return null;
    return {
      accessRevokedAt: row.access_revoked_at ? new Date(row.access_revoked_at) : null,
      retainUntil: row.retain_until ? new Date(row.retain_until) : null,
      deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
    };
  }

  async setAccessRevoked(
    scope: AppStorageInstallationScope,
    revokedAt: Date | null,
  ): Promise<AppStorageAdmitted<void>> {
    return this.db.transaction().execute(async (trx) => {
      if (!(await this.fence(trx, scope, { mode: "update", denyWhenRevoked: false }))) return denied;

      await trx
        .updateTable("app_storage_installation_state")
        .set({ access_revoked_at: revokedAt, updated_at: currentTimestamp() })
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .execute();

      return admit(undefined);
    });
  }

  async setRetention(
    scope: AppStorageInstallationScope,
    retainUntil: Date | null,
  ): Promise<AppStorageAdmitted<void>> {
    return this.db.transaction().execute(async (trx) => {
      if (!(await this.fence(trx, scope, { mode: "update", denyWhenRevoked: false }))) return denied;

      await trx
        .updateTable("app_storage_installation_state")
        .set({ retain_until: retainUntil, updated_at: currentTimestamp() })
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .execute();

      return admit(undefined);
    });
  }

  async findRecord(
    scope: AppStorageCollectionScope,
    key: string,
  ): Promise<AppStorageAdmitted<StoredAppStorageRecord | null>> {
    return this.db.transaction().execute(async (trx) => {
      if (!(await this.fence(trx, scope, { mode: "share", denyWhenRevoked: true }))) return denied;

      const row = await trx
        .selectFrom("app_storage_records")
        .select(["record_key", "version", "schema_version", "updated_at", "value"])
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where("collection_id", "=", scope.collectionId)
        .where("record_key", "=", key)
        .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", currentTimestamp())]))
        .executeTakeFirst();

      return admit(row ? mapRecord(row) : null);
    });
  }

  /**
   * The whole write in one transaction: fence the installation, take the
   * collection's counter row, give back what expired under it, settle the version
   * fence and the quota, then move the record, its index entries, and the counter
   * together.
   *
   * Expired rows are reclaimed before the quota is read, so a collection at its
   * ceiling whose records have all expired admits the next write immediately
   * rather than at whatever time a maintenance pass happens to run.
   */
  async putRecord(command: AppStoragePutCommand): Promise<AppStorageAdmitted<AppStoragePutOutcome>> {
    const { scope } = command;

    return this.db.transaction().execute(async (trx) => {
      if (!(await this.fence(trx, scope, { mode: "update", denyWhenRevoked: true }))) return denied;

      const usage = await this.lockCollectionUsage(trx, scope);
      const live = await this.reclaimUnderLock(trx, scope, usage, null);

      const existing = await trx
        .selectFrom("app_storage_records")
        .select(["version", "byte_size"])
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where("collection_id", "=", scope.collectionId)
        .where("record_key", "=", command.key)
        .forUpdate()
        .executeTakeFirst();

      if (command.expectedVersion !== null) {
        if (!existing) return admit({ outcome: "not_found" } as const);
        if (Number(existing.version) !== command.expectedVersion) {
          return admit({ outcome: "version_conflict" } as const);
        }
      }

      if (exceedsRecordQuota(live, { maxRecords: command.maxRecords }, !existing)) {
        return admit({ outcome: "quota_exceeded" } as const);
      }

      // The version comes from the collection's counter, not from the row being
      // replaced, so a key that was deleted and written again never repeats a
      // version a client may still be holding.
      const version = usage.nextVersion;
      const expiresAt = command.ttlSeconds === null ? null : nowPlusSeconds(command.ttlSeconds);

      await trx
        .insertInto("app_storage_records")
        .values({
          workspace_id: scope.workspaceId,
          installation_id: scope.installationId,
          collection_id: scope.collectionId,
          record_key: command.key,
          schema_version: command.schemaVersion,
          value: toJsonb(command.value),
          byte_size: command.byteSize,
          version,
          expires_at: expiresAt,
        })
        .onConflict((conflict) =>
          conflict
            .columns(["workspace_id", "installation_id", "collection_id", "record_key"])
            .doUpdateSet({
              schema_version: command.schemaVersion,
              value: toJsonb(command.value),
              byte_size: command.byteSize,
              version,
              expires_at: expiresAt,
              updated_at: currentTimestamp(),
            }),
        )
        .execute();

      await this.replaceIndexEntries(trx, scope, command.key, command.indexEntries);

      await this.writeCollectionUsage(trx, scope, {
        recordCount: existing ? live.recordCount : live.recordCount + 1,
        byteSize: Math.max(0, live.byteSize - Number(existing?.byte_size ?? 0) + command.byteSize),
        nextVersion: version + 1,
      });

      return admit({ outcome: "stored", version } as const);
    });
  }

  async deleteRecord(command: AppStorageDeleteCommand): Promise<AppStorageAdmitted<AppStorageDeleteOutcome>> {
    const { scope } = command;

    return this.db.transaction().execute(async (trx) => {
      if (!(await this.fence(trx, scope, { mode: "update", denyWhenRevoked: true }))) return denied;

      const usage = await this.lockCollectionUsage(trx, scope);
      const live = await this.reclaimUnderLock(trx, scope, usage, null);

      const existing = await trx
        .selectFrom("app_storage_records")
        .select(["version", "byte_size"])
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where("collection_id", "=", scope.collectionId)
        .where("record_key", "=", command.key)
        .forUpdate()
        .executeTakeFirst();

      // A record already past its deadline was reclaimed above, so a delete that
      // finds nothing removed nothing the caller could observe either way.
      if (command.expectedVersion !== null) {
        if (!existing) return admit({ outcome: "not_found" } as const);
        if (Number(existing.version) !== command.expectedVersion) {
          return admit({ outcome: "version_conflict" } as const);
        }
      }

      if (!existing) return admit({ outcome: "missing" } as const);

      // Index entries follow the record through the foreign key's cascade.
      await trx
        .deleteFrom("app_storage_records")
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where("collection_id", "=", scope.collectionId)
        .where("record_key", "=", command.key)
        .execute();

      await this.writeCollectionUsage(trx, scope, {
        recordCount: Math.max(0, live.recordCount - 1),
        byteSize: Math.max(0, live.byteSize - Number(existing.byte_size)),
        nextVersion: usage.nextVersion,
      });

      return admit({ outcome: "deleted" } as const);
    });
  }

  async queryByIndex(query: AppStorageQuery): Promise<AppStorageAdmitted<StoredAppStorageRecord[]>> {
    return this.db.transaction().execute(async (trx) => {
      if (!(await this.fence(trx, query.scope, { mode: "share", denyWhenRevoked: true }))) return denied;

      // The page is ordered by the key it resumes from, so a cursor is the last key
      // rather than an offset a concurrent write could shift under the reader.
      const rows = await trx
        .selectFrom("app_storage_index_entries as e")
        .innerJoin("app_storage_records as r", (join) =>
          join
            .onRef("r.workspace_id", "=", "e.workspace_id")
            .onRef("r.installation_id", "=", "e.installation_id")
            .onRef("r.collection_id", "=", "e.collection_id")
            .onRef("r.record_key", "=", "e.record_key"),
        )
        .select(["r.record_key", "r.version", "r.schema_version", "r.updated_at", "r.value"])
        .where("e.workspace_id", "=", query.scope.workspaceId)
        .where("e.installation_id", "=", query.scope.installationId)
        .where("e.collection_id", "=", query.scope.collectionId)
        .where("e.index_id", "=", query.indexId)
        .where((eb) => {
          // The declared field type decided which column carries the value, so the
          // comparison happens in that type's own ordering rather than as text.
          switch (query.column) {
            case "text_value":
              return eb("e.text_value", "=", String(query.value));
            case "numeric_value":
              return eb("e.numeric_value", "=", Number(query.value));
            case "boolean_value":
              return eb("e.boolean_value", "=", Boolean(query.value));
            case "timestamp_value":
              return eb("e.timestamp_value", "=", query.value as Date);
          }
        })
        .where((eb) => eb.or([eb("r.expires_at", "is", null), eb("r.expires_at", ">", currentTimestamp())]))
        .$if(query.cursor !== null, (qb) => qb.where("r.record_key", ">", query.cursor ?? ""))
        .orderBy("r.record_key", "asc")
        .limit(query.limit)
        .execute();

      return admit(rows.map(mapRecord));
    });
  }

  /**
   * Usage is reported live. Expired rows are reclaimed under the same counter lock
   * a write would take, so what an operator reads is what the next write is
   * admitted against rather than what a maintenance pass has caught up to.
   */
  async readCollectionUsage(
    scope: AppStorageCollectionScope,
  ): Promise<AppStorageAdmitted<AppStorageCollectionUsage>> {
    return this.db.transaction().execute(async (trx) => {
      if (!(await this.fence(trx, scope, { mode: "share", denyWhenRevoked: true }))) return denied;

      const usage = await this.lockCollectionUsage(trx, scope);
      const live = await this.reclaimUnderLock(trx, scope, usage, null);
      return admit({ recordCount: live.recordCount, byteSize: live.byteSize });
    });
  }

  /**
   * Builds one declared index over records that were written before it existed.
   * An index entry is per record, so an index a release adds finds nothing until
   * this has run over the collection — which is why activation waits for it.
   */
  async rebuildIndexBatch(
    batch: AppStorageIndexRebuildBatch,
  ): Promise<AppStorageAdmitted<AppStorageIndexRebuildProgress>> {
    const { scope } = batch;

    return this.db.transaction().execute(async (trx) => {
      if (!(await this.fence(trx, scope, { mode: "update", denyWhenRevoked: false }))) return denied;

      await this.lockCollectionUsage(trx, scope);

      const rows = await trx
        .selectFrom("app_storage_records")
        .select(["record_key", "value"])
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where("collection_id", "=", scope.collectionId)
        .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", currentTimestamp())]))
        .$if(batch.after !== null, (qb) => qb.where("record_key", ">", batch.after ?? ""))
        .orderBy("record_key", "asc")
        .limit(batch.limit)
        .forUpdate()
        .execute();

      if (rows.length === 0) return admit({ rebuiltCount: 0, lastKey: null });

      const keys = rows.map((row) => row.record_key);
      await trx
        .deleteFrom("app_storage_index_entries")
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where("collection_id", "=", scope.collectionId)
        .where("index_id", "=", batch.index.id)
        .where("record_key", "in", keys)
        .execute();

      const values = rows.flatMap((row) => {
        const record = (row.value ?? {}) as BoundedJsonRecord;
        if (!Object.hasOwn(record, batch.index.field)) return [];
        const entry = buildStorageIndexEntry({
          indexId: batch.index.id,
          fieldType: batch.index.fieldType,
          value: record[batch.index.field],
        });
        return entry ? [this.toIndexRow(scope, row.record_key, entry)] : [];
      });

      if (values.length > 0) {
        await trx.insertInto("app_storage_index_entries").values(values).execute();
      }

      return admit({ rebuiltCount: rows.length, lastKey: keys[keys.length - 1] ?? null });
    });
  }

  async listCollectionsWithExpiredRecords(limit: number): Promise<AppStorageCollectionScope[]> {
    const rows = await this.db
      .selectFrom("app_storage_records")
      .select(["workspace_id", "installation_id", "collection_id"])
      .distinct()
      .where("expires_at", "is not", null)
      .where((eb) => eb("expires_at", "<=", currentTimestamp()))
      .limit(limit)
      .execute();

    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      installationId: row.installation_id,
      collectionId: row.collection_id,
    }));
  }

  /**
   * Reclaims one bounded batch of a single collection's expired rows. The counter
   * row is taken first and the rows are removed by a conditional delete that
   * reports what it actually took, so the counter is decremented by exactly that
   * and never by what a preceding read expected to find.
   */
  async reclaimExpiredRecords(input: {
    scope: AppStorageCollectionScope;
    limit: number;
  }): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const usage = await this.lockCollectionUsage(trx, input.scope);
      const before = usage.recordCount;
      const live = await this.reclaimUnderLock(trx, input.scope, usage, input.limit);
      return before - live.recordCount;
    });
  }

  async listInstallationsDueForRetention(limit: number): Promise<AppStorageInstallationScope[]> {
    const rows = await this.db
      .selectFrom("app_storage_installation_state")
      .select(["workspace_id", "installation_id"])
      .where("retain_until", "is not", null)
      .where((eb) => eb("retain_until", "<=", currentTimestamp()))
      .where("deleted_at", "is", null)
      .orderBy("retain_until", "asc")
      .limit(limit)
      .execute();

    return rows.map((row) => ({ workspaceId: row.workspace_id, installationId: row.installation_id }));
  }

  /**
   * An export reads by key range rather than by offset, so it holds no cursor in
   * the database and a large installation is never materialized in one result set.
   * Every page is measured against the snapshot the first one took, so a record
   * whose deadline passes mid-export is either in the whole export or in none of
   * it, and a page is refused once the installation is tombstoned.
   */
  async *streamInstallationRecords(input: {
    scope: AppStorageInstallationScope;
    batchSize: number;
  }): AsyncIterable<ExportedAppStorageRecord> {
    const batchSize = Math.max(EXPORT_PAGE_MINIMUM, input.batchSize);
    let after: ExportCursor | null = null;
    let snapshotAt: Date | null = null;

    for (;;) {
      const page = await this.readExportPage(input.scope, batchSize, after, snapshotAt);
      if (!page) return;
      snapshotAt = page.snapshotAt;
      const last = page.rows[page.rows.length - 1];

      for (const row of page.rows) {
        yield { ...mapRecord(row), collectionId: row.collection_id };
      }

      if (page.rows.length < batchSize || !last) return;
      after = { collectionId: last.collection_id, recordKey: last.record_key };
    }
  }

  private async readExportPage(
    scope: AppStorageInstallationScope,
    batchSize: number,
    after: ExportCursor | null,
    snapshotAt: Date | null,
  ): Promise<{ rows: ExportRow[]; snapshotAt: Date } | null> {
    return this.db.transaction().execute(async (trx) => {
      if (!(await this.fence(trx, scope, { mode: "share", denyWhenRevoked: false }))) return null;

      const snapshot =
        snapshotAt ??
        (await trx
          .selectFrom("app_storage_installation_state")
          .select(currentTimestamp().as("snapshot_at"))
          .where("workspace_id", "=", scope.workspaceId)
          .where("installation_id", "=", scope.installationId)
          .executeTakeFirstOrThrow()).snapshot_at;

      const rows = await trx
        .selectFrom("app_storage_records")
        .select(["collection_id", "record_key", "version", "schema_version", "updated_at", "value"])
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", snapshot)]))
        .$if(after !== null, (qb) =>
          qb.where((eb) =>
            eb.or([
              eb("collection_id", ">", after?.collectionId ?? ""),
              eb.and([
                eb("collection_id", "=", after?.collectionId ?? ""),
                eb("record_key", ">", after?.recordKey ?? ""),
              ]),
            ]),
          ),
        )
        .orderBy("collection_id", "asc")
        .orderBy("record_key", "asc")
        .limit(batchSize)
        .execute();

      return { rows, snapshotAt: new Date(snapshot) };
    });
  }

  /**
   * Removes an installation's data and leaves the tombstone behind. The state row
   * outlives the rows it accounted for, so an operation that was in flight when
   * the deletion committed is refused rather than allowed to recreate a record
   * under an installation that no longer holds any.
   */
  async deleteInstallationRecords(
    scope: AppStorageInstallationScope,
  ): Promise<AppStorageAdmitted<AppStorageInstallationDeletion>> {
    return this.db.transaction().execute(async (trx) => {
      if (!(await this.fence(trx, scope, { mode: "update", denyWhenRevoked: false }))) return denied;

      const deleted = await trx
        .deleteFrom("app_storage_records")
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .returning("collection_id")
        .execute();

      await trx
        .deleteFrom("app_storage_collection_usage")
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .execute();

      await trx
        .updateTable("app_storage_installation_state")
        .set({
          deleted_at: currentTimestamp(),
          retain_until: null,
          updated_at: currentTimestamp(),
        })
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .execute();

      return admit({
        recordCount: deleted.length,
        collectionCount: new Set(deleted.map((row) => row.collection_id)).size,
      });
    });
  }

  async deleteWorkspaceRecords(
    workspaceId: string,
  ): Promise<{ recordCount: number; installationCount: number }> {
    return this.db.transaction().execute(async (trx) => {
      const deleted = await trx
        .deleteFrom("app_storage_records")
        .where("workspace_id", "=", workspaceId)
        .returning("installation_id")
        .execute();

      await trx.deleteFrom("app_storage_collection_usage").where("workspace_id", "=", workspaceId).execute();
      await trx.deleteFrom("app_storage_installation_state").where("workspace_id", "=", workspaceId).execute();

      return {
        recordCount: deleted.length,
        installationCount: new Set(deleted.map((row) => row.installation_id)).size,
      };
    });
  }

  /**
   * Takes the installation's state row and answers whether the operation still
   * has authority. The row is created on first touch so that there is always
   * something to lock; without it, a revocation that inserts the row would have
   * nothing to serialize an in-flight operation against.
   */
  private async fence(
    trx: Transaction<DB>,
    scope: AppStorageInstallationScope,
    options: FenceOptions,
  ): Promise<boolean> {
    await trx
      .insertInto("app_storage_installation_state")
      .values({ workspace_id: scope.workspaceId, installation_id: scope.installationId })
      .onConflict((conflict) => conflict.columns(["workspace_id", "installation_id"]).doNothing())
      .execute();

    const query = trx
      .selectFrom("app_storage_installation_state")
      .select(["access_revoked_at", "deleted_at"])
      .where("workspace_id", "=", scope.workspaceId)
      .where("installation_id", "=", scope.installationId);

    const row =
      options.mode === "update"
        ? await query.forUpdate().executeTakeFirst()
        : await query.forShare().executeTakeFirst();

    if (!row) return false;
    if (row.deleted_at !== null) return false;
    return !(options.denyWhenRevoked && row.access_revoked_at !== null);
  }

  /**
   * Creates the collection's counter row if this is its first write, then locks
   * it. Everything a quota decision reads happens after this line.
   */
  private async lockCollectionUsage(
    trx: Transaction<DB>,
    scope: AppStorageCollectionScope,
  ): Promise<LockedCollectionUsage> {
    await trx
      .insertInto("app_storage_collection_usage")
      .values({
        workspace_id: scope.workspaceId,
        installation_id: scope.installationId,
        collection_id: scope.collectionId,
      })
      .onConflict((conflict) =>
        conflict.columns(["workspace_id", "installation_id", "collection_id"]).doNothing(),
      )
      .execute();

    const row = await trx
      .selectFrom("app_storage_collection_usage")
      .select(["record_count", "byte_size", "next_version"])
      .where("workspace_id", "=", scope.workspaceId)
      .where("installation_id", "=", scope.installationId)
      .where("collection_id", "=", scope.collectionId)
      .forUpdate()
      .executeTakeFirst();

    return {
      recordCount: row?.record_count ?? 0,
      byteSize: Number(row?.byte_size ?? 0),
      nextVersion: Number(row?.next_version ?? 1),
    };
  }

  /**
   * Gives back what expired, under the counter lock the caller already holds. The
   * delete names its own predicate and reports the rows it took, so the counter
   * moves by what was removed rather than by what a preceding read saw. `limit`
   * bounds a maintenance pass; a write passes none, because a quota it is about
   * to be admitted against has to account for every expired row, not a page of
   * them.
   */
  private async reclaimUnderLock(
    trx: Transaction<DB>,
    scope: AppStorageCollectionScope,
    usage: LockedCollectionUsage,
    limit: number | null,
  ): Promise<AppStorageCollectionUsage> {
    const reclaimed = await trx
      .deleteFrom("app_storage_records")
      .where("workspace_id", "=", scope.workspaceId)
      .where("installation_id", "=", scope.installationId)
      .where("collection_id", "=", scope.collectionId)
      .where("expires_at", "is not", null)
      .where((eb) => eb("expires_at", "<=", currentTimestamp()))
      .$if(limit !== null, (qb) =>
        qb.where("record_key", "in", (inner) =>
          inner
            .selectFrom("app_storage_records")
            .select("record_key")
            .where("workspace_id", "=", scope.workspaceId)
            .where("installation_id", "=", scope.installationId)
            .where("collection_id", "=", scope.collectionId)
            .where("expires_at", "is not", null)
            .where((eb) => eb("expires_at", "<=", currentTimestamp()))
            .orderBy("expires_at", "asc")
            .limit(limit ?? 0),
        ),
      )
      .returning("byte_size")
      .execute();

    if (reclaimed.length === 0) {
      return { recordCount: usage.recordCount, byteSize: usage.byteSize };
    }

    const reclaimedBytes = reclaimed.reduce((total, row) => total + Number(row.byte_size), 0);
    const live: AppStorageCollectionUsage = {
      recordCount: Math.max(0, usage.recordCount - reclaimed.length),
      byteSize: Math.max(0, usage.byteSize - reclaimedBytes),
    };

    // Written straight away rather than folded into the caller's own update: a
    // put that goes on to refuse the write still has to leave the counter
    // describing the rows that are actually there.
    await this.writeCollectionUsage(trx, scope, { ...live, nextVersion: usage.nextVersion });
    return live;
  }

  private async writeCollectionUsage(
    trx: Transaction<DB>,
    scope: AppStorageCollectionScope,
    usage: LockedCollectionUsage,
  ): Promise<void> {
    await trx
      .updateTable("app_storage_collection_usage")
      .set({
        record_count: usage.recordCount,
        byte_size: usage.byteSize,
        next_version: usage.nextVersion,
        updated_at: currentTimestamp(),
      })
      .where("workspace_id", "=", scope.workspaceId)
      .where("installation_id", "=", scope.installationId)
      .where("collection_id", "=", scope.collectionId)
      .execute();
  }

  private toIndexRow(
    scope: AppStorageCollectionScope,
    key: string,
    entry: AppStorageIndexEntry,
  ): {
    workspace_id: string;
    installation_id: string;
    collection_id: string;
    record_key: string;
    index_id: string;
    text_value: string | null;
    numeric_value: number | null;
    boolean_value: boolean | null;
    timestamp_value: Date | null;
  } {
    return {
      workspace_id: scope.workspaceId,
      installation_id: scope.installationId,
      collection_id: scope.collectionId,
      record_key: key,
      index_id: entry.indexId,
      text_value: entry.textValue,
      numeric_value: entry.numericValue,
      boolean_value: entry.booleanValue,
      timestamp_value: entry.timestampValue,
    };
  }

  private async replaceIndexEntries(
    trx: Transaction<DB>,
    scope: AppStorageCollectionScope,
    key: string,
    entries: readonly AppStorageIndexEntry[],
  ): Promise<void> {
    await trx
      .deleteFrom("app_storage_index_entries")
      .where("workspace_id", "=", scope.workspaceId)
      .where("installation_id", "=", scope.installationId)
      .where("collection_id", "=", scope.collectionId)
      .where("record_key", "=", key)
      .execute();

    if (entries.length === 0) return;

    await trx
      .insertInto("app_storage_index_entries")
      .values(entries.map((entry) => this.toIndexRow(scope, key, entry)))
      .execute();
  }
}
