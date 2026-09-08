import { randomUUID } from "node:crypto";

import type { BoundedJsonRecord, StorageFieldType } from "@radioso/app-contract";
import { sql, type ControlledTransaction, type Kysely, type Transaction } from "kysely";

import { clockTimestamp, currentTimestamp, toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { DB } from "../../../shared/infra/kysely/schema.js";
import { buildStorageIndexEntry, type AppStorageIndexEntry } from "../domain/indexEntries.js";
import {
  INDEXED_STRING_BYTE_BOUND,
  INDEXED_STRING_CHARACTER_BOUND,
  withinIndexedStringBounds,
} from "../domain/indexedValueBounds.js";
import { exceedsRecordQuota, type AppStorageCollectionUsage } from "../domain/quota.js";
import {
  AppStorageExportBusyError,
  AppStorageExportClosedError,
  AppStorageExportDeniedError,
} from "../domain/results.js";
import type { AppStorageAuditIntent } from "../ports/appStorageAudit.js";
import type {
  AppStorageAccessTransition,
  AppStorageAdmitted,
  AppStorageAuditOutboxClaim,
  AppStorageCollectionScope,
  AppStorageDeleteCommand,
  AppStorageDeleteOutcome,
  AppStorageExportSnapshot,
  AppStorageIndexDescriptor,
  AppStorageIndexRebuildBatch,
  AppStorageIndexRebuildCancel,
  AppStorageIndexRebuildCompletion,
  AppStorageIndexRebuildFinish,
  AppStorageIndexRebuildProgress,
  AppStorageIndexRebuildStart,
  AppStorageIndexRebuildSweep,
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
  AppStorageSweepClaim,
  AppStorageUnitOfWork,
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

/**
 * An index a rebuild is currently building, as the state row carries it.
 *
 * The generation is the rebuild's identity. Finishing and cancelling compare it
 * against what is stored, so a run that was superseded cannot clear the marker
 * the newer run is scanning under, and a `finishedAt` marker distinguishes a
 * rebuild that converged — and is waiting for its activation to clear it — from
 * one still in progress.
 */
interface PendingIndex extends AppStorageIndexDescriptor {
  collectionId: string;
  generation: number;
  finishedAt: string | null;
  /**
   * How long this rebuild stays the marker's owner without doing anything. Every
   * batch renews it, and so does converging, because a converged rebuild is
   * waiting for an activation that may never come. Past it the run is treated as
   * dead: the next rebuild of the same index drops it, and so does the sweep.
   * Without a deadline a process that died mid-rebuild would leave every future
   * write to that collection maintaining an index no release will ever query.
   */
  leaseUntil: string | null;
}

/** One pending index as the state row's JSON holds it, keyed under its collection. */
type StoredPendingIndex = Omit<PendingIndex, "collectionId">;

/** The transaction an export snapshot owns: started explicitly, ended explicitly. */
type ExportTransaction = ControlledTransaction<DB>;

/**
 * A snapshot's ownership, which is what makes it single-consumer: it is taken
 * once, and every later reader meets it already taken or already ended.
 */
type ExportSnapshotState = "unopened" | "reading" | "closed";

interface FencedState {
  accessRevokedAt: Date | null;
  retainUntil: Date | null;
  deletedAt: Date | null;
  deletionSummary: AppStorageInstallationDeletion | null;
  pendingIndexes: PendingIndex[];
  /** The highest generation this installation has ever handed a rebuild. */
  rebuildGeneration: number;
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

/** How long one claimed collection stays this sweep worker's to reclaim. */
const SWEEP_LEASE_SECONDS = 60;

/**
 * How long a rebuild marker survives without a sign of life. It has to outlast
 * one batch and the activation that follows convergence by a wide margin, and
 * still be short enough that a rebuild whose process died stops taxing every
 * write to its collection within an operator's attention span.
 */
const REBUILD_LEASE_SECONDS = 15 * 60;

/**
 * The last generation an installation hands out. A generation is converted to a
 * `number`, serialized into JSON, and pasted into a completion token; past this
 * point two distinct generations compare equal, and a stale token could clear a
 * live rebuild.
 */
const MAX_SAFE_GENERATION = Number.MAX_SAFE_INTEGER;

/**
 * How many live records past an index's bound a closing rebuild names before it
 * stops counting. The rebuild has already failed by then, and the exact size of
 * a failure nobody can act on is not worth a full scan of the collection.
 */
const INCOMPATIBLE_REVALIDATION_CEILING = 1_000;

/**
 * How long an admitted export may sit between reads before its snapshot is
 * aborted. A repeatable-read transaction pins an MVCC snapshot and a pooled
 * connection, and a consumer that walked away must not pin either indefinitely.
 */
const EXPORT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

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

  /**
   * Revokes or restores the App's storage access, and refuses restoration while a
   * retention hold stands.
   *
   * The refusal belongs here rather than in the orchestration above, because it is
   * an invariant of the row and not a step in a procedure: retention revokes
   * access in the same transaction that sets the deadline, and any path that could
   * clear the revocation without clearing the deadline would hand a running App
   * data the sweep is going to destroy. Lifting the hold is
   * {@link cancelRetention}, which the operator asks for by name.
   */
  async setAccessRevoked(
    scope: AppStorageInstallationScope,
    revokedAt: Date | null,
  ): Promise<AppStorageAdmitted<AppStorageAccessTransition>> {
    return this.db.transaction().execute(async (trx) => {
      const fenced = await this.fence(trx, scope, { mode: "update", denyWhenRevoked: false });
      if (!fenced.admitted) return denied;

      const retainUntil = fenced.state.retainUntil;
      if (revokedAt === null && retainUntil !== null) {
        return admit({ outcome: "retention_active", retainUntil } as const);
      }

      await trx
        .updateTable("app_storage_installation_state")
        .set({ access_revoked_at: revokedAt, updated_at: currentTimestamp() })
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .execute();

      return admit({ outcome: "applied" } as const);
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

  /**
   * Lifts the retention hold under the state row's own lock, and audits it. Access
   * is left revoked: ending a scheduled destruction and handing the data back to
   * the App are two decisions, and running them together would make cancelling a
   * hold silently restore an App the operator had also disabled.
   *
   * A hold that is not there is not a failure. The end state the caller asked for
   * is the state, and the trail records nothing that did not happen.
   */
  async cancelRetention(input: {
    scope: AppStorageInstallationScope;
    audit: (cleared: { retainUntil: Date }) => AppStorageAuditIntent;
  }): Promise<AppStorageAdmitted<{ retainUntil: Date | null }>> {
    const { scope } = input;

    return this.db.transaction().execute(async (trx) => {
      const fenced = await this.fence(trx, scope, { mode: "update", denyWhenRevoked: false });
      if (!fenced.admitted) return denied;

      const retainUntil = fenced.state.retainUntil;
      if (retainUntil === null) return admit({ retainUntil: null });

      await trx
        .updateTable("app_storage_installation_state")
        .set({ retain_until: null, updated_at: currentTimestamp() })
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .execute();

      await this.writeAuditIntent(trx, scope, input.audit({ retainUntil }));
      return admit({ retainUntil });
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
   *
   * Bounded reclamation alone would let the quota lie. A collection holding two
   * thousand expired rows under a ceiling of one would give back a few hundred,
   * read a counter still above the ceiling, and refuse a write no live record is
   * standing in the way of. So when reclamation stops with expired rows still
   * there, the write counts the live rows exactly — bounded by the ceiling it is
   * being judged against, which is the most it ever has to know — and is admitted
   * on that number rather than on the counter.
   *
   * The counter is not moved to that number. It counts the rows that are there,
   * live ones and expired ones no pass has reclaimed yet, and every reclaim's
   * arithmetic subtracts against that meaning; writing a live-only count into it
   * would make the next reclaim subtract rows it no longer accounted for and
   * drive it below the truth. What the write commits is the count of rows
   * present; what it is admitted against is the count of rows alive.
   */
  async putRecord(command: AppStoragePutCommand): Promise<AppStorageAdmitted<AppStoragePutOutcome>> {
    const { scope } = command;

    return this.db.transaction().execute(async (trx) => {
      const fenced = await this.fence(trx, scope, { mode: "update", denyWhenRevoked: true });
      if (!fenced.admitted) return denied;

      const usage = await this.lockCollectionUsage(trx, scope);
      const at = await this.freshTimestamp(trx);
      const reclaimed = await this.reclaimBounded(trx, scope, usage, at, { targetKey: command.key });
      const present = reclaimed.live;
      const live = reclaimed.reclaimPending
        ? await this.countLiveRecords(trx, scope, at, command.maxRecords)
        : present;

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

      // An index being rebuilt underneath this write is one no release queries
      // yet, but it is also one the rebuild is about to be judged on. A value the
      // pending index cannot hold is refused rather than stored with its entry
      // missing: skipping it would leave a record the rebuilt index never answers
      // about, and the activation that followed would expose a query quietly
      // short of a row.
      const pendingEntries = this.pendingIndexEntries(
        fenced.state,
        scope.collectionId,
        command.value,
        command.indexEntries,
      );
      if (!pendingEntries.admitted) {
        return admit({
          outcome: "pending_index_bound_exceeded",
          indexId: pendingEntries.indexId,
        } as const);
      }

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
        ...pendingEntries.entries,
      ]);

      await this.writeCollectionUsage(trx, scope, {
        recordCount: existing ? present.recordCount : present.recordCount + 1,
        byteSize: Math.max(0, present.byteSize - Number(existing?.byte_size ?? 0) + command.byteSize),
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
   * Marks the index pending under a fresh generation and reports the collection's
   * next version. From here every put maintains an entry for it as well as for the
   * indexes the writing release declares, so a rebuild running beside an older
   * release's writes cannot lose the keys those writes touched; the version is
   * where the closing pass starts looking.
   *
   * The generation is what makes two overlapping rebuilds of one index safe. It
   * comes from a counter on the state row that only increases, so it names this
   * rebuild and no other; finishing and cancelling compare against it, and a run
   * whose generation has been superseded is told so rather than clearing a marker
   * another run is still scanning under.
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
      const generation = fenced.state.rebuildGeneration + 1;
      if (generation > MAX_SAFE_GENERATION) {
        return admit({ outcome: "generation_exhausted" } as const);
      }

      const at = await this.freshTimestamp(trx);
      // Markers whose lease ran out belong to runs that died. A rebuild starting
      // here is the natural moment to collect them: it already holds the state
      // row exclusively, and until they are dropped every write to their
      // collections keeps maintaining an index no release is going to query.
      const surviving = await this.dropAbandonedMarkers(trx, scope, fenced.state.pendingIndexes, at, {
        exceptCollectionId: scope.collectionId,
        exceptIndexId: input.index.id,
      });

      const pending = [
        ...surviving.filter(
          (entry) => !(entry.collectionId === scope.collectionId && entry.id === input.index.id),
        ),
        {
          collectionId: scope.collectionId,
          ...input.index,
          generation,
          finishedAt: null,
          leaseUntil: leaseFrom(at),
        },
      ];
      await this.writePendingIndexes(trx, scope, pending, generation);

      return admit({ outcome: "started", startVersion: usage.nextVersion, generation } as const);
    });
  }

  /**
   * Builds one declared index over one page of records, and renews the marker's
   * lease while it does.
   *
   * The batch belongs to a generation, and the marker is checked against it
   * first: a run whose marker was taken over by a newer rebuild, or dropped by
   * the sweep after its own lease ran out, builds nothing rather than maintaining
   * entries under a marker it no longer owns. Renewing here is what makes the
   * lease mean "this rebuild is still moving" rather than "this rebuild once
   * started".
   *
   * A value stored before the field was indexed was never measured against the
   * index's bounds, so a value the index cannot hold is counted and skipped — the
   * alternative is the database refusing the batch and the operator reading a
   * driver error. What decides the rebuild is the closing revalidation in
   * {@link finishIndexRebuild}, not this page.
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

      const owned = this.findPendingIndex(fenced.state, scope.collectionId, batch.index.id);
      if (!owned || owned.generation !== batch.generation) {
        return admit({
          stale: true,
          rebuiltCount: 0,
          lastKey: null,
          visitedKeys: [],
          incompatibleKeys: [],
        });
      }

      await this.writePendingIndexes(
        trx,
        scope,
        fenced.state.pendingIndexes.map((entry) =>
          entry === owned ? { ...entry, leaseUntil: leaseFrom(at) } : entry,
        ),
        fenced.state.rebuildGeneration,
      );

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

      if (rows.length === 0) {
        return admit({
          stale: false,
          rebuiltCount: 0,
          lastKey: null,
          visitedKeys: [],
          incompatibleKeys: [],
        });
      }

      const keys = rows.map((row) => row.record_key);
      await trx
        .deleteFrom("app_storage_index_entries")
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where("collection_id", "=", scope.collectionId)
        .where("index_id", "=", batch.index.id)
        .where("record_key", "in", keys)
        .execute();

      const incompatibleKeys: string[] = [];
      const values = rows.flatMap((row) => {
        const entry = this.entryForIndex(batch.index, (row.value ?? {}) as BoundedJsonRecord);
        if (!entry) return [];
        if (!this.withinIndexBounds(entry)) {
          incompatibleKeys.push(row.record_key);
          return [];
        }
        return [this.toIndexRow(scope, row.record_key, entry)];
      });

      if (values.length > 0) {
        await trx.insertInto("app_storage_index_entries").values(values).execute();
      }

      return admit({
        stale: false,
        rebuiltCount: rows.length,
        lastKey: keys[keys.length - 1] ?? null,
        visitedKeys: keys,
        incompatibleKeys,
      });
    });
  }

  /**
   * Records that this generation's rebuild converged, and leaves the marker up.
   *
   * Clearing it here would open the window the marker exists to close: between the
   * last batch and the activation, an older release that does not declare this
   * index can rewrite a record and replace its entries with only the ones it
   * knows, silently removing what the rebuild built. So finishing is a
   * compare-and-set that stamps the rebuild as converged and hands back the token
   * activation presents to {@link completeIndexRebuild} inside its own
   * transaction.
   *
   * Before it stamps anything it looks at the collection once more, under the
   * fence it is about to converge under. The batches saw the collection a page at
   * a time and each page's verdict was already stale when the next one ran; this
   * single look is what decides whether the index can be activated at all. A live
   * record still carrying a value the index cannot hold fails the rebuild here
   * rather than at the activation, where the only remaining symptom would be a
   * query quietly missing rows.
   */
  async finishIndexRebuild(input: {
    scope: AppStorageCollectionScope;
    indexId: string;
    generation: number;
  }): Promise<AppStorageAdmitted<AppStorageIndexRebuildFinish>> {
    const { scope } = input;

    return this.db.transaction().execute(async (trx) => {
      const fenced = await this.fence(trx, scope, { mode: "update", denyWhenRevoked: false });
      if (!fenced.admitted) return denied;

      const owned = this.findPendingIndex(fenced.state, scope.collectionId, input.indexId);
      if (!owned || owned.generation !== input.generation) {
        return admit({ outcome: "stale" } as const);
      }

      const at = await this.freshTimestamp(trx);
      const incompatibleCount = await this.countIncompatibleRecords(trx, scope, owned, at);
      if (incompatibleCount > 0) {
        return admit({ outcome: "incompatible_records", incompatibleCount } as const);
      }

      const finishedAt = at.toISOString();
      await this.writePendingIndexes(
        trx,
        scope,
        fenced.state.pendingIndexes.map((entry) =>
          // The lease is renewed with the stamp. A converged rebuild is waiting
          // for an activation that may never arrive, and the marker it leaves
          // behind is exactly as expensive as one belonging to a run that died.
          entry === owned ? { ...entry, finishedAt, leaseUntil: leaseFrom(at) } : entry,
        ),
        fenced.state.rebuildGeneration,
      );

      return admit({
        outcome: "finished",
        completionToken: completionToken(scope.collectionId, input.indexId, input.generation),
      } as const);
    });
  }

  /**
   * Clears a converged rebuild's marker inside a transaction the caller owns, so
   * the release that starts querying the index and the moment writes stop
   * maintaining it for the rebuild are one commit. Split across two, an old
   * release's write lands in between and takes an entry with it.
   *
   * The token names the collection, the index, and the generation, so an
   * activation carrying a stale one clears nothing.
   */
  async completeIndexRebuild(
    executor: AppStorageUnitOfWork,
    input: { scope: AppStorageCollectionScope; indexId: string; completionToken: string },
  ): Promise<AppStorageIndexRebuildCompletion> {
    const trx = executor;
    const { scope } = input;

    const fenced = await this.fence(trx, scope, { mode: "update", denyWhenRevoked: false });
    if (!fenced.admitted) return { outcome: "stale" };

    const owned = this.findPendingIndex(fenced.state, scope.collectionId, input.indexId);
    if (
      !owned ||
      owned.finishedAt === null ||
      completionToken(scope.collectionId, input.indexId, owned.generation) !== input.completionToken
    ) {
      return { outcome: "stale" };
    }

    await this.writePendingIndexes(
      trx,
      scope,
      fenced.state.pendingIndexes.filter((entry) => entry !== owned),
      fenced.state.rebuildGeneration,
    );

    return { outcome: "completed" };
  }

  /**
   * Drops a rebuild that will not be activated. Without it a failed rebuild leaves
   * every future write maintaining an index no release is ever going to query.
   * It is a compare-and-set too: a run that has been superseded cancels nothing.
   */
  async cancelIndexRebuild(input: {
    scope: AppStorageCollectionScope;
    indexId: string;
    generation: number;
  }): Promise<AppStorageAdmitted<AppStorageIndexRebuildCancel>> {
    const { scope } = input;

    return this.db.transaction().execute(async (trx) => {
      const fenced = await this.fence(trx, scope, { mode: "update", denyWhenRevoked: false });
      if (!fenced.admitted) return denied;

      const owned = this.findPendingIndex(fenced.state, scope.collectionId, input.indexId);
      if (!owned || owned.generation !== input.generation) {
        return admit({ outcome: "stale" } as const);
      }

      await this.writePendingIndexes(
        trx,
        scope,
        fenced.state.pendingIndexes.filter((entry) => entry !== owned),
        fenced.state.rebuildGeneration,
      );

      return admit({ outcome: "cancelled" } as const);
    });
  }

  async runInTransaction<TValue>(work: (executor: AppStorageUnitOfWork) => Promise<TValue>): Promise<TValue> {
    return this.db.transaction().execute(async (trx) => work(trx));
  }

  /**
   * The installations whose rebuild markers have run out of lease. The deadline
   * column is the minimum across the installation's markers, so an installation
   * appears here as soon as any one of its rebuilds is past its own deadline.
   *
   * Like every other listing here it takes no locks and decides nothing: it is a
   * discovery pass in deadline order, and each deadline is read again under the
   * state row before anything is dropped.
   */
  async listAbandonedIndexRebuilds(limit: number): Promise<AppStorageInstallationScope[]> {
    if (limit <= 0) return [];

    const rows = await this.db
      .selectFrom("app_storage_installation_state")
      .select(["workspace_id", "installation_id"])
      .where("rebuild_lease_until", "is not", null)
      .where("rebuild_lease_until", "<=", clockTimestamp())
      .where("deleted_at", "is", null)
      .orderBy("rebuild_lease_until", "asc")
      .limit(limit)
      .execute();

    return rows.map((row) => ({ workspaceId: row.workspace_id, installationId: row.installation_id }));
  }

  async cancelAbandonedIndexRebuilds(input: {
    scope: AppStorageInstallationScope;
  }): Promise<AppStorageIndexRebuildSweep> {
    const { scope } = input;

    return this.db.transaction().execute(async (trx) => {
      const fenced = await this.fence(trx, scope, { mode: "update", denyWhenRevoked: false });
      if (!fenced.admitted) return { cancelledCount: 0 };

      const at = await this.freshTimestamp(trx);
      const surviving = await this.dropAbandonedMarkers(trx, scope, fenced.state.pendingIndexes, at, {});
      const cancelledCount = fenced.state.pendingIndexes.length - surviving.length;
      if (cancelledCount === 0) return { cancelledCount: 0 };

      await this.writePendingIndexes(trx, scope, surviving, fenced.state.rebuildGeneration);
      return { cancelledCount };
    });
  }

  /**
   * Lists the collections the next expiry pass could work, least recently swept
   * first. It locks nothing and claims nothing: ordering by a stored cursor is
   * what keeps a busy collection from being picked every round while another
   * keeps its expired rows forever, and a listing that took locks in that
   * fairness order would be taking counter rows in an order no write takes them
   * in. Every decision here is rechecked under a fence by the claim.
   */
  async listExpirySweepCandidates(limit: number): Promise<AppStorageCollectionScope[]> {
    if (limit <= 0) return [];

    const rows = await this.db
      .selectFrom("app_storage_collection_usage as u")
      .select(["u.workspace_id", "u.installation_id", "u.collection_id"])
      .where((eb) =>
        eb.or([
          eb("u.sweep_lease_until", "is", null),
          eb("u.sweep_lease_until", "<=", clockTimestamp()),
        ]),
      )
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
      .execute();

    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      installationId: row.installation_id,
      collectionId: row.collection_id,
    }));
  }

  /**
   * Claims exactly one collection, and never more.
   *
   * One unit at a time is the whole point. A claim that locked several counter
   * rows in sweep order would meet an installation deletion holding its counters
   * in collection order — one holds B and waits for A while the other holds A and
   * waits for B, and PostgreSQL aborts one of them. So this takes the
   * installation's fence first, exactly like every other operation, then that one
   * collection's counter row, and holds nothing else.
   *
   * The claim also has to outlive its own transaction. It commits before the
   * reclamation it authorises runs, so `SKIP LOCKED` would protect only the claim
   * itself and a second worker could take the collection the instant this one
   * committed. What carries the claim across that boundary is a lease: a token and
   * a deadline written with the claim, honoured by other workers until it passes,
   * and reclaimable afterwards so a worker that died holds nothing forever.
   */
  async claimCollectionForExpirySweep(input: {
    scope: AppStorageCollectionScope;
  }): Promise<AppStorageSweepClaim> {
    const { scope } = input;

    return this.db.transaction().execute(async (trx) => {
      const fenced = await this.fence(trx, scope, { mode: "share", denyWhenRevoked: false });
      if (!fenced.admitted) return { claimed: false } as const;

      const row = await trx
        .selectFrom("app_storage_collection_usage")
        .select(["sweep_lease_until"])
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where("collection_id", "=", scope.collectionId)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();

      if (!row) return { claimed: false } as const;

      const at = await this.freshTimestamp(trx);
      if (row.sweep_lease_until !== null && new Date(row.sweep_lease_until).getTime() > at.getTime()) {
        return { claimed: false } as const;
      }

      const leaseToken = randomUUID();
      await trx
        .updateTable("app_storage_collection_usage")
        .set({
          sweep_lease_token: leaseToken,
          sweep_lease_until: new Date(at.getTime() + SWEEP_LEASE_SECONDS * 1000),
          updated_at: at,
        })
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where("collection_id", "=", scope.collectionId)
        .execute();

      return { claimed: true, leaseToken } as const;
    });
  }

  /**
   * Reclaims one bounded batch of a single collection's expired rows, under the
   * lease the claim wrote. It takes the installation's state row first like every
   * other operation, so a sweep and an installation deletion queue behind each
   * other instead of meeting in the middle, and a tombstoned installation is left
   * alone rather than having a counter row recreated beneath it.
   *
   * The lease is rechecked here rather than trusted: it may have expired while
   * this worker was queued, and another worker may already hold it.
   */
  async reclaimExpiredRecords(input: {
    scope: AppStorageCollectionScope;
    limit: number;
    leaseToken: string;
  }): Promise<number> {
    const { scope } = input;

    return this.db.transaction().execute(async (trx) => {
      const fenced = await this.fence(trx, scope, { mode: "share", denyWhenRevoked: false });
      if (!fenced.admitted) return 0;

      const usage = await this.lockCollectionUsage(trx, scope);
      const leased = await trx
        .selectFrom("app_storage_collection_usage")
        .select(["sweep_lease_token", "sweep_lease_until"])
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where("collection_id", "=", scope.collectionId)
        .executeTakeFirst();

      const at = await this.freshTimestamp(trx);
      // Both halves of the lease decide this, under the counter row's own lock.
      // A worker that stalled long enough for its deadline to pass has lost the
      // authority the claim gave it, and a replacement claimant may already be
      // working this collection — the token alone would still let the stalled
      // worker spend a batch nobody asked it for.
      const leaseHolds =
        leased !== undefined &&
        leased.sweep_lease_token === input.leaseToken &&
        leased.sweep_lease_until !== null &&
        new Date(leased.sweep_lease_until).getTime() > at.getTime();
      if (!leaseHolds) return 0;

      const before = usage.recordCount;
      const { live } = await this.reclaimBounded(trx, scope, usage, at, {
        batchSize: input.limit,
        maxBatches: 1,
      });

      // The lease is released with the work it authorised, so the collection is
      // available again immediately rather than at the deadline.
      await trx
        .updateTable("app_storage_collection_usage")
        .set({ last_swept_at: at, sweep_lease_token: null, sweep_lease_until: null })
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
   * Admits an export, and hands back a snapshot that has not opened anything yet.
   *
   * Admission opens no transaction on purpose. An async generator's body does not
   * run until something reads from it, so a transaction started here for a caller
   * that never iterates would never reach its own `finally`: the pooled connection
   * and the MVCC snapshot it pins would be held until the process ended, and a few
   * abandoned exports would exhaust the pool.
   *
   * So the repeatable-read transaction opens on the first read. The state row is
   * read again inside it — that read is the snapshot's first observation, so a
   * tombstone committed before it denies the export while one committed afterwards
   * cannot change the rows this export was admitted against — and the expiry
   * cutoff is taken immediately after it and reused for every page, so no row is
   * live when the snapshot is established and excluded by a later clock.
   *
   * An export does not lock the state row. Its transaction lives as long as the
   * operator is reading, and a lock held that long would stop the App writing for
   * the length of an export. The snapshot does the same work without the cost.
   */
  async openInstallationExport(input: {
    scope: AppStorageInstallationScope;
    batchSize: number;
    idleTimeoutMs?: number;
  }): Promise<AppStorageAdmitted<AppStorageExportSnapshot>> {
    const state = await this.findInstallationState(input.scope);
    if (state?.deletedAt) return denied;

    return admit(
      this.buildExportSnapshot(
        input.scope,
        Math.max(EXPORT_PAGE_MINIMUM, input.batchSize),
        input.idleTimeoutMs ?? EXPORT_IDLE_TIMEOUT_MS,
      ),
    );
  }

  /**
   * The snapshot's own lifetime. It owns one transaction at most, opens it lazily,
   * closes it on completion, on failure, on an abandoning consumer, and on an idle
   * timeout — which is what a caller that admitted an export and walked away is.
   *
   * It has exactly one consumer, and taking ownership is a state transition made
   * before anything is awaited. Two readers sharing one snapshot would each open
   * a transaction and overwrite the other's: whichever finished first would
   * commit or roll back the transaction the other was mid-page in, and the second
   * transaction would be leaked with its connection and its MVCC snapshot. So the
   * second reader is refused rather than served badly.
   *
   * Ending the transaction also waits for whatever page query is in flight.
   * Committing under a running statement is the same defect in the other
   * direction: the idle timer and `close` can both arrive while the generator is
   * awaiting a page.
   */
  private buildExportSnapshot(
    scope: AppStorageInstallationScope,
    batchSize: number,
    idleTimeoutMs: number,
  ): AppStorageExportSnapshot {
    let transaction: ExportTransaction | null = null;
    /** `unopened` until a reader takes the snapshot, `reading` while it holds it. */
    let state: ExportSnapshotState = "unopened";
    /**
     * Read through a call rather than directly. The generator sets `state` and
     * then awaits, and a direct comparison afterwards would be narrowed by the
     * compiler against an assignment that anything running in between may have
     * replaced — which is exactly the case this asks about.
     */
    const isClosed = (): boolean => state === "closed";
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    /** The page query currently running, so nothing ends the transaction under it. */
    let inFlight: Promise<unknown> | null = null;

    const release = async (commit: boolean): Promise<void> => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      state = "closed";
      const open = transaction;
      transaction = null;
      if (!open) return;
      // Settled, not necessarily successful: a page that failed has still let go
      // of the transaction, which is all this needs to know.
      await inFlight?.catch(() => undefined);
      await (commit ? open.commit().execute() : open.rollback().execute());
    };

    const touch = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        void release(false).catch(() => undefined);
      }, idleTimeoutMs);
      // A snapshot waiting to be read is not a reason to keep the process alive.
      idleTimer.unref?.();
    };

    const readPage = async (
      trx: ExportTransaction,
      after: ExportCursor | null,
      at: Date,
    ): Promise<ExportRow[]> =>
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

    const open = async (): Promise<ExportTransaction> =>
      this.db.startTransaction().setIsolationLevel("repeatable read").execute();
    const readState = async (trx: ExportTransaction): Promise<AppStorageInstallationState | null> =>
      this.readState(trx, scope);
    const freshTimestamp = async (trx: ExportTransaction): Promise<Date> => this.freshTimestamp(trx);

    /**
     * Runs one statement on the snapshot's transaction and records that it is
     * running. `release` waits on it, so a close or an idle timeout arriving
     * mid-statement ends the transaction after that statement rather than under
     * it.
     */
    const track = async <TValue>(statement: Promise<TValue>): Promise<TValue> => {
      inFlight = statement;
      try {
        return await statement;
      } finally {
        if (inFlight === statement) inFlight = null;
      }
    };

    async function* read(): AsyncGenerator<ExportedAppStorageRecord> {
      // Taken before anything is awaited, which is what makes it a transition
      // rather than a check: two readers reaching this line cannot both pass.
      if (isClosed()) throw new AppStorageExportClosedError();
      if (state === "reading") throw new AppStorageExportBusyError();
      state = "reading";

      const trx = await open();
      transaction = trx;
      touch();

      let completed = false;
      try {
        // The first read inside the snapshot, and therefore what fixes it.
        const admitted = await track(readState(trx));
        if (admitted?.deletedAt) throw new AppStorageExportDeniedError();

        // Taken immediately after the state read, and reused by every page: a row
        // that is live in the snapshot must not be excluded by a later clock.
        const at = await track(freshTimestamp(trx));
        let after: ExportCursor | null = null;

        for (;;) {
          // The idle timeout may have ended the transaction between pages. Saying
          // so is the point: a consumer that resumes has to learn its snapshot is
          // gone rather than read a driver error about a transaction it never
          // knew it had.
          if (isClosed()) throw new AppStorageExportClosedError();

          const rows: ExportRow[] = await track(readPage(trx, after, at));
          const last = rows[rows.length - 1];

          for (const row of rows) {
            touch();
            yield { ...mapRecord(row), collectionId: row.collection_id };
          }

          if (rows.length < batchSize || !last) break;
          after = { collectionId: last.collection_id, recordKey: last.record_key };
        }

        completed = true;
      } finally {
        await release(completed);
      }
    }

    touch();
    return { read, close: async (): Promise<void> => release(false) };
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
   * Leases a bounded batch of committed intents, and commits the lease before
   * anything is published.
   *
   * Publishing inside this transaction is what a drain must never do. The audit
   * store is the same database, so `record` needs a second pooled connection while
   * this one is held: a one-connection pool deadlocks on the first event, and a
   * larger one is exhausted by enough concurrent drainers. It would also hold row
   * locks across whatever latency the publisher has. So the claim is short, the
   * publish happens outside it, and the acknowledgement comes back by token.
   *
   * Whether the workspace still exists is decided here, with the row. These
   * entries deliberately outlive workspace deletion — they are the evidence of
   * what happened to the data, and a cascade would erase exactly the entries
   * describing the last thing done to a workspace being torn down — so a claim
   * has to say which of them can still be attributed to a workspace. One that
   * cannot travels with a null `workspaceId` and its former workspace as an
   * identifier, which is the only form in which the audit spine can hold it.
   */
  async claimAuditOutboxBatch(input: {
    limit: number;
    leaseSeconds: number;
  }): Promise<AppStorageAuditOutboxClaim> {
    const claimToken = randomUUID();
    if (input.limit <= 0) return { claimToken, entries: [] };

    const entries = await this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom("app_storage_audit_outbox")
        .select((eb) => [
          "id",
          "workspace_id",
          "installation_id",
          "event_type",
          "event_status",
          "metadata",
          "attempt_count",
          eb
            .exists(
              eb
                .selectFrom("workspaces")
                .select("workspaces.id")
                .whereRef("workspaces.id", "=", "app_storage_audit_outbox.workspace_id"),
            )
            .as("workspace_present"),
        ])
        .where((eb) =>
          eb.or([eb("claimed_until", "is", null), eb("claimed_until", "<=", clockTimestamp())]),
        )
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .limit(input.limit)
        .forUpdate()
        .skipLocked()
        .execute();

      if (rows.length === 0) return [];

      const claimedUntil = await trx
        .selectNoFrom(clockTimestamp().as("at"))
        .executeTakeFirstOrThrow();
      await trx
        .updateTable("app_storage_audit_outbox")
        .set({
          claim_token: claimToken,
          claimed_until: new Date(new Date(claimedUntil.at).getTime() + input.leaseSeconds * 1000),
          attempt_count: (eb) => eb("attempt_count", "+", 1),
        })
        .where(
          "id",
          "in",
          rows.map((row) => row.id),
        )
        .execute();

      return rows.map((row) => ({
        eventId: row.id,
        workspaceId: row.workspace_present ? row.workspace_id : null,
        deletedWorkspaceId: row.workspace_present ? null : row.workspace_id,
        installationId: row.installation_id,
        eventType: row.event_type as AppStorageAuditOutboxClaim["entries"][number]["eventType"],
        eventStatus: row.event_status as AppStorageAuditOutboxClaim["entries"][number]["eventStatus"],
        metadata: (row.metadata ?? {}) as AppStorageAuditOutboxClaim["entries"][number]["metadata"],
        attemptCount: row.attempt_count + 1,
      }));
    });

    return { claimToken, entries };
  }

  /**
   * Removes the entries this claim published. The token is part of the predicate,
   * so a drain whose lease expired and was taken over by another worker cannot
   * acknowledge work the other worker is now responsible for.
   */
  async acknowledgeAuditOutbox(input: {
    claimToken: string;
    eventIds: readonly string[];
  }): Promise<number> {
    if (input.eventIds.length === 0) return 0;

    const removed = await this.db
      .deleteFrom("app_storage_audit_outbox")
      .where("claim_token", "=", input.claimToken)
      .where("id", "in", [...input.eventIds])
      .executeTakeFirst();

    return Number(removed.numDeletedRows ?? 0);
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
        "rebuild_generation",
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
        rebuildGeneration: Number(row.rebuild_generation),
      },
    };
  }

  private findPendingIndex(
    state: FencedState,
    collectionId: string,
    indexId: string,
  ): PendingIndex | undefined {
    return state.pendingIndexes.find(
      (entry) => entry.collectionId === collectionId && entry.id === indexId,
    );
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
   * Counts the collection's live rows exactly, for a write whose reclamation
   * stopped with expired rows still there. Without it, bounded reclamation and a
   * counter that still charges for unreclaimed rows would refuse a write no live
   * record is standing in the way of — a quota failure that is not true.
   *
   * The count is bounded by the ceiling plus one, because that is the most the
   * decision ever needs: at or below the ceiling the answer is exact, and past it
   * the only fact that matters is that the collection is over. The byte total
   * comes from the counter rather than from this window, because a truncated
   * window is not the collection's size.
   */
  private async countLiveRecords(
    trx: Transaction<DB>,
    scope: AppStorageCollectionScope,
    at: Date,
    maxRecords: number,
  ): Promise<AppStorageCollectionUsage> {
    const totals = await trx
      .selectFrom((eb) =>
        eb
          .selectFrom("app_storage_records")
          .select("byte_size")
          .where("workspace_id", "=", scope.workspaceId)
          .where("installation_id", "=", scope.installationId)
          .where("collection_id", "=", scope.collectionId)
          .where((inner) => inner.or([inner("expires_at", "is", null), inner("expires_at", ">", at)]))
          .limit(maxRecords + 1)
          .as("live"),
      )
      .select((eb) => [
        eb.fn.countAll<string>().as("record_count"),
        eb.fn.sum<string | null>("live.byte_size").as("byte_size"),
      ])
      .executeTakeFirst();

    return {
      recordCount: Number(totals?.record_count ?? 0),
      byteSize: Number(totals?.byte_size ?? 0),
    };
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
        rebuild_lease_until: null,
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

  /**
   * Writes the pending-index marker, keyed by collection id.
   *
   * The bucket map has a null prototype because a collection id is the App's, not
   * ours: the identifier contract admits `constructor`, and on an ordinary object
   * literal `byCollection["constructor"]` answers with an inherited function that
   * has no `push`. A `Map` would do as well; what must not happen is a valid
   * declaration crashing the marker every write depends on.
   */
  private async writePendingIndexes(
    trx: Transaction<DB>,
    scope: AppStorageInstallationScope,
    pending: readonly PendingIndex[],
    rebuildGeneration: number,
  ): Promise<void> {
    const byCollection = Object.create(null) as Record<string, StoredPendingIndex[]>;
    for (const entry of pending) {
      const bucket = byCollection[entry.collectionId] ?? [];
      bucket.push({
        id: entry.id,
        field: entry.field,
        fieldType: entry.fieldType,
        generation: entry.generation,
        finishedAt: entry.finishedAt,
        leaseUntil: entry.leaseUntil,
      });
      byCollection[entry.collectionId] = bucket;
    }

    await trx
      .updateTable("app_storage_installation_state")
      .set({
        pending_indexes: toJsonb(byCollection),
        rebuild_generation: String(rebuildGeneration),
        // The soonest deadline any of this installation's markers holds, so the
        // sweep's discovery is an index range scan rather than a scan of every
        // state row's JSON. It is derived from the markers on every write, which
        // is what keeps the two from disagreeing.
        rebuild_lease_until: earliestLease(pending),
        updated_at: currentTimestamp(),
      })
      .where("workspace_id", "=", scope.workspaceId)
      .where("installation_id", "=", scope.installationId)
      .execute();
  }

  /**
   * Drops the markers whose lease has run out, together with the entries they
   * built, and answers with the ones still alive. The caller holds the state row,
   * so the deadlines are read under the same lock that would renew them: a
   * rebuild that renewed its lease between a listing and this call keeps it.
   *
   * The entries go with the marker because they are what the marker was for. A
   * rebuild that never converged built a partial index no release can be
   * activated against, and the next rebuild of that index rebuilds every page it
   * touches anyway, so keeping them would only charge the collection for rows
   * nothing reads. An explicit cancellation leaves them, because its caller is
   * present and may retry immediately.
   */
  private async dropAbandonedMarkers(
    trx: Transaction<DB>,
    scope: AppStorageInstallationScope,
    pending: readonly PendingIndex[],
    at: Date,
    exempt: { exceptCollectionId?: string; exceptIndexId?: string },
  ): Promise<PendingIndex[]> {
    const abandoned = pending.filter(
      (entry) =>
        !(entry.collectionId === exempt.exceptCollectionId && entry.id === exempt.exceptIndexId) &&
        entry.leaseUntil !== null &&
        new Date(entry.leaseUntil).getTime() <= at.getTime(),
    );

    for (const entry of abandoned) {
      await trx
        .deleteFrom("app_storage_index_entries")
        .where("workspace_id", "=", scope.workspaceId)
        .where("installation_id", "=", scope.installationId)
        .where("collection_id", "=", entry.collectionId)
        .where("index_id", "=", entry.id)
        .execute();
    }

    return pending.filter((entry) => !abandoned.includes(entry));
  }

  /**
   * Live records whose value the index still cannot hold, counted in the
   * database rather than in memory and bounded, because the exact size of a
   * failure nobody can act on is not worth a full scan.
   *
   * Only a string-valued index has a bound to violate: the other columns hold a
   * scalar the B-tree measures for itself. The two ceilings are the same ones
   * record validation applies — characters for what a query can ask for, bytes
   * for what one index tuple weighs — asked of the stored JSON directly.
   */
  private async countIncompatibleRecords(
    trx: Transaction<DB>,
    scope: AppStorageCollectionScope,
    index: AppStorageIndexDescriptor,
    at: Date,
  ): Promise<number> {
    if (index.fieldType !== "string") return 0;

    const counted = await trx
      .selectFrom((eb) =>
        eb
          .selectFrom("app_storage_records")
          .select("record_key")
          .where("workspace_id", "=", scope.workspaceId)
          .where("installation_id", "=", scope.installationId)
          .where("collection_id", "=", scope.collectionId)
          .where((inner) => inner.or([inner("expires_at", "is", null), inner("expires_at", ">", at)]))
          .where((inner) =>
            inner.or([
              inner(
                sql<number>`char_length(value ->> ${index.field})`,
                ">",
                INDEXED_STRING_CHARACTER_BOUND,
              ),
              inner(
                sql<number>`octet_length(value ->> ${index.field})`,
                ">",
                INDEXED_STRING_BYTE_BOUND,
              ),
            ]),
          )
          .limit(INCOMPATIBLE_REVALIDATION_CEILING)
          .as("over_bound"),
      )
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .executeTakeFirst();

    return Number(counted?.count ?? 0);
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
  ): { admitted: true; entries: AppStorageIndexEntry[] } | { admitted: false; indexId: string } {
    const declaredIds = new Set(declared.map((entry) => entry.indexId));
    const entries: AppStorageIndexEntry[] = [];

    for (const pending of state.pendingIndexes) {
      if (pending.collectionId !== collectionId || declaredIds.has(pending.id)) continue;
      const entry = this.entryForIndex(pending, value);
      if (!entry) continue;
      // Refused, not skipped. The write is the last moment at which the record
      // and the bound it fails are both in hand.
      if (!this.withinIndexBounds(entry)) return { admitted: false, indexId: pending.id };
      entries.push(entry);
    }

    return { admitted: true, entries };
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
      const { id, field, fieldType, generation, finishedAt, leaseUntil } = entry as Record<
        string,
        unknown
      >;
      if (typeof id !== "string" || typeof field !== "string" || typeof fieldType !== "string") continue;
      pending.push({
        collectionId,
        id,
        field,
        fieldType: fieldType as StorageFieldType,
        generation: typeof generation === "number" ? generation : 0,
        finishedAt: typeof finishedAt === "string" ? finishedAt : null,
        leaseUntil: typeof leaseUntil === "string" ? leaseUntil : null,
      });
    }
  }

  return pending;
};

/**
 * The token a finished rebuild hands its activation. It names the collection, the
 * index, and the generation, so presenting one belonging to a superseded rebuild
 * clears nothing.
 */
const completionToken = (collectionId: string, indexId: string, generation: number): string =>
  `${collectionId}:${indexId}:${generation}`;

/** A rebuild marker's next deadline, measured from the database's own clock. */
const leaseFrom = (at: Date): string =>
  new Date(at.getTime() + REBUILD_LEASE_SECONDS * 1000).toISOString();

/**
 * The soonest deadline an installation's markers hold, which is when the sweep
 * next has a reason to look at it. Null when it holds none.
 */
const earliestLease = (pending: readonly PendingIndex[]): Date | null => {
  const deadlines = pending
    .map((entry) => entry.leaseUntil)
    .filter((value): value is string => value !== null)
    .map((value) => new Date(value).getTime());

  return deadlines.length === 0 ? null : new Date(Math.min(...deadlines));
};
