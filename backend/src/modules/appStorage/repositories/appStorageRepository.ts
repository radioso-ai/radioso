import type { BoundedJsonRecord, StorageFieldType } from "@radioso/app-contract";
import type { Kysely, Transaction } from "kysely";

import { clockTimestamp, currentTimestamp, toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { DB } from "../../../shared/infra/kysely/schema.js";
import { buildStorageIndexEntry, type AppStorageIndexEntry } from "../domain/indexEntries.js";
import { withinIndexedStringBounds } from "../domain/indexedValueBounds.js";
import { exceedsRecordQuota, type AppStorageCollectionUsage } from "../domain/quota.js";
import type { AppStorageAuditEvent, AppStorageAuditIntent } from "../ports/appStorageAudit.js";
import type {
  AppStorageAdmitted,
  AppStorageCollectionScope,
  AppStorageDeleteCommand,
  AppStorageDeleteOutcome,
  AppStorageExportSnapshot,
  AppStorageIndexDescriptor,
  AppStorageIndexRebuildBatch,
  AppStorageIndexRebuildProgress,
  AppStorageIndexRebuildStart,
  AppStorageInstallationDeletion,
  AppStorageInstallationDeletionResult,
  AppStorageInstallationScope,
  AppStorageInstallationState,
  AppStorageLiveUsage,
  AppStoragePutCommand,
  AppStoragePutOutcome,
  AppStorageQuery,
  AppStorageRepositoryPort,
  AppStorageRetentionReclaim,
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
   * is refused while access is revoked; an export, a retention change, a rebuild,
   * and the maintenance passes are the host or the operator acting on data the
   * App can no longer reach, and are not.
   */
  denyWhenRevoked: boolean;
}

/** An index a rebuild is currently building, as the state row carries it. */
interface PendingIndex extends AppStorageIndexDescriptor {
  collectionId: string;
}

interface FencedState {
  accessRevokedAt: Date | null;
  retainUntil: Date | null;
  deletedAt: Date | null;
  deletionSummary: AppStorageInstallationDeletion | null;
  pendingIndexes: PendingIndex[];
}

type Fenced = { admitted: false } | { admitted: true; state: FencedState };

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
 * Expired rows a single write gives back before it is admitted, and how many
 * times it repeats. A put has to be admitted against live rows rather than
 * against a counter that still charges it for records nobody can read, but it is
 * also a capability call an App made: it may not delete a collection's entire
 * expired population — up to a million rows and their index entries — while
 * holding the locks every other write needs. So it clears its own key, then a
 * bounded backlog, and the sweep owns the rest.
 */
const FOREGROUND_RECLAIM_BATCH = 256;
const FOREGROUND_RECLAIM_MAX_BATCHES = 4;

/**
 * The last version a JSON number carries exactly. A version crosses the wire to
 * the App and comes back as an `expectedVersion`, so a counter past this point
 * would hand two writes the same fence.
 */
const MAX_SAFE_VERSION = Number.MAX_SAFE_INTEGER;

/**
 * The physical model behind managed App Storage: generic record rows, generic
 * index-entry rows, a maintained per-collection counter, and one state row per
 * installation. It is Radioso's and replaceable — an App declares collections and
 * never observes a table.
 *
 * Two rules hold across every method here, and everything else follows from them.
 *
 * Locks are taken in one order: the installation state row, then the collection's
 * counter row, then record rows. A put, a delete, a usage read, a rebuild, an
 * expiry reclaim, a retention reclaim, and an installation deletion all approach
 * the same rows from the same side — and the deletion walks a collection's
 * counters in key order — so none of them can be left waiting on a lock another
 * already holds in the opposite order. Because the state row comes first, a
 * tombstone is seen before anything else is touched, and nothing recreates a row
 * beneath one.
 *
 * Liveness is decided by a database clock read after those locks are held.
 * `now()` is the transaction's start time, and a transaction that queued behind a
 * lock started arbitrarily long before it won one: judged by it, a record past
 * its deadline reads as live, and a write's TTL is spent waiting. So every
 * predicate about "now" and every deadline computed here comes from one
 * `clock_timestamp()` taken once the operation actually holds what it needs.
 */
export class AppStorageRepository implements AppStorageRepositoryPort {
  constructor(private readonly db: Kysely<DB>) {}

  async findInstallationState(
    scope: AppStorageInstallationScope,
  ): Promise<AppStorageInstallationState | null> {
    const row = await this.db
      .selectFrom("app_storage_installation_state")
      .select([
        "access_revoked_at",
        "retain_until",
        "deleted_at",
        "deleted_record_count",
        "deleted_collection_count",
      ])
      .where("workspace_id", "=", scope.workspaceId)
      .where("installation_id", "=", scope.installationId)
      .executeTakeFirst();

    if (!row) return null;
    return {
      accessRevokedAt: row.access_revoked_at ? new Date(row.access_revoked_at) : null,
      retainUntil: row.retain_until ? new Date(row.retain_until) : null,
      deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
      deletionSummary:
        row.deleted_at && row.deleted_record_count !== null && row.deleted_collection_count !== null
          ? { recordCount: row.deleted_record_count, collectionCount: row.deleted_collection_count }
          : null,
    };
  }

  async setAccessRevoked(
    scope: AppStorageInstallationScope,
    revokedAt: Date | null,
  ): Promise<AppStorageAdmitted<void>> {
    return this.db.transaction().execute(async (trx) => {
      const fenced = await this.fence(trx, scope, { mode: "update", denyWhenRevoked: false });
      if (!fenced.admitted) return denied;

      await trx
        .updateTable("app_storage_installation_state")
        .set({ access_revoked_at: revokedAt, updated_at: currentTimestamp() })
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .execute();

      return admit(undefined);
    });
  }

  /**
   * Sets the retention deadline and, in the same transaction, takes the App's
   * access away if it still has any. Retention is a promise that the data stops
   * existing at a named instant; leaving it reachable would mean the sweep
   * deleting live rows out from under a running App.
   */
  async setRetention(input: {
    scope: AppStorageInstallationScope;
    retainUntil: Date;
    audit: (applied: { retainUntil: Date; accessRevokedAt: Date }) => AppStorageAuditIntent;
  }): Promise<AppStorageAdmitted<{ retainUntil: Date; accessRevokedAt: Date }>> {
    const { scope } = input;

    return this.db.transaction().execute(async (trx) => {
      const fenced = await this.fence(trx, scope, { mode: "update", denyWhenRevoked: false });
      if (!fenced.admitted) return denied;

      const at = await this.freshTimestamp(trx);
      const accessRevokedAt = fenced.state.accessRevokedAt ?? at;

      await trx
        .updateTable("app_storage_installation_state")
        .set({ retain_until: input.retainUntil, access_revoked_at: accessRevokedAt, updated_at: at })
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .execute();

      const applied = { retainUntil: input.retainUntil, accessRevokedAt };
      await this.writeAuditIntent(trx, scope, input.audit(applied));
      return admit(applied);
    });
  }

  async findRecord(
    scope: AppStorageCollectionScope,
    key: string,
  ): Promise<AppStorageAdmitted<StoredAppStorageRecord | null>> {
    return this.db.transaction().execute(async (trx) => {
      const fenced = await this.fence(trx, scope, { mode: "share", denyWhenRevoked: true });
      if (!fenced.admitted) return denied;

      const at = await this.freshTimestamp(trx);
      const row = await trx
        .selectFrom("app_storage_records")
        .select(["record_key", "version", "schema_version", "updated_at", "value"])
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where("collection_id", "=", scope.collectionId)
        .where("record_key", "=", key)
        .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", at)]))
        .executeTakeFirst();

      return admit(row ? mapRecord(row) : null);
    });
  }

  /**
   * The whole write in one transaction: fence the installation, take the
   * collection's counter row, read the clock the write is judged by, give back
   * what expired under it, settle the version fence and the quota, then move the
   * record, its index entries, and the counter together.
   *
   * Expired rows are reclaimed before the quota is read, so a collection at its
   * ceiling whose records have all expired admits the next write immediately
   * rather than at whatever time a maintenance pass happens to run — bounded,
   * because a capability call is not a maintenance job.
   */
  async putRecord(command: AppStoragePutCommand): Promise<AppStorageAdmitted<AppStoragePutOutcome>> {
    const { scope } = command;

    return this.db.transaction().execute(async (trx) => {
      const fenced = await this.fence(trx, scope, { mode: "update", denyWhenRevoked: true });
      if (!fenced.admitted) return denied;

      const usage = await this.lockCollectionUsage(trx, scope);
      const at = await this.freshTimestamp(trx);
      const reclaimed = await this.reclaimBounded(trx, scope, usage, at, { targetKey: command.key });
      const live = reclaimed.live;

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
      // version a client may still be holding. The counter therefore has an end:
      // past the last exactly representable JSON number the guarantee would be a
      // claim rather than a fact, so the collection stops writing instead.
      const version = usage.nextVersion;
      if (version >= MAX_SAFE_VERSION) return admit({ outcome: "version_exhausted" } as const);

      const expiresAt =
        command.ttlSeconds === null ? null : new Date(at.getTime() + command.ttlSeconds * 1000);

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
          created_at: at,
          updated_at: at,
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
              updated_at: at,
            }),
        )
        .execute();

      await this.replaceIndexEntries(trx, scope, command.key, [
        ...command.indexEntries,
        ...this.pendingIndexEntries(fenced.state, scope.collectionId, command.value, command.indexEntries),
      ]);

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
      const fenced = await this.fence(trx, scope, { mode: "update", denyWhenRevoked: true });
      if (!fenced.admitted) return denied;

      const usage = await this.lockCollectionUsage(trx, scope);
      const at = await this.freshTimestamp(trx);
      // Only the key being deleted is reclaimed: a delete frees a slot rather
      // than needing one, so it has no reason to work through a backlog.
      const { live } = await this.reclaimBounded(trx, scope, usage, at, {
        targetKey: command.key,
        maxBatches: 0,
      });

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
      const fenced = await this.fence(trx, query.scope, { mode: "share", denyWhenRevoked: true });
      if (!fenced.admitted) return denied;

      const at = await this.freshTimestamp(trx);

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
        .where((eb) => eb.or([eb("r.expires_at", "is", null), eb("r.expires_at", ">", at)]))
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
   * admitted against — and when the backlog is larger than one call may take,
   * `reclaimPending` says so rather than leaving the number quietly high.
   */
  async readCollectionUsage(
    scope: AppStorageCollectionScope,
  ): Promise<AppStorageAdmitted<AppStorageLiveUsage>> {
    return this.db.transaction().execute(async (trx) => {
      const fenced = await this.fence(trx, scope, { mode: "share", denyWhenRevoked: true });
      if (!fenced.admitted) return denied;

      const usage = await this.lockCollectionUsage(trx, scope);
      const at = await this.freshTimestamp(trx);
      const { live, reclaimPending } = await this.reclaimBounded(trx, scope, usage, at, {});
      return admit({ recordCount: live.recordCount, byteSize: live.byteSize, reclaimPending });
    });
  }

  async listStoredSchemaVersions(
    scope: AppStorageCollectionScope,
  ): Promise<AppStorageAdmitted<number[]>> {
    return this.db.transaction().execute(async (trx) => {
      const fenced = await this.fence(trx, scope, { mode: "share", denyWhenRevoked: false });
      if (!fenced.admitted) return denied;

      const at = await this.freshTimestamp(trx);
      const rows = await trx
        .selectFrom("app_storage_records")
        .select("schema_version")
        .distinct()
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where("collection_id", "=", scope.collectionId)
        .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", at)]))
        .orderBy("schema_version", "asc")
        .execute();

      return admit(rows.map((row) => row.schema_version));
    });
  }

  /**
   * Marks the index pending and reports the collection's next version. From here
   * every put maintains an entry for it as well as for the indexes the writing
   * release declares, so a rebuild running beside an older release's writes cannot
   * lose the keys those writes touched; the version is where the closing pass
   * starts looking.
   */
  async beginIndexRebuild(input: {
    scope: AppStorageCollectionScope;
    index: AppStorageIndexDescriptor;
  }): Promise<AppStorageAdmitted<AppStorageIndexRebuildStart>> {
    const { scope } = input;

    return this.db.transaction().execute(async (trx) => {
      const fenced = await this.fence(trx, scope, { mode: "update", denyWhenRevoked: false });
      if (!fenced.admitted) return denied;

      const usage = await this.lockCollectionUsage(trx, scope);
      const pending = [
        ...fenced.state.pendingIndexes.filter(
          (entry) => !(entry.collectionId === scope.collectionId && entry.id === input.index.id),
        ),
        { collectionId: scope.collectionId, ...input.index },
      ];
      await this.writePendingIndexes(trx, scope, pending);

      return admit({ startVersion: usage.nextVersion });
    });
  }

  /**
   * Builds one declared index over one page of records. A value stored before the
   * field was indexed was never measured against the index's bounds, so a value
   * the index cannot hold is counted and skipped — the alternative is the database
   * refusing the batch and the operator reading a driver error.
   */
  async rebuildIndexBatch(
    batch: AppStorageIndexRebuildBatch,
  ): Promise<AppStorageAdmitted<AppStorageIndexRebuildProgress>> {
    const { scope } = batch;

    return this.db.transaction().execute(async (trx) => {
      const fenced = await this.fence(trx, scope, { mode: "update", denyWhenRevoked: false });
      if (!fenced.admitted) return denied;

      await this.lockCollectionUsage(trx, scope);
      const at = await this.freshTimestamp(trx);

      const rows = await trx
        .selectFrom("app_storage_records")
        .select(["record_key", "value"])
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where("collection_id", "=", scope.collectionId)
        .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", at)]))
        .$if(batch.after !== null, (qb) => qb.where("record_key", ">", batch.after ?? ""))
        .$if(batch.minVersion !== null, (qb) => qb.where("version", ">=", String(batch.minVersion ?? 0)))
        .orderBy("record_key", "asc")
        .limit(batch.limit)
        .forUpdate()
        .execute();

      if (rows.length === 0) return admit({ rebuiltCount: 0, lastKey: null, incompatibleCount: 0 });

      const keys = rows.map((row) => row.record_key);
      await trx
        .deleteFrom("app_storage_index_entries")
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where("collection_id", "=", scope.collectionId)
        .where("index_id", "=", batch.index.id)
        .where("record_key", "in", keys)
        .execute();

      let incompatibleCount = 0;
      const values = rows.flatMap((row) => {
        const entry = this.entryForIndex(batch.index, (row.value ?? {}) as BoundedJsonRecord);
        if (!entry) return [];
        if (!this.withinIndexBounds(entry)) {
          incompatibleCount += 1;
          return [];
        }
        return [this.toIndexRow(scope, row.record_key, entry)];
      });

      if (values.length > 0) {
        await trx.insertInto("app_storage_index_entries").values(values).execute();
      }

      return admit({
        rebuiltCount: rows.length,
        lastKey: keys[keys.length - 1] ?? null,
        incompatibleCount,
      });
    });
  }

  async finishIndexRebuild(input: {
    scope: AppStorageCollectionScope;
    indexId: string;
  }): Promise<AppStorageAdmitted<void>> {
    const { scope } = input;

    return this.db.transaction().execute(async (trx) => {
      const fenced = await this.fence(trx, scope, { mode: "update", denyWhenRevoked: false });
      if (!fenced.admitted) return denied;

      await this.writePendingIndexes(
        trx,
        scope,
        fenced.state.pendingIndexes.filter(
          (entry) => !(entry.collectionId === scope.collectionId && entry.id === input.indexId),
        ),
      );

      return admit(undefined);
    });
  }

  /**
   * Claims the collections the next expiry pass works, least recently swept first
   * and skipping what another pass already holds. Ordering by a stored cursor is
   * what keeps a busy collection from being picked every round while another
   * keeps its expired rows forever; `SKIP LOCKED` is what lets two passes run
   * without one waiting on the other.
   */
  async claimCollectionsForExpirySweep(limit: number): Promise<AppStorageCollectionScope[]> {
    if (limit <= 0) return [];

    return this.db.transaction().execute(async (trx) => {
      const claimed = await trx
        .selectFrom("app_storage_collection_usage as u")
        .select(["u.workspace_id", "u.installation_id", "u.collection_id"])
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom("app_storage_records as r")
              .select("r.record_key")
              .whereRef("r.workspace_id", "=", "u.workspace_id")
              .whereRef("r.installation_id", "=", "u.installation_id")
              .whereRef("r.collection_id", "=", "u.collection_id")
              .where("r.expires_at", "is not", null)
              .where("r.expires_at", "<=", clockTimestamp()),
          ),
        )
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("app_storage_installation_state as s")
                .select("s.installation_id")
                .whereRef("s.workspace_id", "=", "u.workspace_id")
                .whereRef("s.installation_id", "=", "u.installation_id")
                .where("s.deleted_at", "is not", null),
            ),
          ),
        )
        .orderBy("u.last_swept_at", "asc")
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();

      for (const row of claimed) {
        await trx
          .updateTable("app_storage_collection_usage")
          .set({ last_swept_at: clockTimestamp() })
          .where("workspace_id", "=", row.workspace_id)
          .where("installation_id", "=", row.installation_id)
          .where("collection_id", "=", row.collection_id)
          .execute();
      }

      return claimed.map((row) => ({
        workspaceId: row.workspace_id,
        installationId: row.installation_id,
        collectionId: row.collection_id,
      }));
    });
  }

  /**
   * Reclaims one bounded batch of a single collection's expired rows. It takes
   * the installation's state row first like every other operation, so a sweep and
   * an installation deletion queue behind each other instead of meeting in the
   * middle, and a tombstoned installation is left alone rather than having a
   * counter row recreated beneath it.
   */
  async reclaimExpiredRecords(input: {
    scope: AppStorageCollectionScope;
    limit: number;
  }): Promise<number> {
    const { scope } = input;

    return this.db.transaction().execute(async (trx) => {
      const fenced = await this.fence(trx, scope, { mode: "share", denyWhenRevoked: false });
      if (!fenced.admitted) return 0;

      const usage = await this.lockCollectionUsage(trx, scope);
      const at = await this.freshTimestamp(trx);
      const before = usage.recordCount;
      const { live } = await this.reclaimBounded(trx, scope, usage, at, {
        batchSize: input.limit,
        maxBatches: 1,
      });

      await trx
        .updateTable("app_storage_collection_usage")
        .set({ last_swept_at: at })
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where("collection_id", "=", scope.collectionId)
        .execute();

      return before - live.recordCount;
    });
  }

  async listInstallationsDueForRetention(limit: number): Promise<AppStorageInstallationScope[]> {
    const rows = await this.db
      .selectFrom("app_storage_installation_state")
      .select(["workspace_id", "installation_id"])
      .where("retain_until", "is not", null)
      .where("retain_until", "<=", clockTimestamp())
      .where("deleted_at", "is", null)
      .orderBy("retain_until", "asc")
      .limit(limit)
      .execute();

    return rows.map((row) => ({ workspaceId: row.workspace_id, installationId: row.installation_id }));
  }

  /**
   * Deletes a retained installation's data, but only after rechecking the
   * deadline while holding the state row. The listing that produced this call is
   * a decision made outside any lock, and an operator who extended the hold in
   * between must not lose the data to it.
   */
  async reclaimRetainedInstallation(input: {
    scope: AppStorageInstallationScope;
    audit: (summary: AppStorageInstallationDeletion) => AppStorageAuditIntent;
  }): Promise<AppStorageRetentionReclaim> {
    const { scope } = input;

    return this.db.transaction().execute(async (trx) => {
      const fenced = await this.fence(trx, scope, { mode: "update", denyWhenRevoked: false });
      if (!fenced.admitted) return { outcome: "tombstoned" } as const;

      const at = await this.freshTimestamp(trx);
      const retainUntil = fenced.state.retainUntil;
      if (!retainUntil || retainUntil.getTime() > at.getTime()) return { outcome: "not_due" } as const;

      const summary = await this.removeInstallationData(trx, scope, at);
      await this.writeAuditIntent(trx, scope, input.audit(summary));
      return { outcome: "reclaimed", summary } as const;
    });
  }

  /**
   * Admits an export and then streams it from one repeatable-read transaction.
   * Admission is decided under the state row before a single record is read, so a
   * tombstoned installation is refused rather than handed an empty file; and
   * because every page reads inside the same snapshot, a record written, changed,
   * or expired mid-export is either wholly in it or wholly out.
   */
  async openInstallationExport(input: {
    scope: AppStorageInstallationScope;
    batchSize: number;
  }): Promise<AppStorageAdmitted<AppStorageExportSnapshot>> {
    const batchSize = Math.max(EXPORT_PAGE_MINIMUM, input.batchSize);
    const trx = await this.db.startTransaction().setIsolationLevel("repeatable read").execute();

    // Alone among the operations here, an export does not lock the state row.
    // Its transaction stays open for as long as the operator is reading, and a
    // lock held that long would stop the App writing for the length of an export.
    // The snapshot does the same work: a tombstone that committed before it is
    // visible and refuses the export, and one that commits after it cannot make
    // this export wrong, because every page it reads belongs to the state it was
    // admitted against.
    let state: AppStorageInstallationState | null;
    try {
      state = await this.readState(trx, input.scope);
    } catch (error) {
      await trx.rollback().execute();
      throw error;
    }

    if (state?.deletedAt) {
      await trx.rollback().execute();
      return denied;
    }

    const scope = input.scope;
    const readPage = async (after: ExportCursor | null, at: Date): Promise<ExportRow[]> =>
      trx
        .selectFrom("app_storage_records")
        .select(["collection_id", "record_key", "version", "schema_version", "updated_at", "value"])
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", at)]))
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

    async function* stream(this: AppStorageRepository): AsyncGenerator<ExportedAppStorageRecord> {
      let committed = false;
      try {
        const at = await this.freshTimestamp(trx);
        let after: ExportCursor | null = null;

        for (;;) {
          const rows = await readPage(after, at);
          const last = rows[rows.length - 1];

          for (const row of rows) {
            yield { ...mapRecord(row), collectionId: row.collection_id };
          }

          if (rows.length < batchSize || !last) break;
          after = { collectionId: last.collection_id, recordKey: last.record_key };
        }

        await trx.commit().execute();
        committed = true;
      } finally {
        if (!committed) await trx.rollback().execute();
      }
    }

    return admit({ records: stream.call(this) });
  }

  /**
   * Removes an installation's data and leaves the tombstone behind. The state row
   * outlives the rows it accounted for, so an operation that was in flight when
   * the deletion committed is refused rather than allowed to recreate a record
   * under an installation that no longer holds any.
   *
   * A repeat is the same answer, not a refusal. Deletion is irreversible and its
   * caller may have lost the first response — to a crashed process, a dropped
   * connection, a retried job — so the counts are kept on the tombstone and given
   * back as often as they are asked for.
   */
  async deleteInstallationRecords(input: {
    scope: AppStorageInstallationScope;
    audit: (summary: AppStorageInstallationDeletion) => AppStorageAuditIntent;
  }): Promise<AppStorageInstallationDeletionResult> {
    const { scope } = input;

    return this.db.transaction().execute(async (trx) => {
      const fenced = await this.fence(trx, scope, { mode: "update", denyWhenRevoked: false });
      if (!fenced.admitted) {
        const state = await this.readState(trx, scope);
        const summary = state?.deletionSummary ?? { recordCount: 0, collectionCount: 0 };
        return { ...summary, alreadyDeleted: true };
      }

      const at = await this.freshTimestamp(trx);
      const summary = await this.removeInstallationData(trx, scope, at);
      await this.writeAuditIntent(trx, scope, input.audit(summary));
      return { ...summary, alreadyDeleted: false };
    });
  }

  async enqueueAuditEvent(input: {
    scope: AppStorageInstallationScope;
    intent: AppStorageAuditIntent;
  }): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await this.writeAuditIntent(trx, input.scope, input.intent);
    });
  }

  /**
   * Publishes what the dispositions committed. The entries are claimed and
   * published inside one transaction, so an entry whose publish failed stays for
   * the next pass rather than disappearing with it; the trail is at-least-once,
   * which is the side to be wrong on when the subject is customer data.
   */
  async drainAuditOutbox(input: {
    limit: number;
    publish: (event: AppStorageAuditEvent) => Promise<void>;
  }): Promise<number> {
    if (input.limit <= 0) return 0;

    return this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom("app_storage_audit_outbox")
        .select(["id", "workspace_id", "installation_id", "event_type", "event_status", "metadata"])
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .limit(input.limit)
        .forUpdate()
        .skipLocked()
        .execute();

      if (rows.length === 0) return 0;

      for (const row of rows) {
        await input.publish({
          workspaceId: row.workspace_id,
          installationId: row.installation_id,
          eventType: row.event_type as AppStorageAuditEvent["eventType"],
          eventStatus: row.event_status as AppStorageAuditEvent["eventStatus"],
          metadata: (row.metadata ?? {}) as AppStorageAuditEvent["metadata"],
        });
      }

      await trx
        .deleteFrom("app_storage_audit_outbox")
        .where(
          "id",
          "in",
          rows.map((row) => row.id),
        )
        .execute();

      return rows.length;
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
  ): Promise<Fenced> {
    await trx
      .insertInto("app_storage_installation_state")
      .values({ workspace_id: scope.workspaceId, installation_id: scope.installationId })
      .onConflict((conflict) => conflict.columns(["workspace_id", "installation_id"]).doNothing())
      .execute();

    const query = trx
      .selectFrom("app_storage_installation_state")
      .select([
        "access_revoked_at",
        "retain_until",
        "deleted_at",
        "deleted_record_count",
        "deleted_collection_count",
        "pending_indexes",
      ])
      .where("workspace_id", "=", scope.workspaceId)
      .where("installation_id", "=", scope.installationId);

    const row =
      options.mode === "update"
        ? await query.forUpdate().executeTakeFirst()
        : await query.forShare().executeTakeFirst();

    if (!row) return denied;
    if (row.deleted_at !== null) return denied;
    if (options.denyWhenRevoked && row.access_revoked_at !== null) return denied;

    return {
      admitted: true,
      state: {
        accessRevokedAt: row.access_revoked_at ? new Date(row.access_revoked_at) : null,
        retainUntil: row.retain_until ? new Date(row.retain_until) : null,
        deletedAt: null,
        deletionSummary: null,
        pendingIndexes: readPendingIndexes(row.pending_indexes),
      },
    };
  }

  private async readState(
    trx: Transaction<DB>,
    scope: AppStorageInstallationScope,
  ): Promise<AppStorageInstallationState | null> {
    const row = await trx
      .selectFrom("app_storage_installation_state")
      .select(["access_revoked_at", "retain_until", "deleted_at", "deleted_record_count", "deleted_collection_count"])
      .where("workspace_id", "=", scope.workspaceId)
      .where("installation_id", "=", scope.installationId)
      .executeTakeFirst();

    if (!row) return null;
    return {
      accessRevokedAt: row.access_revoked_at ? new Date(row.access_revoked_at) : null,
      retainUntil: row.retain_until ? new Date(row.retain_until) : null,
      deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
      deletionSummary:
        row.deleted_record_count !== null && row.deleted_collection_count !== null
          ? { recordCount: row.deleted_record_count, collectionCount: row.deleted_collection_count }
          : null,
    };
  }

  /**
   * The database's wall clock, read after the operation holds its locks. This is
   * the only timestamp any predicate or deadline here uses: `now()` is the
   * transaction's start time, and a transaction that waited on a lock started
   * long before it was allowed to act.
   */
  private async freshTimestamp(trx: Transaction<DB>): Promise<Date> {
    const row = await trx.selectNoFrom(clockTimestamp().as("at")).executeTakeFirstOrThrow();
    return new Date(row.at);
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
   * Gives back what expired, under the counter lock the caller already holds and
   * against the clock it read after taking it.
   *
   * The work is bounded on purpose. The key the caller is about to write is
   * always cleared, because that one decides whether the write replaces a record
   * or takes a new slot; after it, a fixed number of batches of the collection's
   * remaining expired rows. A caller that instead deleted the whole expired
   * population would hold the installation and the collection for as long as that
   * takes, which is the maintenance pass' job and not a capability call's.
   *
   * The counter is written straight away rather than folded into the caller's own
   * update: a put that goes on to refuse the write still has to leave the counter
   * describing the rows that are actually there.
   */
  private async reclaimBounded(
    trx: Transaction<DB>,
    scope: AppStorageCollectionScope,
    usage: LockedCollectionUsage,
    at: Date,
    options: { targetKey?: string; batchSize?: number; maxBatches?: number },
  ): Promise<{ live: AppStorageCollectionUsage; reclaimPending: boolean }> {
    const batchSize = options.batchSize ?? FOREGROUND_RECLAIM_BATCH;
    const maxBatches = options.maxBatches ?? FOREGROUND_RECLAIM_MAX_BATCHES;

    let recordCount = usage.recordCount;
    let byteSize = usage.byteSize;
    let removedAny = false;

    const account = (rows: readonly { byte_size: number }[]): void => {
      if (rows.length === 0) return;
      removedAny = true;
      recordCount = Math.max(0, recordCount - rows.length);
      byteSize = Math.max(0, byteSize - rows.reduce((total, row) => total + Number(row.byte_size), 0));
    };

    if (options.targetKey !== undefined) {
      account(
        await trx
          .deleteFrom("app_storage_records")
          .where("workspace_id", "=", scope.workspaceId)
          .where("installation_id", "=", scope.installationId)
          .where("collection_id", "=", scope.collectionId)
          .where("record_key", "=", options.targetKey)
          .where("expires_at", "is not", null)
          .where("expires_at", "<=", at)
          .returning("byte_size")
          .execute(),
      );
    }

    for (let batch = 0; batch < maxBatches; batch += 1) {
      const removed = await trx
        .deleteFrom("app_storage_records")
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where("collection_id", "=", scope.collectionId)
        .where("record_key", "in", (inner) =>
          inner
            .selectFrom("app_storage_records")
            .select("record_key")
            .where("workspace_id", "=", scope.workspaceId)
            .where("installation_id", "=", scope.installationId)
            .where("collection_id", "=", scope.collectionId)
            .where("expires_at", "is not", null)
            .where("expires_at", "<=", at)
            .orderBy("expires_at", "asc")
            .limit(batchSize),
        )
        .returning("byte_size")
        .execute();

      account(removed);
      if (removed.length < batchSize) break;
    }

    const live: AppStorageCollectionUsage = { recordCount, byteSize };
    if (removedAny) {
      await this.writeCollectionUsage(trx, scope, { ...live, nextVersion: usage.nextVersion });
    }

    const remaining = await trx
      .selectFrom("app_storage_records")
      .select("record_key")
      .where("workspace_id", "=", scope.workspaceId)
      .where("installation_id", "=", scope.installationId)
      .where("collection_id", "=", scope.collectionId)
      .where("expires_at", "is not", null)
      .where("expires_at", "<=", at)
      .limit(1)
      .executeTakeFirst();

    return { live, reclaimPending: remaining !== undefined };
  }

  /**
   * Removes every record, index entry, and counter an installation holds and
   * leaves the tombstone with what it removed. Counters are taken in collection
   * order, which is the order the sweep meets them in, so the two cannot hold
   * halves of each other's work.
   */
  private async removeInstallationData(
    trx: Transaction<DB>,
    scope: AppStorageInstallationScope,
    at: Date,
  ): Promise<AppStorageInstallationDeletion> {
    await trx
      .selectFrom("app_storage_collection_usage")
      .select("collection_id")
      .where("workspace_id", "=", scope.workspaceId)
      .where("installation_id", "=", scope.installationId)
      .orderBy("collection_id", "asc")
      .forUpdate()
      .execute();

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

    const summary = {
      recordCount: deleted.length,
      collectionCount: new Set(deleted.map((row) => row.collection_id)).size,
    };

    await trx
      .updateTable("app_storage_installation_state")
      .set({
        deleted_at: at,
        retain_until: null,
        deleted_record_count: summary.recordCount,
        deleted_collection_count: summary.collectionCount,
        pending_indexes: toJsonb({}),
        updated_at: at,
      })
      .where("workspace_id", "=", scope.workspaceId)
      .where("installation_id", "=", scope.installationId)
      .execute();

    return summary;
  }

  private async writeAuditIntent(
    trx: Transaction<DB>,
    scope: AppStorageInstallationScope,
    intent: AppStorageAuditIntent,
  ): Promise<void> {
    await trx
      .insertInto("app_storage_audit_outbox")
      .values({
        workspace_id: scope.workspaceId,
        installation_id: scope.installationId,
        event_type: intent.eventType,
        event_status: intent.eventStatus,
        metadata: toJsonb(intent.metadata),
      })
      .execute();
  }

  private async writePendingIndexes(
    trx: Transaction<DB>,
    scope: AppStorageInstallationScope,
    pending: readonly PendingIndex[],
  ): Promise<void> {
    const byCollection: Record<string, AppStorageIndexDescriptor[]> = {};
    for (const entry of pending) {
      const bucket = byCollection[entry.collectionId] ?? [];
      bucket.push({ id: entry.id, field: entry.field, fieldType: entry.fieldType });
      byCollection[entry.collectionId] = bucket;
    }

    await trx
      .updateTable("app_storage_installation_state")
      .set({ pending_indexes: toJsonb(byCollection), updated_at: currentTimestamp() })
      .where("workspace_id", "=", scope.workspaceId)
      .where("installation_id", "=", scope.installationId)
      .execute();
  }

  /**
   * The entries a write owes an index that is being rebuilt underneath it. The
   * writing release does not declare that index — it belongs to the candidate —
   * so the descriptor travels on the state row, and the entry is derived from the
   * record the same way the rebuild derives it.
   */
  private pendingIndexEntries(
    state: FencedState,
    collectionId: string,
    value: BoundedJsonRecord,
    declared: readonly AppStorageIndexEntry[],
  ): AppStorageIndexEntry[] {
    const declaredIds = new Set(declared.map((entry) => entry.indexId));
    const entries: AppStorageIndexEntry[] = [];

    for (const pending of state.pendingIndexes) {
      if (pending.collectionId !== collectionId || declaredIds.has(pending.id)) continue;
      const entry = this.entryForIndex(pending, value);
      if (entry && this.withinIndexBounds(entry)) entries.push(entry);
    }

    return entries;
  }

  private entryForIndex(
    index: AppStorageIndexDescriptor,
    value: BoundedJsonRecord,
  ): AppStorageIndexEntry | null {
    if (!Object.hasOwn(value, index.field)) return null;
    return buildStorageIndexEntry({
      indexId: index.id,
      fieldType: index.fieldType,
      value: value[index.field],
    });
  }

  private withinIndexBounds(entry: AppStorageIndexEntry): boolean {
    return entry.textValue === null || withinIndexedStringBounds(entry.textValue);
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

/**
 * The pending-index marker as it comes back off the state row. It is host-written
 * JSON, but it is still JSON: a shape that does not match is treated as no
 * pending index rather than trusted into a write.
 */
const readPendingIndexes = (value: unknown): PendingIndex[] => {
  if (typeof value !== "object" || value === null) return [];
  const pending: PendingIndex[] = [];

  for (const [collectionId, indexes] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(indexes)) continue;
    for (const entry of indexes) {
      if (typeof entry !== "object" || entry === null) continue;
      const { id, field, fieldType } = entry as Record<string, unknown>;
      if (typeof id !== "string" || typeof field !== "string" || typeof fieldType !== "string") continue;
      pending.push({ collectionId, id, field, fieldType: fieldType as StorageFieldType });
    }
  }

  return pending;
};
