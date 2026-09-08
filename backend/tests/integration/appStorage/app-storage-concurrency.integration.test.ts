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
 * of them. So each case here holds a lock on its own connection, starts the
 * operation that must queue behind it, and only then releases — which makes the
 * interleaving the assertion rather than something the scheduler might produce.
 */
describeIntegration("Managed App Storage under concurrency (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl, { poolMax: 8 });
  const repository = new AppStorageRepository(database.kysely);
  const service = createAppStorageService({ repository });
  const disposition = createAppStorageDisposition({ repository, audit: silentAudit });

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

  /**
   * Opens a transaction on its own connection and takes the collection's counter
   * row — the first lock every write takes — so anything the test starts next is
   * held at a known point until `release` runs.
   */
  const holdCollectionLock = async (
    scope: Scope,
  ): Promise<{ release: () => Promise<void> }> => {
    const client: PoolClient = await database.pool.connect();
    await client.query("BEGIN");
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
    return {
      release: async (): Promise<void> => {
        await client.query("COMMIT");
        client.release();
      },
    };
  };

  /**
   * Whether an operation is still waiting after a grace period. It is what turns
   * "these ran at the same time" into "this one was held at a known point".
   */
  const PENDING = Symbol("pending");
  const isPending = async (promise: Promise<unknown>): Promise<boolean> => {
    const settled = await Promise.race([
      promise.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), 250)),
    ]);
    return settled === PENDING;
  };

  it("lets exactly one of two writers holding the same version through", async () => {
    const scope = installation();
    const seen = versionOf(await put(scope, "contended", "v1"));

    // Both writers read the same version and both write against it. The counter
    // row serializes them, so the second sees the version the first assigned.
    const [first, second] = await Promise.all([
      put(scope, "contended", "a", seen),
      put(scope, "contended", "b", seen),
    ]);

    const outcomes = [first, second].map((result) => (result.ok ? "stored" : result.error.code));
    expect(outcomes.sort()).toEqual(["stored", "version_conflict"]);
  });

  it("hands the last quota slot to exactly one of two competing writers", async () => {
    const tiny = buildStorageCollection({ id: "last_slot", quotas: { maxRecords: 1, maxRecordBytes: 4096 } });
    const scope = installation(tiny);

    const [first, second] = await Promise.all([put(scope, "one", "one"), put(scope, "two", "two")]);
    const outcomes = [first, second].map((result) => (result.ok ? "stored" : result.error.code));
    expect(outcomes.sort()).toEqual(["quota_exceeded", "stored"]);

    expect(await service.usage(scope)).toMatchObject({ ok: true, value: { recordCount: 1 } });
  });

  it("makes a write queue behind the collection lock rather than read around it", async () => {
    const scope = installation();
    const lock = await holdCollectionLock(scope);

    const blocked = put(scope, "queued", "queued");
    expect(await isPending(blocked)).toBe(true);

    await lock.release();
    expect(await blocked).toMatchObject({ ok: true });
  });

  it("reclaims a record that expires while a write waits, rather than renewing it", async () => {
    const ttl = buildStorageCollection({
      id: "expire_while_blocked",
      quotas: { maxRecords: 1, maxRecordBytes: 4096 },
      retention: { kind: "ttl", seconds: 60 },
    });
    const scope = installation(ttl);
    await put(scope, "first", "first");

    const lock = await holdCollectionLock(scope);
    // The write for a different key needs the only slot, and the record holding it
    // is still live when the write starts.
    const blocked = put(scope, "second", "second");
    expect(await isPending(blocked)).toBe(true);

    await database.query(
      `UPDATE app_storage_records SET expires_at = now() - interval '1 second'
       WHERE workspace_id = $1 AND installation_id = $2 AND record_key = 'first'`,
      [scope.workspaceId, scope.installationId],
    );
    await lock.release();

    // A write that judged liveness from a timestamp read before it queued would
    // still see the first record as live and refuse this one.
    expect(await blocked).toMatchObject({ ok: true });
    expect(await service.usage(scope)).toMatchObject({ ok: true, value: { recordCount: 1 } });
  });

  it("runs the expiry sweep against a collection a write is holding without deadlocking", async () => {
    const ttl = buildStorageCollection({ id: "sweep_race", retention: { kind: "ttl", seconds: 60 } });
    const scope = installation(ttl);
    for (const key of ["a", "b", "c"]) await put(scope, key, key);
    await database.query(
      `UPDATE app_storage_records SET expires_at = now() - interval '1 second'
       WHERE workspace_id = $1 AND installation_id = $2 AND record_key IN ('a', 'b')`,
      [scope.workspaceId, scope.installationId],
    );

    const sweeper = createAppStorageSweeper({ repository, audit: silentAudit, batchSize: 1, maxBatches: 5 });

    // Both approach the counter row before any record row, so the loser waits
    // instead of holding a record lock the winner needs.
    const [swept, written, deleted] = await Promise.all([
      sweeper.runExpirySweep(),
      put(scope, "d", "d"),
      service.delete({ ...scope, request: { collection: "sweep_race", key: "c" } }),
    ]);

    expect(written).toMatchObject({ ok: true });
    expect(deleted).toMatchObject({ ok: true });
    expect(swept.deletedCount).toBeGreaterThanOrEqual(0);

    const remaining = await database.query<{ record_key: string }>(
      `SELECT record_key FROM app_storage_records
       WHERE workspace_id = $1 AND installation_id = $2 AND (expires_at IS NULL OR expires_at > now())
       ORDER BY record_key`,
      [scope.workspaceId, scope.installationId],
    );
    expect(remaining.map((row) => row.record_key)).toEqual(["d"]);
    expect(await service.usage(scope)).toMatchObject({ ok: true, value: { recordCount: 1 } });
  });

  it("holds a write at the fence and refuses it once the revocation commits", async () => {
    const scope = installation();
    await put(scope, "kept", "kept");

    // A disposition in flight: the state row is held exclusively, which is the
    // first lock every runtime operation takes.
    const client: PoolClient = await database.pool.connect();
    await client.query("BEGIN");
    await client.query(
      `SELECT 1 FROM app_storage_installation_state
       WHERE workspace_id = $1 AND installation_id = $2 FOR UPDATE`,
      [scope.workspaceId, scope.installationId],
    );

    const blocked = put(scope, "kept", "changed");
    // A check made before the operation's own transaction would have passed by now.
    expect(await isPending(blocked)).toBe(true);

    await client.query(
      `UPDATE app_storage_installation_state SET access_revoked_at = now()
       WHERE workspace_id = $1 AND installation_id = $2`,
      [scope.workspaceId, scope.installationId],
    );
    await client.query("COMMIT");
    client.release();

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

    const client: PoolClient = await database.pool.connect();
    await client.query("BEGIN");
    await client.query(
      `SELECT 1 FROM app_storage_installation_state
       WHERE workspace_id = $1 AND installation_id = $2 FOR UPDATE`,
      [scope.workspaceId, scope.installationId],
    );

    const blocked = put(scope, "two", "two");
    expect(await isPending(blocked)).toBe(true);

    await client.query(`DELETE FROM app_storage_records WHERE workspace_id = $1 AND installation_id = $2`, [
      scope.workspaceId,
      scope.installationId,
    ]);
    await client.query(
      `DELETE FROM app_storage_collection_usage WHERE workspace_id = $1 AND installation_id = $2`,
      [scope.workspaceId, scope.installationId],
    );
    await client.query(
      `UPDATE app_storage_installation_state SET deleted_at = now()
       WHERE workspace_id = $1 AND installation_id = $2`,
      [scope.workspaceId, scope.installationId],
    );
    await client.query("COMMIT");
    client.release();

    // The tombstone outlives the rows it accounted for, so the write cannot
    // recreate a record under an installation that no longer holds any.
    expect(await blocked).toMatchObject({ ok: false, error: { code: "denied" } });
    const rows = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM app_storage_records WHERE installation_id = $1`,
      [scope.installationId],
    );
    expect(rows[0]?.count).toBe("0");
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
