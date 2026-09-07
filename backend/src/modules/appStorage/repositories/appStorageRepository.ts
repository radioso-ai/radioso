import type { BoundedJsonRecord } from "@radioso/app-contract";
import type { Kysely, Transaction } from "kysely";

import { currentTimestamp, toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { DB } from "../../../shared/infra/kysely/schema.js";
import type { AppStorageIndexEntry } from "../domain/indexEntries.js";
import { exceedsRecordQuota, type AppStorageCollectionUsage } from "../domain/quota.js";
import type {
  AppStorageCollectionScope,
  AppStorageDeleteCommand,
  AppStorageDeleteOutcome,
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
  version: number;
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

const mapRecord = (row: RecordRow): StoredAppStorageRecord => ({
  key: row.record_key,
  version: row.version,
  schemaVersion: row.schema_version,
  updatedAt: new Date(row.updated_at),
  // The column holds what `validateStorageRecord` admitted, and nothing else
  // writes it, so the stored shape is the shape that was validated.
  value: (row.value ?? {}) as BoundedJsonRecord,
});

/**
 * Whether a row is still readable. Expiry is a property of a read, not of a
 * sweep: a record past its deadline disappears the moment it passes, so no read
 * can be made to depend on how recently maintenance ran.
 */
const isLive = (expiresAt: Date | null, now: Date): boolean =>
  expiresAt === null || new Date(expiresAt) > now;

const EXPORT_PAGE_MINIMUM = 1;

/**
 * The physical model behind managed App Storage: generic record rows, generic
 * index-entry rows, and a maintained per-collection counter. It is Radioso's and
 * replaceable — an App declares collections and never observes a table.
 *
 * Every statement is keyed by workspace and installation first, which is what
 * makes isolation a property of the primary key rather than of a `WHERE` clause
 * some future query might forget.
 */
export class AppStorageRepository implements AppStorageRepositoryPort {
  constructor(private readonly db: Kysely<DB>) {}

  async findInstallationState(
    scope: AppStorageInstallationScope,
  ): Promise<AppStorageInstallationState | null> {
    const row = await this.db
      .selectFrom("app_storage_installation_state")
      .select(["access_revoked_at", "retain_until"])
      .where("workspace_id", "=", scope.workspaceId)
      .where("installation_id", "=", scope.installationId)
      .executeTakeFirst();

    if (!row) return null;
    return {
      accessRevokedAt: row.access_revoked_at ? new Date(row.access_revoked_at) : null,
      retainUntil: row.retain_until ? new Date(row.retain_until) : null,
    };
  }

  async setAccessRevoked(scope: AppStorageInstallationScope, revokedAt: Date | null): Promise<void> {
    await this.db
      .insertInto("app_storage_installation_state")
      .values({
        workspace_id: scope.workspaceId,
        installation_id: scope.installationId,
        access_revoked_at: revokedAt,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["workspace_id", "installation_id"])
          .doUpdateSet({ access_revoked_at: revokedAt, updated_at: currentTimestamp() }),
      )
      .execute();
  }

  async setRetention(scope: AppStorageInstallationScope, retainUntil: Date | null): Promise<void> {
    await this.db
      .insertInto("app_storage_installation_state")
      .values({
        workspace_id: scope.workspaceId,
        installation_id: scope.installationId,
        retain_until: retainUntil,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["workspace_id", "installation_id"])
          .doUpdateSet({ retain_until: retainUntil, updated_at: currentTimestamp() }),
      )
      .execute();
  }

  async findRecord(
    scope: AppStorageCollectionScope,
    key: string,
    now: Date,
  ): Promise<StoredAppStorageRecord | null> {
    const row = await this.db
      .selectFrom("app_storage_records")
      .select(["record_key", "version", "schema_version", "updated_at", "value"])
      .where("workspace_id", "=", scope.workspaceId)
      .where("installation_id", "=", scope.installationId)
      .where("collection_id", "=", scope.collectionId)
      .where("record_key", "=", key)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]))
      .executeTakeFirst();

    return row ? mapRecord(row) : null;
  }

  /**
   * The whole write in one transaction: take the collection's counter row, read
   * the record under it, settle the version fence and the quota, then move the
   * record, its index entries, and the counter together.
   *
   * The counter row is locked before the quota is read. Two puts that each read a
   * count one below the ceiling and each conclude they fit is exactly how a quota
   * stops being one, and no check outside the transaction closes that window.
   */
  async putRecord(command: AppStoragePutCommand): Promise<AppStoragePutOutcome> {
    const { scope, now } = command;

    return this.db.transaction().execute(async (trx) => {
      const usage = await this.lockCollectionUsage(trx, scope);

      const existing = await trx
        .selectFrom("app_storage_records")
        .select(["version", "byte_size", "expires_at"])
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where("collection_id", "=", scope.collectionId)
        .where("record_key", "=", command.key)
        .forUpdate()
        .executeTakeFirst();

      // A row past its deadline is already invisible to every read, so a fenced
      // write must not reach one either. It keeps its physical row, and its place
      // in the counter, until the sweeper reclaims it.
      const live = existing && isLive(existing.expires_at, now) ? existing : null;

      if (command.expectedVersion !== null) {
        if (!live) return { outcome: "not_found" } as const;
        if (live.version !== command.expectedVersion) return { outcome: "version_conflict" } as const;
      }

      // Only a key that is not already stored consumes a slot. The physical row
      // is what the counter counts, so a key whose record has expired but not yet
      // been reclaimed still holds its place until the sweeper takes it back.
      if (exceedsRecordQuota(usage, { maxRecords: command.maxRecords }, !existing)) {
        return { outcome: "quota_exceeded" } as const;
      }

      const version = live ? live.version + 1 : 1;

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
          expires_at: command.expiresAt,
        })
        .onConflict((conflict) =>
          conflict
            .columns(["workspace_id", "installation_id", "collection_id", "record_key"])
            .doUpdateSet({
              schema_version: command.schemaVersion,
              value: toJsonb(command.value),
              byte_size: command.byteSize,
              version,
              expires_at: command.expiresAt,
              updated_at: currentTimestamp(),
            }),
        )
        .execute();

      await this.replaceIndexEntries(trx, scope, command.key, command.indexEntries);

      await trx
        .updateTable("app_storage_collection_usage")
        .set({
          record_count: existing ? usage.recordCount : usage.recordCount + 1,
          byte_size: usage.byteSize - (existing?.byte_size ?? 0) + command.byteSize,
          updated_at: currentTimestamp(),
        })
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where("collection_id", "=", scope.collectionId)
        .execute();

      return { outcome: "stored", version } as const;
    });
  }

  async deleteRecord(command: AppStorageDeleteCommand): Promise<AppStorageDeleteOutcome> {
    const { scope, now } = command;

    return this.db.transaction().execute(async (trx) => {
      const usage = await this.lockCollectionUsage(trx, scope);

      const existing = await trx
        .selectFrom("app_storage_records")
        .select(["version", "byte_size", "expires_at"])
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where("collection_id", "=", scope.collectionId)
        .where("record_key", "=", command.key)
        .forUpdate()
        .executeTakeFirst();

      const live = existing && isLive(existing.expires_at, now) ? existing : null;

      if (command.expectedVersion !== null) {
        if (!live) return { outcome: "not_found" } as const;
        if (live.version !== command.expectedVersion) return { outcome: "version_conflict" } as const;
      }

      if (!existing) return { outcome: "missing" } as const;

      // Index entries follow the record through the foreign key's cascade.
      await trx
        .deleteFrom("app_storage_records")
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where("collection_id", "=", scope.collectionId)
        .where("record_key", "=", command.key)
        .execute();

      await trx
        .updateTable("app_storage_collection_usage")
        .set({
          record_count: Math.max(0, usage.recordCount - 1),
          byte_size: Math.max(0, usage.byteSize - existing.byte_size),
          updated_at: currentTimestamp(),
        })
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where("collection_id", "=", scope.collectionId)
        .execute();

      // A record already past its deadline was invisible before this call, so an
      // unfenced delete of one removed nothing the caller could observe.
      return { outcome: live ? "deleted" : "missing" } as const;
    });
  }

  async queryByIndex(query: AppStorageQuery): Promise<StoredAppStorageRecord[]> {
    // The page is ordered by the key it resumes from, so a cursor is the last key
    // rather than an offset a concurrent write could shift under the reader.
    const rows = await this.db
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
      .where((eb) => eb.or([eb("r.expires_at", "is", null), eb("r.expires_at", ">", query.now)]))
      .$if(query.cursor !== null, (qb) => qb.where("r.record_key", ">", query.cursor ?? ""))
      .orderBy("r.record_key", "asc")
      .limit(query.limit)
      .execute();

    return rows.map(mapRecord);
  }

  async readCollectionUsage(scope: AppStorageCollectionScope): Promise<AppStorageCollectionUsage> {
    const row = await this.db
      .selectFrom("app_storage_collection_usage")
      .select(["record_count", "byte_size"])
      .where("workspace_id", "=", scope.workspaceId)
      .where("installation_id", "=", scope.installationId)
      .where("collection_id", "=", scope.collectionId)
      .executeTakeFirst();

    return { recordCount: row?.record_count ?? 0, byteSize: Number(row?.byte_size ?? 0) };
  }

  /**
   * Reclaims one bounded batch of expired rows and settles the counters they were
   * part of. The counter is maintained rather than recomputed, so a sweep has to
   * decrement it by exactly what it removed, inside the same transaction.
   */
  async deleteExpiredRecords(input: { now: Date; limit: number }): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const expired = await trx
        .selectFrom("app_storage_records")
        .select(["workspace_id", "installation_id", "collection_id", "record_key", "byte_size"])
        .where("expires_at", "is not", null)
        .where("expires_at", "<=", input.now)
        .orderBy("expires_at", "asc")
        .limit(input.limit)
        .forUpdate()
        .skipLocked()
        .execute();

      if (expired.length === 0) return 0;

      const groups = new Map<
        string,
        { scope: AppStorageCollectionScope; keys: string[]; byteSize: number }
      >();
      for (const row of expired) {
        const scope: AppStorageCollectionScope = {
          workspaceId: row.workspace_id,
          installationId: row.installation_id,
          collectionId: row.collection_id,
        };
        const groupKey = [scope.workspaceId, scope.installationId, scope.collectionId].join(" ");
        const group = groups.get(groupKey) ?? { scope, keys: [], byteSize: 0 };
        group.keys.push(row.record_key);
        group.byteSize += row.byte_size;
        groups.set(groupKey, group);
      }

      for (const group of groups.values()) {
        await trx
          .deleteFrom("app_storage_records")
          .where("workspace_id", "=", group.scope.workspaceId)
          .where("installation_id", "=", group.scope.installationId)
          .where("collection_id", "=", group.scope.collectionId)
          .where("record_key", "in", group.keys)
          .execute();

        const usage = await this.lockCollectionUsage(trx, group.scope);
        await trx
          .updateTable("app_storage_collection_usage")
          .set({
            record_count: Math.max(0, usage.recordCount - group.keys.length),
            byte_size: Math.max(0, usage.byteSize - group.byteSize),
            updated_at: currentTimestamp(),
          })
          .where("workspace_id", "=", group.scope.workspaceId)
          .where("installation_id", "=", group.scope.installationId)
          .where("collection_id", "=", group.scope.collectionId)
          .execute();
      }

      return expired.length;
    });
  }

  /**
   * An export reads by key range rather than by offset, so it holds no cursor in
   * the database and a large installation is never materialized in one result set.
   */
  async *streamInstallationRecords(input: {
    scope: AppStorageInstallationScope;
    batchSize: number;
  }): AsyncIterable<ExportedAppStorageRecord> {
    const batchSize = Math.max(EXPORT_PAGE_MINIMUM, input.batchSize);
    let after: ExportCursor | null = null;

    for (;;) {
      const rows = await this.readExportPage(input.scope, batchSize, after);
      const last = rows[rows.length - 1];

      for (const row of rows) {
        yield { ...mapRecord(row), collectionId: row.collection_id };
      }

      if (rows.length < batchSize || !last) return;
      after = { collectionId: last.collection_id, recordKey: last.record_key };
    }
  }

  private async readExportPage(
    scope: AppStorageInstallationScope,
    batchSize: number,
    after: ExportCursor | null,
  ): Promise<ExportRow[]> {
    return this.db
      .selectFrom("app_storage_records")
      .select(["collection_id", "record_key", "version", "schema_version", "updated_at", "value"])
      .where("workspace_id", "=", scope.workspaceId)
      .where("installation_id", "=", scope.installationId)
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
  }

  async deleteInstallationRecords(
    scope: AppStorageInstallationScope,
  ): Promise<{ recordCount: number; collectionCount: number }> {
    return this.db.transaction().execute(async (trx) => {
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
        .deleteFrom("app_storage_installation_state")
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .execute();

      return {
        recordCount: deleted.length,
        collectionCount: new Set(deleted.map((row) => row.collection_id)).size,
      };
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
   * Creates the collection's counter row if this is its first write, then locks
   * it. Everything a quota decision reads happens after this line.
   */
  private async lockCollectionUsage(
    trx: Transaction<DB>,
    scope: AppStorageCollectionScope,
  ): Promise<AppStorageCollectionUsage> {
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
      .select(["record_count", "byte_size"])
      .where("workspace_id", "=", scope.workspaceId)
      .where("installation_id", "=", scope.installationId)
      .where("collection_id", "=", scope.collectionId)
      .forUpdate()
      .executeTakeFirst();

    return { recordCount: row?.record_count ?? 0, byteSize: Number(row?.byte_size ?? 0) };
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
      .values(
        entries.map((entry) => ({
          workspace_id: scope.workspaceId,
          installation_id: scope.installationId,
          collection_id: scope.collectionId,
          record_key: key,
          index_id: entry.indexId,
          text_value: entry.textValue,
          numeric_value: entry.numericValue,
          boolean_value: entry.booleanValue,
          timestamp_value: entry.timestampValue,
        })),
      )
      .execute();
  }
}
