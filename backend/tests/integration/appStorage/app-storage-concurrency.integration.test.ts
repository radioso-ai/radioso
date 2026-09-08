import { randomUUID } from "node:crypto";

import type { StorageCollection } from "@radioso/app-contract";
import type { PoolClient } from "pg";

import { afterAll, beforeAll, expect, it } from "vitest";

import { buildStorageCollection } from "../../support/appStorageCollections.js";
import {
  AppStorageRepository,
  createAppStorageDisposition,
  createAppStorageService,
  createAppStorageSweeper,
} from "../../../src/modules/appStorage/public.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const silentAudit = { async record(): Promise<void> {} };

/**
 * The guarantees this domain claims are about what two callers observe when they
 * run at the same time, and a suite that runs them one after another proves none
 * of them. `Promise.all` is not enough either: it passes when the calls happen to
 * execute back to back.
 *
 * So each case here holds a lock on its own connection, waits until PostgreSQL
 * itself reports the other operation blocked on a lock, and only then releases.
 * The barrier is a fact read out of `pg_stat_activity`, not a timeout — a slow
 * machine makes these tests slower, never green for the wrong reason.
 */
describeIntegration("Managed App Storage under concurrency (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl, { poolMax: 12 });
  const repository = new AppStorageRepository(database.kysely);
  const service = createAppStorageService({ repository });
  const disposition = createAppStorageDisposition({ repository, audit: silentAudit, exportBatchSize: 1 });

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const collection = buildStorageCollection();

  type Scope = { workspaceId: string; installationId: string; collection: StorageCollection };
  const installation = (declared: StorageCollection = collection): Scope => ({
    workspaceId,
    installationId: randomUUID(),
    collection: declared,
  });

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`, [
      accountId,
      "App Storage Concurrency Co",
      `acct-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "App Storage Concurrency Workspace", `route-${workspaceId}`],
    );
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const put = (scope: Scope, key: string, external: string, expectedVersion?: number) =>
    service.put({
      ...scope,
      request: {
        collection: scope.collection.id,
        key,
        record: { external_id: external },
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      },
    });

  const versionOf = (result: Awaited<ReturnType<typeof put>>): number => (result.ok ? result.value.version : -1);

  const scopeOf = (scope: Scope) => ({
    workspaceId: scope.workspaceId,
    installationId: scope.installationId,
    collectionId: scope.collection.id,
  });

  /** Every key the collection still holds that a read would see. */
  const liveKeys = async (scope: Scope): Promise<string[]> => {
    const rows = await database.query<{ record_key: string }>(
      `SELECT record_key FROM app_storage_records
       WHERE workspace_id = $1 AND installation_id = $2
         AND (expires_at IS NULL OR expires_at > clock_timestamp())
       ORDER BY record_key`,
      [scope.workspaceId, scope.installationId],
    );
    return rows.map((row) => row.record_key);
  };

  /**
   * Opens a transaction on its own connection and takes a lock the operations
   * under test have to wait for, so anything the test starts next is held at a
   * known point until `release` runs.
   */
  const holdLock = async (
    scope: Scope,
    row: "state" | "usage",
  ): Promise<{ client: PoolClient; release: () => Promise<void> }> => {
    const client: PoolClient = await database.pool.connect();
    await client.query("BEGIN");

    if (row === "state") {
      await client.query(
        `INSERT INTO app_storage_installation_state (workspace_id, installation_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [scope.workspaceId, scope.installationId],
      );
      await client.query(
        `SELECT 1 FROM app_storage_installation_state
         WHERE workspace_id = $1 AND installation_id = $2 FOR UPDATE`,
        [scope.workspaceId, scope.installationId],
      );
    } else {
      await client.query(
        `INSERT INTO app_storage_collection_usage (workspace_id, installation_id, collection_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [scope.workspaceId, scope.installationId, scope.collection.id],
      );
      await client.query(
        `SELECT 1 FROM app_storage_collection_usage
         WHERE workspace_id = $1 AND installation_id = $2 AND collection_id = $3 FOR UPDATE`,
        [scope.workspaceId, scope.installationId, scope.collection.id],
      );
    }

    return {
      client,
      release: async (): Promise<void> => {
        await client.query("COMMIT");
        client.release();
      },
    };
  };

  /**
   * Blocks until PostgreSQL reports `count` backends waiting on a lock in this
   * database. This is the barrier every case below is built on: the operation
   * under test is provably held, rather than probably held.
   */
  const awaitBlocked = async (count = 1): Promise<void> => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const rows = await database.query<{ blocked: string }>(
        `SELECT count(*)::text AS blocked FROM pg_stat_activity
         WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'`,
      );
      if (Number(rows[0]?.blocked ?? "0") >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no ${count} operation(s) ever blocked on a lock`);
  };

  /** Blocks until the database's own clock has passed an instant it holds. */
  const awaitDeadline = async (scope: Scope, key: string): Promise<void> => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const rows = await database.query<{ passed: boolean }>(
        `SELECT expires_at <= clock_timestamp() AS passed FROM app_storage_records
         WHERE workspace_id = $1 AND installation_id = $2 AND record_key = $3`,
        [scope.workspaceId, scope.installationId, key],
      );
      if (rows[0]?.passed) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`the deadline on ${key} never passed`);
  };

  it("lets exactly one of two writers holding the same version through", async () => {
    const scope = installation();
    const seen = versionOf(await put(scope, "contended", "v1"));

    // Both writers are started while the collection's counter row is held, and
    // the test waits until both are actually queued on a lock. Neither can have
    // run to completion before the other started.
    const lock = await holdLock(scope, "usage");
    const first = put(scope, "contended", "a", seen);
    const second = put(scope, "contended", "b", seen);
    await awaitBlocked(2);
    await lock.release();

    const outcomes = [await first, await second].map((result) =>
      result.ok ? "stored" : result.error.code,
    );
    expect(outcomes.sort()).toEqual(["stored", "version_conflict"]);
  });

  it("hands the last quota slot to exactly one of two competing writers", async () => {
    const tiny = buildStorageCollection({ id: "last_slot", quotas: { maxRecords: 1, maxRecordBytes: 4096 } });
    const scope = installation(tiny);

    const lock = await holdLock(scope, "usage");
    const first = put(scope, "one", "one");
    const second = put(scope, "two", "two");
    await awaitBlocked(2);
    await lock.release();

    const outcomes = [await first, await second].map((result) =>
      result.ok ? "stored" : result.error.code,
    );
    expect(outcomes.sort()).toEqual(["quota_exceeded", "stored"]);
    expect(await service.usage(scope)).toMatchObject({ ok: true, value: { recordCount: 1 } });
  });

  it("makes a write queue behind the collection lock rather than read around it", async () => {
    const scope = installation();
    const lock = await holdLock(scope, "usage");

    const blocked = put(scope, "queued", "queued");
    await awaitBlocked();

    await lock.release();
    expect(await blocked).toMatchObject({ ok: true });
  });

  it("reclaims a record whose deadline passes while a write waits on the lock", async () => {
    const ttl = buildStorageCollection({
      id: "expire_while_blocked",
      quotas: { maxRecords: 1, maxRecordBytes: 4096 },
      retention: { kind: "ttl", seconds: 3600 },
    });
    const scope = installation(ttl);
    await put(scope, "first", "first");

    // The deadline is set into the future before the second write starts, so
    // that write begins its transaction while the first record is genuinely
    // live. Its own transaction-start clock will say so for as long as it waits.
    await database.query(
      `UPDATE app_storage_records SET expires_at = clock_timestamp() + interval '900 milliseconds'
       WHERE workspace_id = $1 AND installation_id = $2 AND record_key = 'first'`,
      [scope.workspaceId, scope.installationId],
    );

    const lock = await holdLock(scope, "usage");
    const blocked = put(scope, "second", "second");
    await awaitBlocked();

    // The deadline is crossed while the write is provably still queued, and only
    // then is the lock released. A write judging liveness by its transaction's
    // start time would still see the first record as live and refuse this one.
    await awaitDeadline(scope, "first");
    await lock.release();

    expect(await blocked).toMatchObject({ ok: true });
    expect(await liveKeys(scope)).toEqual(["second"]);
    expect(await service.usage(scope)).toMatchObject({ ok: true, value: { recordCount: 1 } });
  });

  it("gives a blocked write the full time-to-live it was promised, not what is left of it", async () => {
    const ttl = buildStorageCollection({ id: "ttl_while_blocked", retention: { kind: "ttl", seconds: 60 } });
    const scope = installation(ttl);

    const lock = await holdLock(scope, "usage");
    const blocked = put(scope, "waited", "waited");
    await awaitBlocked();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await lock.release();
    expect(await blocked).toMatchObject({ ok: true });

    // The deadline is measured from when the row landed. Measured from the
    // transaction's start instead, it would already be short by the wait.
    const rows = await database.query<{ remaining: number }>(
      `SELECT extract(epoch from (expires_at - created_at))::float8 AS remaining
       FROM app_storage_records WHERE workspace_id = $1 AND installation_id = $2`,
      [scope.workspaceId, scope.installationId],
    );
    expect(rows[0]?.remaining).toBeCloseTo(60, 1);
  });

  it("runs the expiry sweep against a collection a write is holding without deadlocking", async () => {
    const ttl = buildStorageCollection({ id: "sweep_race", retention: { kind: "ttl", seconds: 3600 } });
    const scope = installation(ttl);
    for (const key of ["a", "b", "c"]) await put(scope, key, key);
    await database.query(
      `UPDATE app_storage_records SET expires_at = clock_timestamp() - interval '1 second'
       WHERE workspace_id = $1 AND installation_id = $2 AND record_key IN ('a', 'b')`,
      [scope.workspaceId, scope.installationId],
    );

    const sweeper = createAppStorageSweeper({ repository, batchSize: 1, maxBatches: 5 });

    // All three are started while the counter row is held, so each has to queue;
    // they are released together and take the row in whatever order PostgreSQL
    // grants it. Because every one of them approaches the installation's state
    // row first and record rows last, none can hold half of another's work.
    const lock = await holdLock(scope, "usage");
    const swept = sweeper.runExpirySweep();
    const written = put(scope, "d", "d");
    const deleted = service.delete({ ...scope, request: { collection: "sweep_race", key: "c" } });
    await awaitBlocked();
    await lock.release();

    expect(await written).toMatchObject({ ok: true });
    expect(await deleted).toMatchObject({ ok: true });
    await swept;

    expect(await liveKeys(scope)).toEqual(["d"]);
    expect(await service.usage(scope)).toMatchObject({ ok: true, value: { recordCount: 1 } });
  });

  it("runs the expiry sweep against an installation being deleted without deadlocking", async () => {
    // The two used to approach the same rows from opposite ends: the sweep held a
    // counter row and waited for a record, while the deletion held the state row
    // and waited for the counters. Both now take state, then counters, then
    // records, so one queues behind the other.
    const ttl = buildStorageCollection({ id: "sweep_vs_delete", retention: { kind: "ttl", seconds: 3600 } });
    const scope = installation(ttl);
    for (const key of ["a", "b", "c"]) await put(scope, key, key);
    await database.query(
      `UPDATE app_storage_records SET expires_at = clock_timestamp() - interval '1 second'
       WHERE workspace_id = $1 AND installation_id = $2 AND record_key IN ('a', 'b')`,
      [scope.workspaceId, scope.installationId],
    );

    const sweeper = createAppStorageSweeper({ repository, batchSize: 1, maxBatches: 5 });

    const lock = await holdLock(scope, "state");
    const swept = sweeper.runExpirySweep();
    const removed = disposition.deleteInstallationStorage(scope);
    await awaitBlocked();
    await lock.release();

    // Neither is aborted as a deadlock victim, and nothing recreates a counter
    // row beneath the tombstone the deletion left.
    await expect(swept).resolves.toBeDefined();
    expect(await removed).toMatchObject({ ok: true });

    const counters = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM app_storage_collection_usage WHERE installation_id = $1`,
      [scope.installationId],
    );
    expect(counters[0]?.count).toBe("0");
  });

  it("holds a write at the fence and refuses it once the revocation commits", async () => {
    const scope = installation();
    await put(scope, "kept", "kept");

    // A disposition in flight: the state row is held exclusively, which is the
    // first lock every runtime operation takes.
    const lock = await holdLock(scope, "state");

    const blocked = put(scope, "kept", "changed");
    // A check made before the operation's own transaction would have passed by now.
    await awaitBlocked();

    await lock.client.query(
      `UPDATE app_storage_installation_state SET access_revoked_at = clock_timestamp()
       WHERE workspace_id = $1 AND installation_id = $2`,
      [scope.workspaceId, scope.installationId],
    );
    await lock.release();

    expect(await blocked).toMatchObject({ ok: false, error: { code: "denied" } });
    const stored = await database.query<{ value: { external_id: string } }>(
      `SELECT value FROM app_storage_records WHERE workspace_id = $1 AND installation_id = $2 AND record_key = 'kept'`,
      [scope.workspaceId, scope.installationId],
    );
    expect(stored[0]?.value.external_id).toBe("kept");
  });

  it("holds a write at the fence and refuses it once the installation deletion commits", async () => {
    const scope = installation();
    await put(scope, "one", "one");

    const lock = await holdLock(scope, "state");

    const blocked = put(scope, "two", "two");
    await awaitBlocked();

    await lock.client.query(
      `DELETE FROM app_storage_records WHERE workspace_id = $1 AND installation_id = $2`,
      [scope.workspaceId, scope.installationId],
    );
    await lock.client.query(
      `DELETE FROM app_storage_collection_usage WHERE workspace_id = $1 AND installation_id = $2`,
      [scope.workspaceId, scope.installationId],
    );
    await lock.client.query(
      `UPDATE app_storage_installation_state SET deleted_at = clock_timestamp()
       WHERE workspace_id = $1 AND installation_id = $2`,
      [scope.workspaceId, scope.installationId],
    );
    await lock.release();

    // The tombstone outlives the rows it accounted for, so the write cannot
    // recreate a record under an installation that no longer holds any.
    expect(await blocked).toMatchObject({ ok: false, error: { code: "denied" } });
    const rows = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM app_storage_records WHERE installation_id = $1`,
      [scope.installationId],
    );
    expect(rows[0]?.count).toBe("0");
  });

  it("builds an added index over records an older release rewrites while the rebuild runs", async () => {
    // The failure this forces: batch one rebuilds a key and commits; before the
    // next batch, a release that does not declare the new index rewrites that key
    // and replaces its entries with only the ones it knows. The cursor never
    // comes back, and activation exposes a query missing that record.
    const before = buildStorageCollection({ id: "rebuild_race" });
    const after = buildStorageCollection({
      id: "rebuild_race",
      indexes: [
        { id: "by_external_id", field: "external_id" },
        { id: "by_sequence", field: "sequence" },
      ],
    });
    const scope = installation(before);

    for (const key of ["a", "b", "c"]) {
      await service.put({
        ...scope,
        request: { collection: "rebuild_race", key, record: { external_id: key, sequence: 1 } },
      });
    }

    const index = { id: "by_sequence", field: "sequence", fieldType: "number" as const };
    const started = await repository.beginIndexRebuild({ scope: scopeOf(scope), index });
    expect(started.admitted).toBe(true);
    const startVersion = started.admitted ? started.value.startVersion : 0;

    const first = await repository.rebuildIndexBatch({
      scope: scopeOf(scope),
      index,
      after: null,
      limit: 1,
      minVersion: null,
    });
    expect(first).toMatchObject({ admitted: true, value: { rebuiltCount: 1, lastKey: "a" } });

    // The old release rewrites the key the first batch already built. Its own
    // declaration has no `by_sequence`, so only the pending marker keeps the
    // entry alive.
    await service.put({
      ...scope,
      request: { collection: "rebuild_race", key: "a", record: { external_id: "a", sequence: 2 } },
    });

    for (const cursor of ["a", "b"]) {
      await repository.rebuildIndexBatch({
        scope: scopeOf(scope),
        index,
        after: cursor,
        limit: 1,
        minVersion: null,
      });
    }

    // The convergence pass revisits only what was written since the marker.
    await repository.rebuildIndexBatch({
      scope: scopeOf(scope),
      index,
      after: null,
      limit: 10,
      minVersion: startVersion,
    });
    expect(await repository.finishIndexRebuild({ scope: scopeOf(scope), indexId: "by_sequence" })).toMatchObject({
      admitted: true,
    });

    const found = await service.query({
      ...scope,
      collection: after,
      request: { collection: "rebuild_race", index: "by_sequence", equals: 2, limit: 10 },
    });
    expect(found).toMatchObject({ ok: true });
    expect(found.ok && found.value.records.map((row) => row.key)).toEqual(["a"]);
  });

  it("takes the App's access away as part of retaining, so retained data is unreachable", async () => {
    // A caller that lost or skipped the preceding revoke step would otherwise
    // leave the App reading and writing data the retention sweep later deletes.
    const scope = installation();
    await put(scope, "held", "held");

    const until = new Date(Date.now() + 86_400_000);
    expect(await disposition.retain({ ...scope, until })).toMatchObject({ ok: true });

    expect(await put(scope, "after", "after")).toMatchObject({ ok: false, error: { code: "denied" } });
    const state = await database.query<{ access_revoked_at: Date | null }>(
      `SELECT access_revoked_at FROM app_storage_installation_state
       WHERE workspace_id = $1 AND installation_id = $2`,
      [scope.workspaceId, scope.installationId],
    );
    expect(state[0]?.access_revoked_at).not.toBeNull();
  });

  it("keeps retained data when an operator extends the hold after the sweep listed it", async () => {
    const scope = installation();
    await put(scope, "held", "held");
    expect(
      await disposition.retain({ ...scope, until: new Date(Date.now() + 86_400_000) }),
    ).toMatchObject({ ok: true });

    // The listing is the sweep's decision, made outside any lock.
    await database.query(
      `UPDATE app_storage_installation_state SET retain_until = clock_timestamp() - interval '1 second'
       WHERE workspace_id = $1 AND installation_id = $2`,
      [scope.workspaceId, scope.installationId],
    );
    const due = await repository.listInstallationsDueForRetention(10);
    expect(due.some((row) => row.installationId === scope.installationId)).toBe(true);

    // The operator extends it before the reclaim runs. The reclaim rechecks the
    // deadline under the state row and finds the hold current.
    await database.query(
      `UPDATE app_storage_installation_state SET retain_until = clock_timestamp() + interval '1 day'
       WHERE workspace_id = $1 AND installation_id = $2`,
      [scope.workspaceId, scope.installationId],
    );

    const reclaimed = await repository.reclaimRetainedInstallation({
      scope: { workspaceId: scope.workspaceId, installationId: scope.installationId },
      audit: () => ({ eventType: "app.data.deletion.completed", eventStatus: "success", metadata: {} }),
    });

    expect(reclaimed).toEqual({ outcome: "not_due" });
    expect(await liveKeys(scope)).toEqual(["held"]);
  });

  it("exports one database state even when records change between its pages", async () => {
    const scope = installation();
    for (const key of ["a", "b", "c"]) await put(scope, key, key);

    const admission = await disposition.export(scope);
    expect(admission.ok).toBe(true);
    if (!admission.ok) return;

    const iterator = admission.stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toMatchObject({ kind: "line" });

    // The snapshot was taken when the export was admitted, so a write that lands
    // between pages belongs wholly outside it rather than half inside.
    await put(scope, "d", "d");
    await service.delete({ ...scope, request: { collection: collection.id, key: "c" } });

    const rest: string[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.kind === "line") rest.push(JSON.parse(next.value.line).key);
    }

    expect(rest).toEqual(["b", "c"]);
  });

  it("refuses an export against a tombstoned installation instead of ending it as EOF", async () => {
    const scope = installation();
    await put(scope, "one", "one");
    expect(await disposition.deleteInstallationStorage(scope)).toMatchObject({ ok: true });

    const admission = await disposition.export(scope);
    expect(admission).toMatchObject({ ok: false, error: { code: "denied" } });
  });

  it("answers a repeated installation deletion with the counts the first one committed", async () => {
    // The first response can be lost to a crashed process or a retried job, and a
    // caller that cannot ask again cannot learn what became of the data.
    const scope = installation();
    for (const key of ["a", "b"]) await put(scope, key, key);

    const first = await disposition.deleteInstallationStorage(scope);
    const second = await disposition.deleteInstallationStorage(scope);

    expect(first).toEqual({ ok: true, value: { recordCount: 2, collectionCount: 1 } });
    expect(second).toEqual(first);
  });

  it("refuses every runtime operation and every disposition once the tombstone is there", async () => {
    const scope = installation();
    await put(scope, "one", "one");
    expect(await disposition.deleteInstallationStorage(scope)).toMatchObject({ ok: true });

    const denied = { ok: false, error: { code: "denied" } };
    expect(await put(scope, "two", "two")).toMatchObject(denied);
    expect(await service.get({ ...scope, request: { collection: collection.id, key: "one" } })).toMatchObject(denied);
    expect(await service.usage(scope)).toMatchObject(denied);
    expect(await disposition.revokeAccess(scope)).toMatchObject(denied);
    expect(await disposition.retain({ ...scope, until: new Date(Date.now() + 86_400_000) })).toMatchObject(denied);
  });

  it("rolls the reclaim back with the write that failed after it", async () => {
    // A put reclaims expired rows and settles the counter before it decides
    // whether the write itself can land. Both belong to one transaction, so a
    // failure afterwards has to take the reclaim with it — otherwise the counter
    // describes rows the failed write never removed.
    const ttl = buildStorageCollection({ id: "reclaim_rollback", retention: { kind: "ttl", seconds: 3600 } });
    const scope = installation(ttl);
    await put(scope, "expired", "expired");
    await database.query(
      `UPDATE app_storage_records SET expires_at = clock_timestamp() - interval '1 second'
       WHERE workspace_id = $1 AND installation_id = $2 AND record_key = 'expired'`,
      [scope.workspaceId, scope.installationId],
    );

    // A trigger that raises on the insert the put makes after it has already
    // reclaimed and written the counter.
    await database.query(`
      CREATE OR REPLACE FUNCTION app_storage_test_poison() RETURNS trigger AS $$
      BEGIN
        IF NEW.record_key = 'poison' THEN RAISE EXCEPTION 'poisoned write'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await database.query(`
      CREATE TRIGGER app_storage_test_poison_trigger BEFORE INSERT ON app_storage_records
      FOR EACH ROW EXECUTE FUNCTION app_storage_test_poison()`);

    try {
      expect(await put(scope, "poison", "poison")).toMatchObject({ ok: false, error: { code: "internal" } });
    } finally {
      await database.query(`DROP TRIGGER app_storage_test_poison_trigger ON app_storage_records`);
      await database.query(`DROP FUNCTION app_storage_test_poison()`);
    }

    // The expired row is still there and the counter still accounts for it,
    // because the transaction that would have removed it did not commit.
    const rows = await database.query<{ record_key: string }>(
      `SELECT record_key FROM app_storage_records WHERE installation_id = $1`,
      [scope.installationId],
    );
    const counter = await database.query<{ record_count: number }>(
      `SELECT record_count FROM app_storage_collection_usage WHERE installation_id = $1`,
      [scope.installationId],
    );
    expect(rows.map((row) => row.record_key)).toEqual(["expired"]);
    expect(counter[0]?.record_count).toBe(1);
  });

  it("leaves the counter describing the rows that are there when a write is refused", async () => {
    const tiny = buildStorageCollection({ id: "rollback_usage", quotas: { maxRecords: 1, maxRecordBytes: 4096 } });
    const scope = installation(tiny);
    await put(scope, "only", "only");

    // The refused write reclaims expired rows and then rolls back its own effect;
    // what must not happen is a counter left describing the write that failed.
    expect(await put(scope, "extra", "extra")).toMatchObject({ ok: false, error: { code: "quota_exceeded" } });

    const stored = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM app_storage_records WHERE installation_id = $1`,
      [scope.installationId],
    );
    const counter = await database.query<{ record_count: number; byte_size: string }>(
      `SELECT record_count, byte_size::text FROM app_storage_collection_usage WHERE installation_id = $1`,
      [scope.installationId],
    );
    expect(stored[0]?.count).toBe("1");
    expect(counter[0]?.record_count).toBe(1);
    expect(await service.usage(scope)).toMatchObject({ ok: true, value: { recordCount: 1 } });
  });
});
