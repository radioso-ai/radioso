import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { z } from "zod";

import { BackgroundJobRepository } from "../../src/db/repositories/backgroundJobRepository.js";
import { backgroundJobRequest, defineBackgroundJob } from "../../src/shared/background-jobs/index.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const REFRESH = defineBackgroundJob({
  kind: "test.refresh",
  payload: z.object({ subjectId: z.string() }),
  leaseSeconds: 60,
});
const OTHER = defineBackgroundJob({
  kind: "test.other",
  payload: z.object({ subjectId: z.string() }),
});
const KINDS = [{ kind: REFRESH.kind, leaseSeconds: 60 }];

describeIntegration("BackgroundJobRepository (Postgres)", () => {
  const testDatabaseName = `background_jobs_${randomUUID().replaceAll("-", "")}_test`;
  let database: Database;
  let repository: BackgroundJobRepository;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl });
    try {
      await admin.query(`CREATE DATABASE "${testDatabaseName}" TEMPLATE template0`);
    } finally {
      await admin.end();
    }
    const testDatabaseUrl = new URL(integrationDatabaseUrl);
    testDatabaseUrl.pathname = `/${testDatabaseName}`;
    testDatabaseUrl.searchParams.delete("options");
    database = new Database(testDatabaseUrl.toString());
    await runAllTestMigrations(database);
    repository = new BackgroundJobRepository(database.kysely);
  }, 30_000);

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${testDatabaseName}" WITH (FORCE)`);
    } finally {
      await admin.end().catch(() => undefined);
    }
  }, 30_000);

  beforeEach(async () => {
    await database.query("DELETE FROM background_jobs");
  });

  const row = async (id: string) =>
    (await database.query<{
      status: string;
      attempts: number;
      last_error: string | null;
      available_at: Date;
      lease_expires_at: Date | null;
      dead_at: Date | null;
      payload: unknown;
    }>("SELECT status, attempts, last_error, available_at, lease_expires_at, dead_at, payload FROM background_jobs WHERE id = $1", [id]))[0];

  const jobCount = async () =>
    Number((await database.query<{ count: string }>("SELECT count(*) AS count FROM background_jobs"))[0].count);

  const expireLease = (id: string) =>
    database.query("UPDATE background_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [id]);

  const insert = async (subjectId: string, options: { idempotencyKey?: string; runAfter?: Date } = {}) => {
    const receipt = await repository.insert(backgroundJobRequest(REFRESH, { subjectId }, options));
    if (!receipt.inserted) throw new Error("expected an insert");
    return receipt.jobId;
  };

  it("stores the payload and leaves the job waiting until it is due", async () => {
    const future = new Date(Date.now() + 60_000);
    const id = await insert("s1", { runAfter: future });

    expect(await row(id)).toMatchObject({ status: "pending", attempts: 0, payload: { subjectId: "s1" } });
    expect(await repository.claimNext({ kinds: KINDS })).toBeNull();
  });

  it("adds nothing for a key whose job is waiting or running, and accepts it again once that job is gone", async () => {
    const id = await insert("s1", { idempotencyKey: "s1" });
    expect(await repository.insert(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" })))
      .toEqual({ inserted: false });

    const claim = await repository.claimNext({ kinds: KINDS });
    expect(claim?.id).toBe(id);
    expect(await repository.insert(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" })))
      .toEqual({ inserted: false });

    // The same key under another kind is unrelated work.
    expect((await repository.insert(backgroundJobRequest(OTHER, { subjectId: "s1" }, { idempotencyKey: "s1" }))).inserted)
      .toBe(true);

    expect(await repository.complete(claim!)).toBe(true);
    expect((await repository.insert(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" }))).inserted)
      .toBe(true);
  });

  it("lets a dead-lettered key be enqueued again", async () => {
    await insert("s1", { idempotencyKey: "s1" });
    const claim = await repository.claimNext({ kinds: KINDS });
    expect(await repository.deadLetter(claim!, { error: "Error: gone" })).toBe(true);

    expect((await repository.insert(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" }))).inserted)
      .toBe(true);
  });

  it("claims only the requested kinds, oldest due first, and leases the claim", async () => {
    await repository.insert(backgroundJobRequest(OTHER, { subjectId: "other" }, { runAfter: new Date(Date.now() - 120_000) }));
    const older = await insert("older", { runAfter: new Date(Date.now() - 60_000) });
    await insert("newer");

    const claim = await repository.claimNext({ kinds: KINDS });

    expect(claim).toMatchObject({ id: older, kind: REFRESH.kind, attempt: 1, payload: { subjectId: "older" } });
    const stored = await row(older);
    expect(stored).toMatchObject({ status: "running", attempts: 1 });
    expect(stored.lease_expires_at!.getTime()).toBeGreaterThan(Date.now() + 50_000);
  });

  it("never hands the same job to two concurrent claimers", async () => {
    const ids = await Promise.all(Array.from({ length: 20 }, (_, index) => insert(`s${index}`)));

    const claims = await Promise.all(Array.from({ length: 30 }, () => repository.claimNext({ kinds: KINDS })));

    const claimedIds = claims.flatMap((claim) => (claim ? [claim.id] : []));
    expect(claimedIds).toHaveLength(20);
    expect(new Set(claimedIds)).toEqual(new Set(ids));
  });

  it("skips a job another transaction holds locked instead of waiting for it", async () => {
    const locked = await insert("locked", { runAfter: new Date(Date.now() - 60_000) });
    const free = await insert("free");
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM background_jobs WHERE id = $1 FOR UPDATE", [locked]);

      const claim = await repository.claimNext({ kinds: KINDS });

      expect(claim?.id).toBe(free);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("reclaims a job whose lease expired and fences the stale claim out of every write", async () => {
    const id = await insert("s1");
    const stale = await repository.claimNext({ kinds: KINDS });
    expect(await repository.claimNext({ kinds: KINDS })).toBeNull();

    await expireLease(id);
    const fresh = await repository.claimNext({ kinds: KINDS });

    expect(fresh).toMatchObject({ id, attempt: 2 });
    expect(await repository.complete(stale!)).toBe(false);
    expect(await repository.retry(stale!, { error: "Error: stale", delaySeconds: 10 })).toBeNull();
    expect(await repository.deadLetter(stale!, { error: "Error: stale" })).toBe(false);
    expect(await row(id)).toMatchObject({ status: "running", attempts: 2, last_error: null });
  });

  it("deletes a completed job", async () => {
    const id = await insert("s1");
    const claim = await repository.claimNext({ kinds: KINDS });

    expect(await repository.complete(claim!)).toBe(true);
    expect(await row(id)).toBeUndefined();
  });

  it("returns a retried job to waiting after its delay, keeping the error", async () => {
    const id = await insert("s1");
    const claim = await repository.claimNext({ kinds: KINDS });

    const availableAt = await repository.retry(claim!, { error: "Error: provider unavailable", delaySeconds: 30 });

    expect(availableAt!.getTime()).toBeGreaterThan(Date.now() + 25_000);
    expect(await row(id)).toMatchObject({ status: "pending", attempts: 1, last_error: "Error: provider unavailable", lease_expires_at: null });
    expect(await repository.claimNext({ kinds: KINDS })).toBeNull();
  });

  it("parks a dead-lettered job with its error until the retention window passes", async () => {
    const dead = await insert("dead");
    const live = await insert("live", { runAfter: new Date(Date.now() + 60_000) });
    const claim = await repository.claimNext({ kinds: KINDS });
    expect(await repository.deadLetter(claim!, { error: "Error: still failing" })).toBe(true);
    expect(await row(dead)).toMatchObject({ status: "dead", last_error: "Error: still failing" });
    expect(await repository.claimNext({ kinds: KINDS })).toBeNull();

    expect(await repository.deleteBefore({ cutoff: new Date(Date.now() - 60_000), limit: 10 })).toBe(0);
    expect(await repository.deleteBefore({ cutoff: new Date(Date.now() + 1_000), limit: 10 })).toBe(1);
    expect(await row(dead)).toBeUndefined();
    expect(await row(live)).toMatchObject({ status: "pending" });
  });

  it("writes inside a caller's transaction and disappears with its rollback", async () => {
    await expect(database.kysely.transaction().execute(async (trx) => {
      await repository.insert(backgroundJobRequest(REFRESH, { subjectId: "s1" }), trx);
      throw new Error("turn rolled back");
    })).rejects.toThrow("turn rolled back");
    expect(await jobCount()).toBe(0);

    await database.kysely.transaction().execute(async (trx) => {
      await repository.insert(backgroundJobRequest(REFRESH, { subjectId: "s1" }), trx);
    });
    expect(await jobCount()).toBe(1);
  });
});
