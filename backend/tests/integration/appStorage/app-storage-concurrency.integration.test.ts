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
  INDEXED_STRING_BYTE_BOUND,
  type AppStorageService,
  type ExportedAppStorageRecord,
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

  /** Single-connection pools the PID-named barriers use, closed with the suite. */
  const pinnedDatabases: Database[] = [];

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
    for (const owned of pinnedDatabases) await owned.close().catch(() => undefined);
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  /**
   * A write issued by a named writer. Every case that has to prove two writes
   * were held at the same moment issues them through {@link pinned} services, so
   * the barrier can name the backends rather than count them.
   */
  const putVia = (
    writer: AppStorageService,
    scope: Scope,
    key: string,
    external: string,
    expectedVersion?: number,
  ) =>
    writer.put({
      ...scope,
      request: {
        collection: scope.collection.id,
        key,
        record: { external_id: external },
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      },
    });

  const put = (scope: Scope, key: string, external: string, expectedVersion?: number) =>
    putVia(service, scope, key, external, expectedVersion);

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
   * A repository and a service on a pool of exactly one connection, and that
   * connection's backend pid.
   *
   * Counting blocked backends across the whole database proves only that
   * *something* is waiting — another case, another suite, a stray session. Every
   * claim in this file is "this operation and that one were both held at the same
   * moment", so the barrier names them, and a single-connection pool is what
   * makes an operation's backend identifiable.
   */
  const pinned = async (): Promise<{
    repository: AppStorageRepository;
    service: AppStorageService;
    database: Database;
    pid: number;
  }> => {
    const owned = new Database(integrationDatabaseUrl, { poolMax: 1 });
    const [row] = await owned.query<{ pid: number }>(`SELECT pg_backend_pid()::int AS pid`);
    pinnedDatabases.push(owned);
    const ownedRepository = new AppStorageRepository(owned.kysely);
    return {
      repository: ownedRepository,
      service: createAppStorageService({ repository: ownedRepository }),
      database: owned,
      pid: row?.pid ?? -1,
    };
  };

  /** Blocks until every named backend is waiting on a lock, not merely some backend. */
  const awaitBlockedPids = async (pids: readonly number[]): Promise<void> => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const rows = await database.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid = ANY($1::int[])`,
        [[...pids]],
      );
      if (rows.length >= pids.length) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`backends ${pids.join(", ")} did not all block on a lock`);
  };

  /** Backends sitting inside an open transaction, which is what a leaked snapshot looks like. */
  const idleInTransaction = async (): Promise<number> => {
    const rows = await database.query<{ open: string }>(
      `SELECT count(*)::text AS open FROM pg_stat_activity
       WHERE datname = current_database() AND state = 'idle in transaction'`,
    );
    return Number(rows[0]?.open ?? "0");
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
    const one = await pinned();
    const two = await pinned();
    const first = putVia(one.service, scope, "contended", "a", seen);
    const second = putVia(two.service, scope, "contended", "b", seen);
    await awaitBlockedPids([one.pid, two.pid]);
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
    const one = await pinned();
    const two = await pinned();
    const first = putVia(one.service, scope, "one", "one");
    const second = putVia(two.service, scope, "two", "two");
    await awaitBlockedPids([one.pid, two.pid]);
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

    const writer = await pinned();
    const blocked = putVia(writer.service, scope, "queued", "queued");
    await awaitBlockedPids([writer.pid]);

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
    const writer = await pinned();
    const blocked = putVia(writer.service, scope, "second", "second");
    await awaitBlockedPids([writer.pid]);

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
    const writer = await pinned();
    const blocked = putVia(writer.service, scope, "waited", "waited");
    await awaitBlockedPids([writer.pid]);
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

    // Each of the three runs on its own named connection, so the barrier below
    // waits for all three to be provably queued rather than for one unnamed
    // backend that might belong to anything.
    const sweeperConnection = await pinned();
    const writerConnection = await pinned();
    const deleterConnection = await pinned();
    const sweeper = createAppStorageSweeper({
      repository: sweeperConnection.repository,
      batchSize: 1,
      maxBatches: 5,
    });
    const writer = createAppStorageService({ repository: writerConnection.repository });
    const deleter = createAppStorageService({ repository: deleterConnection.repository });

    // All three are started while the counter row is held, so each has to queue;
    // they are released together and take the row in whatever order PostgreSQL
    // grants it. Because every one of them approaches the installation's state
    // row first and record rows last, none can hold half of another's work.
    const lock = await holdLock(scope, "usage");
    const swept = sweeper.runExpirySweep();
    const written = writer.put({
      ...scope,
      request: { collection: "sweep_race", key: "d", record: { external_id: "d" } },
    });
    const deleted = deleter.delete({ ...scope, request: { collection: "sweep_race", key: "c" } });
    await awaitBlockedPids([
      sweeperConnection.pid,
      writerConnection.pid,
      deleterConnection.pid,
    ]);
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

    const sweeperConnection = await pinned();
    const deleterConnection = await pinned();
    const sweeper = createAppStorageSweeper({
      repository: sweeperConnection.repository,
      batchSize: 1,
      maxBatches: 5,
    });
    const deleter = createAppStorageDisposition({
      repository: deleterConnection.repository,
      audit: silentAudit,
    });

    const lock = await holdLock(scope, "state");
    const swept = sweeper.runExpirySweep();
    const removed = deleter.deleteInstallationStorage(scope);
    await awaitBlockedPids([sweeperConnection.pid, deleterConnection.pid]);
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

    const writer = await pinned();
    const blocked = putVia(writer.service, scope, "kept", "changed");
    // A check made before the operation's own transaction would have passed by now.
    await awaitBlockedPids([writer.pid]);

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

    const writer = await pinned();
    const blocked = putVia(writer.service, scope, "two", "two");
    await awaitBlockedPids([writer.pid]);

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
    expect(started).toMatchObject({ admitted: true, value: { outcome: "started" } });
    if (!started.admitted || started.value.outcome !== "started") return;
    const { startVersion, generation } = started.value;

    const first = await repository.rebuildIndexBatch({
      scope: scopeOf(scope),
      index,
      generation,
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
        generation,
        after: cursor,
        limit: 1,
        minVersion: null,
      });
    }

    // The convergence pass revisits only what was written since the marker.
    await repository.rebuildIndexBatch({
      scope: scopeOf(scope),
      index,
      generation,
      after: null,
      limit: 10,
      minVersion: startVersion,
    });
    const finished = await repository.finishIndexRebuild({
      scope: scopeOf(scope),
      indexId: "by_sequence",
      generation,
    });
    expect(finished).toMatchObject({ admitted: true, value: { outcome: "finished" } });

    // The marker stays up until activation clears it, in one transaction with the
    // release taking the index over.
    if (!finished.admitted || finished.value.outcome !== "finished") return;
    const completionToken = finished.value.completionToken;
    await repository.runInTransaction(async (tx) =>
      repository.completeIndexRebuild(tx, {
        scope: scopeOf(scope),
        indexId: "by_sequence",
        completionToken,
      }),
    );

    const found = await service.query({
      ...scope,
      collection: after,
      request: { collection: "rebuild_race", index: "by_sequence", equals: 2, limit: 10 },
    });
    expect(found).toMatchObject({ ok: true });
    expect(found.ok && found.value.records.map((row) => row.key)).toEqual(["a"]);
  });

  it("claims one collection under its own fence while an installation deletion holds another", async () => {
    // The lock cycle this rules out: a sweep holding collection B's counter while
    // it waits for A, against a deletion holding the state row and A while it
    // waits for B. A claim that took several counter rows in sweep order could
    // sit on either side of it. This one takes the installation's fence first and
    // exactly one counter row, so the two queue instead of meeting.
    const ttl = buildStorageCollection({ id: "claim_a", retention: { kind: "ttl", seconds: 3600 } });
    const other = buildStorageCollection({ id: "claim_b", retention: { kind: "ttl", seconds: 3600 } });
    const base = installation(ttl);
    for (const declared of [ttl, other]) {
      await put({ ...base, collection: declared }, "gone", "gone");
    }
    await database.query(
      `UPDATE app_storage_records SET expires_at = clock_timestamp() - interval '1 second'
       WHERE workspace_id = $1 AND installation_id = $2`,
      [base.workspaceId, base.installationId],
    );

    const claimerConnection = await pinned();
    const deleterConnection = await pinned();
    const deleter = createAppStorageDisposition({
      repository: deleterConnection.repository,
      audit: silentAudit,
    });

    const lock = await holdLock(base, "state");
    const claimed = claimerConnection.repository.claimCollectionForExpirySweep({
      scope: { ...base, collectionId: "claim_b" },
    });
    const removed = deleter.deleteInstallationStorage(base);
    await awaitBlockedPids([claimerConnection.pid, deleterConnection.pid]);
    await lock.release();

    // Neither is aborted as a deadlock victim. Whichever runs second meets the
    // tombstone rather than a half-held set of counters.
    await expect(claimed).resolves.toBeDefined();
    expect(await removed).toMatchObject({ ok: true });
  });

  it("reclaims a lease whose deadline has passed, so a worker that died holds nothing forever", async () => {
    const ttl = buildStorageCollection({ id: "stale_lease", retention: { kind: "ttl", seconds: 3600 } });
    const scope = installation(ttl);
    await put(scope, "gone", "gone");
    await database.query(
      `UPDATE app_storage_records SET expires_at = clock_timestamp() - interval '1 second'
       WHERE workspace_id = $1 AND installation_id = $2`,
      [scope.workspaceId, scope.installationId],
    );

    const collectionScope = scopeOf(scope);
    expect(await repository.claimCollectionForExpirySweep({ scope: collectionScope })).toMatchObject({
      claimed: true,
    });
    // A live lease is honoured.
    expect(await repository.claimCollectionForExpirySweep({ scope: collectionScope })).toEqual({
      claimed: false,
    });

    await database.query(
      `UPDATE app_storage_collection_usage SET sweep_lease_until = clock_timestamp() - interval '1 second'
       WHERE workspace_id = $1 AND installation_id = $2 AND collection_id = $3`,
      [scope.workspaceId, scope.installationId, collectionScope.collectionId],
    );

    expect(await repository.claimCollectionForExpirySweep({ scope: collectionScope })).toMatchObject({
      claimed: true,
    });
  });

  it("admits a write against a collection whose expired backlog is larger than one reclaim", async () => {
    // The false quota failure this rules out: a ceiling of one, a backlog of
    // expired rows larger than a foreground reclaim may remove, and a counter
    // still charging for every one of them. Bounded reclamation alone would
    // refuse a write no live record is standing in the way of.
    const tiny = buildStorageCollection({
      id: "false_quota",
      quotas: { maxRecords: 1, maxRecordBytes: 4096 },
      retention: { kind: "ttl", seconds: 3600 },
    });
    const scope = installation(tiny);

    // Larger than two foreground reclaims, so the backlog is still there after
    // the put has done its share and after the first usage read has done its
    // own — which is what makes both intermediate numbers below exact.
    const keys = Array.from({ length: 3_000 }, (_unused, index) => `k${index}`);
    await database.query(
      `INSERT INTO app_storage_records
         (workspace_id, installation_id, collection_id, record_key, schema_version, value, byte_size, version, expires_at)
       SELECT $1, $2, 'false_quota', key, 1, '{"external_id":"x"}'::jsonb, 20, ordinality,
              clock_timestamp() - interval '1 second'
       FROM unnest($3::text[]) WITH ORDINALITY AS t(key, ordinality)`,
      [scope.workspaceId, scope.installationId, keys],
    );
    await database.query(
      `INSERT INTO app_storage_collection_usage
         (workspace_id, installation_id, collection_id, record_count, byte_size, next_version)
       VALUES ($1, $2, 'false_quota', $3, $4, $5)
       ON CONFLICT (workspace_id, installation_id, collection_id) DO UPDATE
       SET record_count = EXCLUDED.record_count, byte_size = EXCLUDED.byte_size,
           next_version = EXCLUDED.next_version`,
      [scope.workspaceId, scope.installationId, keys.length, keys.length * 20, keys.length + 1],
    );

    expect(await put(scope, "fresh", "fresh")).toMatchObject({ ok: true });
    expect(await liveKeys(scope)).toEqual(["fresh"]);

    // The counter counts the rows that are there, live or expired-and-not-yet-
    // reclaimed, and every reclaim's arithmetic subtracts against that meaning.
    // The put gave back exactly one foreground budget — four batches of 256 —
    // and left the rest, so this number is the whole claim: it is neither the
    // live count nor the original backlog.
    const counter = async (): Promise<number> => {
      const rows = await database.query<{ record_count: number; expired: string }>(
        `SELECT u.record_count,
                (SELECT count(*)::text FROM app_storage_records r
                  WHERE r.workspace_id = u.workspace_id AND r.installation_id = u.installation_id
                    AND r.collection_id = u.collection_id
                    AND r.expires_at IS NOT NULL AND r.expires_at <= clock_timestamp()) AS expired
           FROM app_storage_collection_usage u
          WHERE u.workspace_id = $1 AND u.installation_id = $2 AND u.collection_id = 'false_quota'`,
        [scope.workspaceId, scope.installationId],
      );
      expect(rows[0]?.record_count).toBe(Number(rows[0]?.expired ?? "0") + 1);
      return rows[0]?.record_count ?? -1;
    };
    expect(await counter()).toBe(keys.length - 1_024 + 1);

    // And the read says so rather than leaving the number looking simply high:
    // one usage call reclaims its own budget and reports what is still there
    // together with the fact that a backlog remains.
    expect(await service.usage(scope)).toMatchObject({
      ok: true,
      value: { recordCount: keys.length - 2_048 + 1, reclaimPending: true },
    });

    // Once the backlog is gone the counter and the live rows agree again.
    for (let pass = 0; pass < 10; pass += 1) {
      const usage = await service.usage(scope);
      if (usage.ok && !usage.value.reclaimPending) break;
    }
    expect(await service.usage(scope)).toMatchObject({
      ok: true,
      value: { recordCount: 1, reclaimPending: false },
    });
  });

  it("refuses to restore access while a retention hold stands, and allows it once cancelled", async () => {
    const scope = installation();
    await put(scope, "held", "held");
    expect(
      await disposition.retain({ ...scope, until: new Date(Date.now() + 86_400_000) }),
    ).toMatchObject({ ok: true });

    // Restoring here would hand a running App data the retention sweep is going
    // to destroy.
    expect(await disposition.restoreAccess(scope)).toMatchObject({
      ok: false,
      error: { code: "denied" },
    });
    expect(await put(scope, "after", "after")).toMatchObject({ ok: false, error: { code: "denied" } });

    // Cancelling the hold is the operator's own explicit step, and it leaves
    // access revoked: ending a scheduled destruction and handing the data back
    // are two decisions.
    expect(await disposition.cancelRetention(scope)).toMatchObject({ ok: true });
    expect(await put(scope, "still", "still")).toMatchObject({ ok: false, error: { code: "denied" } });

    expect(await disposition.restoreAccess(scope)).toMatchObject({ ok: true });
    expect(await put(scope, "after", "after")).toMatchObject({ ok: true });

    const state = await database.query<{ retain_until: Date | null }>(
      `SELECT retain_until FROM app_storage_installation_state
       WHERE workspace_id = $1 AND installation_id = $2`,
      [scope.workspaceId, scope.installationId],
    );
    expect(state[0]?.retain_until).toBeNull();
  });

  it("loses a stale generation's attempt to finish a rebuild another run took over", async () => {
    const scope = installation();
    await put(scope, "a", "a");

    const index = { id: "by_sequence", field: "sequence", fieldType: "number" as const };
    const first = await repository.beginIndexRebuild({ scope: scopeOf(scope), index });
    const second = await repository.beginIndexRebuild({ scope: scopeOf(scope), index });
    expect(first).toMatchObject({ admitted: true, value: { outcome: "started" } });
    expect(second).toMatchObject({ admitted: true, value: { outcome: "started" } });
    if (!first.admitted || first.value.outcome !== "started") return;
    if (!second.admitted || second.value.outcome !== "started") return;
    const firstGeneration = first.value.generation;
    const secondGeneration = second.value.generation;
    expect(secondGeneration).toBeGreaterThan(firstGeneration);

    // The first run finishing here would clear a marker the second run is still
    // scanning under, and every write from that point would stop maintaining the
    // index the second run is building.
    await expect(
      repository.finishIndexRebuild({
        scope: scopeOf(scope),
        indexId: index.id,
        generation: firstGeneration,
      }),
    ).resolves.toMatchObject({ admitted: true, value: { outcome: "stale" } });

    await expect(
      repository.cancelIndexRebuild({
        scope: scopeOf(scope),
        indexId: index.id,
        generation: firstGeneration,
      }),
    ).resolves.toMatchObject({ admitted: true, value: { outcome: "stale" } });

    const owner = await repository.finishIndexRebuild({
      scope: scopeOf(scope),
      indexId: index.id,
      generation: secondGeneration,
    });
    expect(owner).toMatchObject({ admitted: true, value: { outcome: "finished" } });
    if (!owner.admitted || owner.value.outcome !== "finished") return;
    const ownerToken = owner.value.completionToken;

    // A completion carrying the superseded run's token clears nothing either.
    await expect(
      repository.runInTransaction(async (tx) =>
        repository.completeIndexRebuild(tx, {
          scope: scopeOf(scope),
          indexId: index.id,
          completionToken: `sync_state:${index.id}:${firstGeneration}`,
        }),
      ),
    ).resolves.toEqual({ outcome: "stale" });

    await expect(
      repository.runInTransaction(async (tx) =>
        repository.completeIndexRebuild(tx, {
          scope: scopeOf(scope),
          indexId: index.id,
          completionToken: ownerToken,
        }),
      ),
    ).resolves.toEqual({ outcome: "completed" });

    const pending = await database.query<{ pending_indexes: Record<string, unknown> }>(
      `SELECT pending_indexes FROM app_storage_installation_state
       WHERE workspace_id = $1 AND installation_id = $2`,
      [scope.workspaceId, scope.installationId],
    );
    expect(pending[0]?.pending_indexes).toEqual({});
  });

  it("serializes a pending index for a collection named after an inherited property", async () => {
    // `constructor` is a valid collection id under the identifier contract, and
    // an ordinary object literal answers `byCollection["constructor"]` with an
    // inherited function that has no `push`.
    const awkward = buildStorageCollection({ id: "constructor" });
    const scope = installation(awkward);
    await put(scope, "a", "a");

    const started = await repository.beginIndexRebuild({
      scope: scopeOf(scope),
      index: { id: "by_sequence", field: "sequence", fieldType: "number" },
    });
    expect(started.admitted).toBe(true);

    // The marker is readable, and a write under it still maintains the index.
    expect(await put(scope, "b", "b")).toMatchObject({ ok: true });
    const pending = await database.query<{ pending_indexes: Record<string, unknown[]> }>(
      `SELECT pending_indexes FROM app_storage_installation_state
       WHERE workspace_id = $1 AND installation_id = $2`,
      [scope.workspaceId, scope.installationId],
    );
    expect(Object.keys(pending[0]?.pending_indexes ?? {})).toEqual(["constructor"]);
  });

  it("holds no transaction for an export that is admitted and never read", async () => {
    const scope = installation();
    await put(scope, "one", "one");

    const before = await idleInTransaction();
    const admission = await disposition.export(scope);
    expect(admission.ok).toBe(true);
    if (!admission.ok) return;

    // Admission is a decision, not a transaction. An async generator's body never
    // runs for a caller that does not iterate, so a transaction opened at
    // admission would never reach its own cleanup — the connection and the MVCC
    // snapshot would be pinned for the life of the process.
    expect(await idleInTransaction()).toBe(before);

    await admission.snapshot.close();
    expect(await idleInTransaction()).toBe(before);
  });

  it("aborts a snapshot whose consumer stalled between pages", async () => {
    const scope = installation();
    for (const key of ["a", "b", "c"]) await put(scope, key, key);

    const impatient = createAppStorageDisposition({
      repository,
      audit: silentAudit,
      exportBatchSize: 1,
      exportIdleTimeoutMs: 120,
    });
    const admission = await impatient.export(scope);
    expect(admission.ok).toBe(true);
    if (!admission.ok) return;

    const iterator = admission.snapshot.stream()[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ kind: "line" });

    // The consumer stops reading without closing. A repeatable-read transaction
    // held open by nobody pins a connection and an old snapshot, so the snapshot
    // ends itself.
    await new Promise((resolve) => setTimeout(resolve, 400));

    const events = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "error", error: expect.objectContaining({ code: "unavailable" }) }),
    );
  });

  it("refuses an export whose installation was deleted before its first read", async () => {
    // Admission opens nothing, so the snapshot is fixed by the state row it reads
    // inside its own transaction. A tombstone committed before that read has to
    // refuse the export rather than let it stream data that is already gone.
    const scope = installation();
    await put(scope, "one", "one");

    const admission = await disposition.export(scope);
    expect(admission.ok).toBe(true);
    if (!admission.ok) return;

    expect(await disposition.deleteInstallationStorage(scope)).toMatchObject({ ok: true });

    const events = [];
    for await (const event of admission.snapshot.stream()) events.push(event);
    expect(events).toEqual([
      expect.objectContaining({ kind: "error", error: expect.objectContaining({ code: "denied" }) }),
    ]);
  });

  it("publishes the outbox outside its claim and retries an entry whose sink failed", async () => {
    const scope = installation();
    await put(scope, "one", "one");

    let failNext = true;
    const flaky = {
      published: [] as string[],
      async record(event: { eventId: string }): Promise<void> {
        if (failNext) {
          failNext = false;
          throw new Error("sink down");
        }
        this.published.push(event.eventId);
      },
    };

    // A one-connection pool is the sharpest form of the failure a drain that
    // published inside its own transaction would hit: the sink needs a
    // connection while the claim holds the only one.
    const single = new Database(integrationDatabaseUrl, { poolMax: 1 });
    pinnedDatabases.push(single);
    const drainer = createAppStorageDisposition({
      repository: new AppStorageRepository(single.kysely),
      audit: flaky,
      auditDrainLimit: 1,
      auditLeaseSeconds: 1,
    });

    await drainer.deleteInstallationStorage(scope);

    const first = await drainer.drainAuditOutbox();
    expect(first).toMatchObject({ publishedCount: 0, failureCount: 1 });

    // The entry keeps its lease, so a drain running immediately afterwards leaves
    // it alone; once the lease expires it is claimed and published again.
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const retried = await drainer.drainAuditOutbox();
    expect(retried).toMatchObject({ publishedCount: 1, failureCount: 0 });
    expect(flaky.published).toHaveLength(1);
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

    const iterator = admission.snapshot.stream()[Symbol.asyncIterator]();
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
  it("rolls an activation back together with the rebuild completion it committed with", async () => {
    // The seam this proves: the `apps` domain flips a release's visibility and
    // this domain clears the rebuild marker in one commit. Split across two,
    // an older release's write lands between them and takes an index entry with
    // it. The executor is the platform's own transaction type, so the activation
    // running in it issues its own statements against its own tables.
    const scope = installation();
    await put(scope, "a", "a");

    const index = { id: "by_sequence", field: "sequence", fieldType: "number" as const };
    const started = await repository.beginIndexRebuild({ scope: scopeOf(scope), index });
    expect(started).toMatchObject({ admitted: true, value: { outcome: "started" } });
    if (!started.admitted || started.value.outcome !== "started") return;

    const finished = await repository.finishIndexRebuild({
      scope: scopeOf(scope),
      indexId: index.id,
      generation: started.value.generation,
    });
    expect(finished).toMatchObject({ admitted: true, value: { outcome: "finished" } });
    if (!finished.admitted || finished.value.outcome !== "finished") return;
    const completionToken = finished.value.completionToken;

    // The activation's own mutation, in the same transaction as the completion.
    // It is a row this domain does not own, which is the point of the seam.
    const activationKey = `activation-${randomUUID()}`;
    await expect(
      repository.runInTransaction(async (tx) => {
        const completed = await repository.completeIndexRebuild(tx, {
          scope: scopeOf(scope),
          indexId: index.id,
          completionToken,
        });
        expect(completed).toEqual({ outcome: "completed" });

        await tx
          .insertInto("workspaces")
          .values({
            id: randomUUID(),
            account_id: accountId,
            name: "Activation",
            public_route_key: activationKey,
          })
          .execute();

        throw new Error("activation failed after both writes");
      }),
    ).rejects.toThrow("activation failed after both writes");

    // Neither half committed. The marker is still up, so writes keep maintaining
    // the index, and the activation's own row is not there either.
    const pending = await database.query<{ pending_indexes: Record<string, unknown> }>(
      `SELECT pending_indexes FROM app_storage_installation_state
       WHERE workspace_id = $1 AND installation_id = $2`,
      [scope.workspaceId, scope.installationId],
    );
    expect(Object.keys(pending[0]?.pending_indexes ?? {})).toEqual(["sync_state"]);

    const activated = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workspaces WHERE public_route_key = $1`,
      [activationKey],
    );
    expect(activated[0]?.count).toBe("0");
  });

  it("hands a snapshot to one reader and refuses the second, leaking no transaction", async () => {
    // Two readers sharing one snapshot would each open a transaction and
    // overwrite the other's: whichever finished first would end the transaction
    // the other was mid-page in, and the second would be leaked with its
    // connection and its MVCC snapshot.
    const scope = installation();
    for (const key of ["a", "b", "c"]) await put(scope, key, key);

    const before = await idleInTransaction();
    const opened = await repository.openInstallationExport({ scope, batchSize: 1 });
    expect(opened.admitted).toBe(true);
    if (!opened.admitted) return;

    const first = opened.value.read()[Symbol.asyncIterator]();
    const second = opened.value.read()[Symbol.asyncIterator]();

    // The winner is whichever reader's generator body runs first; what matters is
    // that exactly one of them owns the snapshot.
    const outcomes = await Promise.allSettled([first.next(), second.next()]);
    const refusals = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.reason).toMatchObject({ name: "AppStorageExportBusyError" });

    const wonFirst = outcomes[0]?.status === "fulfilled";
    const winner = wonFirst ? first : second;
    const opening = (wonFirst ? outcomes[0] : outcomes[1]) as PromiseFulfilledResult<
      IteratorResult<ExportedAppStorageRecord>
    >;

    // The winner reads the whole installation, starting from the row its own
    // first `next` already produced: being refused a snapshot must cost the
    // other reader nothing.
    const rows = opening.value.done ? [] : [opening.value.value];
    for (;;) {
      const next = await winner.next();
      if (next.done) break;
      rows.push(next.value);
    }
    expect(rows.map((row) => row.key)).toEqual(["a", "b", "c"]);

    // The refused reader opened nothing, and the winner's transaction ended with
    // its own iteration.
    await opened.value.close();
    expect(await idleInTransaction()).toBe(before);
  });

  it("refuses a reclaim whose lease deadline passed, even when it still holds the token", async () => {
    // Locking keeps the data right either way; what the deadline decides is who
    // owns the work. A worker that stalled past its deadline can otherwise spend
    // a batch a replacement claimant is already responsible for.
    const ttl = buildStorageCollection({ id: "expired_lease", retention: { kind: "ttl", seconds: 3600 } });
    const scope = installation(ttl);
    for (const key of ["a", "b"]) await put(scope, key, key);
    await database.query(
      `UPDATE app_storage_records SET expires_at = clock_timestamp() - interval '1 second'
       WHERE workspace_id = $1 AND installation_id = $2`,
      [scope.workspaceId, scope.installationId],
    );

    const claim = await repository.claimCollectionForExpirySweep({ scope: scopeOf(scope) });
    expect(claim).toMatchObject({ claimed: true });
    if (!claim.claimed) return;

    await database.query(
      `UPDATE app_storage_collection_usage SET sweep_lease_until = clock_timestamp() - interval '1 second'
       WHERE workspace_id = $1 AND installation_id = $2 AND collection_id = $3`,
      [scope.workspaceId, scope.installationId, "expired_lease"],
    );

    expect(
      await repository.reclaimExpiredRecords({ scope: scopeOf(scope), limit: 10, leaseToken: claim.leaseToken }),
    ).toBe(0);
    const remaining = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM app_storage_records WHERE installation_id = $1`,
      [scope.installationId],
    );
    expect(remaining[0]?.count).toBe("2");
  });

  it("drops a rebuild marker whose lease ran out, and the entries it built", async () => {
    // A marker outlives the process that set it. Until it is dropped, every
    // write to the collection maintains an index no release is going to query.
    const scope = installation();
    await put(scope, "a", "a");

    const index = { id: "by_sequence", field: "sequence", fieldType: "number" as const };
    const started = await repository.beginIndexRebuild({ scope: scopeOf(scope), index });
    expect(started).toMatchObject({ admitted: true, value: { outcome: "started" } });
    if (!started.admitted || started.value.outcome !== "started") return;

    await repository.rebuildIndexBatch({
      scope: scopeOf(scope),
      index,
      generation: started.value.generation,
      after: null,
      limit: 10,
      minVersion: null,
    });

    // A live marker is nobody's to collect.
    expect(
      await repository.cancelAbandonedIndexRebuilds({ scope }),
    ).toEqual({ cancelledCount: 0 });

    const expire = async (): Promise<void> => {
      await database.query(
        `UPDATE app_storage_installation_state
            SET rebuild_lease_until = clock_timestamp() - interval '1 second',
                pending_indexes = jsonb_set(
                  pending_indexes, '{sync_state,0,leaseUntil}',
                  to_jsonb((clock_timestamp() - interval '1 second')::text))
          WHERE workspace_id = $1 AND installation_id = $2`,
        [scope.workspaceId, scope.installationId],
      );
    };
    await expire();

    expect(await repository.listAbandonedIndexRebuilds(50)).toContainEqual({
      workspaceId: scope.workspaceId,
      installationId: scope.installationId,
    });
    expect(await repository.cancelAbandonedIndexRebuilds({ scope })).toEqual({ cancelledCount: 1 });

    const state = await database.query<{
      pending_indexes: Record<string, unknown>;
      rebuild_lease_until: Date | null;
    }>(
      `SELECT pending_indexes, rebuild_lease_until FROM app_storage_installation_state
       WHERE workspace_id = $1 AND installation_id = $2`,
      [scope.workspaceId, scope.installationId],
    );
    expect(state[0]?.pending_indexes).toEqual({});
    expect(state[0]?.rebuild_lease_until).toBeNull();

    const entries = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM app_storage_index_entries
       WHERE installation_id = $1 AND index_id = 'by_sequence'`,
      [scope.installationId],
    );
    expect(entries[0]?.count).toBe("0");
  });

  it("refuses a write whose value a pending index cannot hold rather than storing it unindexed", async () => {
    // Skipping the entry would leave a record the rebuilt index never answers
    // about, and the activation that followed would expose a query quietly short
    // of a row. The write is where the record and the bound it fails are both in
    // hand, so it is where the refusal belongs.
    const scope = installation();
    const index = { id: "by_external_id_rebuild", field: "external_id", fieldType: "string" as const };
    const started = await repository.beginIndexRebuild({ scope: scopeOf(scope), index });
    expect(started).toMatchObject({ admitted: true, value: { outcome: "started" } });

    const past = "x".repeat(INDEXED_STRING_BYTE_BOUND + 1);
    expect(
      await service.put({
        ...scope,
        // The record itself is admitted: the collection this release declares has
        // no index on the field, so only the pending one bounds it.
        collection: buildStorageCollection({ indexes: [] }),
        request: { collection: scope.collection.id, key: "long", record: { external_id: past } },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_input" } });

    const stored = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM app_storage_records WHERE installation_id = $1`,
      [scope.installationId],
    );
    expect(stored[0]?.count).toBe("0");
  });
});
