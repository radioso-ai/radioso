import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  onDuplicateKey: "rerun",
  leaseSeconds: 60,
  timeoutSeconds: 50,
});
const EVENT = defineBackgroundJob({
  kind: "test.event",
  payload: z.object({ subjectId: z.string() }),
  onDuplicateKey: "ignore",
});
const KINDS = [{ kind: REFRESH.kind, leaseSeconds: 60 }];
const EVENT_KINDS = [{ kind: EVENT.kind, leaseSeconds: 60 }];

/** Resolves to "pending" if `promise` has not settled after `ms`: proof that it is blocked on a lock. */
const settledWithin = async <T>(promise: Promise<T>, ms: number): Promise<T | "pending"> =>
  Promise.race([promise, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms))]);

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
      claim_token: string | null;
      rerun_requested: boolean;
      dead_at: Date | null;
      payload: unknown;
    }>(
      `SELECT status, attempts, last_error, available_at, lease_expires_at, claim_token, rerun_requested, dead_at, payload
       FROM background_jobs WHERE id = $1`,
      [id],
    ))[0];

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

  it("folds a duplicate key into a live job, and accepts the key again once that job is gone", async () => {
    const id = await insert("s1", { idempotencyKey: "s1" });
    expect(await repository.insert(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" })))
      .toEqual({ inserted: false });

    const claim = await repository.claimNext({ kinds: KINDS });
    expect(claim?.id).toBe(id);
    // The same key under another kind is unrelated work.
    expect((await repository.insert(backgroundJobRequest(EVENT, { subjectId: "s1" }, { idempotencyKey: "s1" }))).inserted)
      .toBe(true);

    expect(await repository.complete(claim!)).toBe("deleted");
    expect((await repository.insert(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" }))).inserted)
      .toBe(true);
  });

  it("lets a dead-lettered key be enqueued again", async () => {
    await insert("s1", { idempotencyKey: "s1" });
    const claim = await repository.claimNext({ kinds: KINDS });
    expect(await repository.deadLetter(claim!, { error: "Error" })).toBe(true);

    expect((await repository.insert(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" }))).inserted)
      .toBe(true);
  });

  it("claims only the requested kinds, oldest due first, and leases the claim under a fresh token", async () => {
    await repository.insert(backgroundJobRequest(EVENT, { subjectId: "other" }, { runAfter: new Date(Date.now() - 120_000) }));
    const older = await insert("older", { runAfter: new Date(Date.now() - 60_000) });
    await insert("newer");

    const claim = await repository.claimNext({ kinds: KINDS });

    expect(claim).toMatchObject({ id: older, kind: REFRESH.kind, attempt: 1, payload: { subjectId: "older" } });
    const stored = await row(older);
    expect(stored).toMatchObject({ status: "running", attempts: 1, claim_token: claim!.token });
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

  it("renews a live claim's lease, and refuses a claim that was taken over", async () => {
    const id = await insert("s1");
    const stale = await repository.claimNext({ kinds: KINDS });
    await database.query("UPDATE background_jobs SET lease_expires_at = now() + interval '5 seconds' WHERE id = $1", [id]);

    expect(await repository.renewLease(stale!, { leaseSeconds: 60 })).toBe(true);
    expect((await row(id)).lease_expires_at!.getTime()).toBeGreaterThan(Date.now() + 50_000);

    await expireLease(id);
    const fresh = await repository.claimNext({ kinds: KINDS });
    expect(fresh).toMatchObject({ id, attempt: 2 });
    expect(await repository.renewLease(stale!, { leaseSeconds: 60 })).toBe(false);
  });

  it("reclaims a job whose lease expired and fences the stale claim out of every write", async () => {
    const id = await insert("s1");
    const stale = await repository.claimNext({ kinds: KINDS });
    expect(await repository.claimNext({ kinds: KINDS })).toBeNull();

    await expireLease(id);
    const fresh = await repository.claimNext({ kinds: KINDS });

    expect(fresh).toMatchObject({ id, attempt: 2 });
    expect(fresh!.token).not.toBe(stale!.token);
    expect(await repository.complete(stale!)).toBe("superseded");
    expect(await repository.retry(stale!, { error: "Error", delaySeconds: 10 })).toBeNull();
    expect(await repository.deadLetter(stale!, { error: "Error" })).toBe(false);
    expect(await row(id)).toMatchObject({ status: "running", attempts: 2, last_error: null, claim_token: fresh!.token });
  });

  it("deletes a completed job", async () => {
    const id = await insert("s1");
    const claim = await repository.claimNext({ kinds: KINDS });

    expect(await repository.complete(claim!)).toBe("deleted");
    expect(await row(id)).toBeUndefined();
  });

  it("returns a retried job to waiting after its delay, keeping the error", async () => {
    const id = await insert("s1");
    const claim = await repository.claimNext({ kinds: KINDS });

    const availableAt = await repository.retry(claim!, { error: "AppError [provider_unavailable]", delaySeconds: 30 });

    expect(availableAt!.getTime()).toBeGreaterThan(Date.now() + 25_000);
    expect(await row(id)).toMatchObject({
      status: "pending",
      attempts: 1,
      last_error: "AppError [provider_unavailable]",
      lease_expires_at: null,
      claim_token: null,
    });
    expect(await repository.claimNext({ kinds: KINDS })).toBeNull();
  });

  it("refuses to store an error longer than a class and a code", async () => {
    await insert("s1");
    const claim = await repository.claimNext({ kinds: KINDS });

    await expect(repository.retry(claim!, { error: "x".repeat(500), delaySeconds: 30 })).rejects.toThrow();
  });

  it("drops a dead-lettered job's payload in the same write, keeping its kind, key, attempts and error", async () => {
    const receipt = await repository.insert(
      backgroundJobRequest(REFRESH, { subjectId: "SENTINEL-visitor-message" }, { idempotencyKey: "key-1" }),
    );
    const claim = await repository.claimNext({ kinds: KINDS });
    expect(claim).toMatchObject({ idempotencyKey: "key-1", payload: { subjectId: "SENTINEL-visitor-message" } });

    expect(await repository.deadLetter(claim!, { error: "Error" })).toBe(true);

    const stored = await database.query<Record<string, unknown>>("SELECT * FROM background_jobs WHERE id = $1", [
      receipt.inserted ? receipt.jobId : "",
    ]);
    expect(stored[0]).toMatchObject({
      kind: "test.refresh",
      idempotency_key: "key-1",
      status: "dead",
      attempts: 1,
      last_error: "Error",
      payload: null,
    });
    expect(JSON.stringify(stored)).not.toContain("SENTINEL");
  });

  it("commits a dead-letter hook's writes with the park, and rolls both back when the hook throws", async () => {
    const id = await insert("s1", { idempotencyKey: "s1" });
    const claim = await repository.claimNext({ kinds: KINDS });
    const markerCount = async () =>
      Number((await database.query<{ count: string }>("SELECT count(*) AS count FROM background_jobs WHERE kind = 'test.event'"))[0].count);

    await expect(repository.deadLetter(claim!, { error: "Error" }, async (transaction) => {
      await repository.insert(backgroundJobRequest(EVENT, { subjectId: "marker" }), transaction);
      throw new Error("hook failed");
    })).rejects.toThrow("hook failed");
    expect(await markerCount()).toBe(0);
    expect(await row(id)).toMatchObject({ status: "running", payload: { subjectId: "s1" } });

    expect(await repository.deadLetter(claim!, { error: "Error" }, async (transaction) => {
      await repository.insert(backgroundJobRequest(EVENT, { subjectId: "marker" }), transaction);
    })).toBe(true);
    expect(await markerCount()).toBe(1);
    expect(await row(id)).toMatchObject({ status: "dead", payload: null });
  });

  it("never runs the hook for a claim that was taken over", async () => {
    const id = await insert("s1");
    const stale = await repository.claimNext({ kinds: KINDS });
    await expireLease(id);
    await repository.claimNext({ kinds: KINDS });
    let hookRan = false;

    expect(await repository.deadLetter(stale!, { error: "Error" }, async () => {
      hookRan = true;
    })).toBe(false);
    expect(hookRan).toBe(false);
  });

  it("refuses a dead job that still holds a payload, or a live job without one", async () => {
    const id = await insert("s1");
    await expect(database.query(
      "UPDATE background_jobs SET status = 'dead', dead_at = now() WHERE id = $1",
      [id],
    )).rejects.toThrow(/background_jobs_dead_has_no_payload/);
    await expect(database.query("UPDATE background_jobs SET payload = NULL WHERE id = $1", [id]))
      .rejects.toThrow(/background_jobs_dead_has_no_payload/);
  });

  it("parks a dead-lettered job with its error until the retention window passes", async () => {
    const dead = await insert("dead");
    const live = await insert("live", { runAfter: new Date(Date.now() + 60_000) });
    const claim = await repository.claimNext({ kinds: KINDS });
    expect(await repository.deadLetter(claim!, { error: "Error" })).toBe(true);
    expect(await row(dead)).toMatchObject({ status: "dead", last_error: "Error" });
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

  describe("a duplicate key that arrives while the job runs", () => {
    it("reruns a level-triggered job when the producer's transaction commits while the run completes", async () => {
      const id = await insert("s1", { idempotencyKey: "s1" });
      const running = await repository.claimNext({ kinds: KINDS });
      let commitProducer!: () => void;
      const producerMayCommit = new Promise<void>((resolve) => {
        commitProducer = resolve;
      });
      let markRerun!: () => void;
      const rerunMarked = new Promise<void>((resolve) => {
        markRerun = resolve;
      });

      // A turn that committed a newer message writes its refresh in its own transaction.
      const producer = database.kysely.transaction().execute(async (trx) => {
        const receipt = await repository.insert(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" }), trx);
        expect(receipt).toEqual({ inserted: false });
        markRerun();
        await producerMayCommit;
      });
      await rerunMarked;

      // The run finishes while the turn is still open: completion waits for the turn's outcome.
      const completing = repository.complete(running!);
      expect(await settledWithin(completing, 300)).toBe("pending");

      commitProducer();
      await producer;
      expect(await completing).toBe("requeued");
      expect(await row(id)).toMatchObject({
        status: "pending",
        attempts: 0,
        rerun_requested: false,
        claim_token: null,
        lease_expires_at: null,
      });
      expect(await repository.claimNext({ kinds: KINDS })).toMatchObject({ id, attempt: 1 });
    });

    it("deletes the job when the producer that asked for a rerun rolls back", async () => {
      const id = await insert("s1", { idempotencyKey: "s1" });
      const running = await repository.claimNext({ kinds: KINDS });

      await expect(database.kysely.transaction().execute(async (trx) => {
        await repository.insert(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" }), trx);
        throw new Error("turn rolled back");
      })).rejects.toThrow("turn rolled back");

      expect(await repository.complete(running!)).toBe("deleted");
      expect(await row(id)).toBeUndefined();
    });

    it("drops a one-shot job's duplicate", async () => {
      const receipt = await repository.insert(backgroundJobRequest(EVENT, { subjectId: "e1" }, { idempotencyKey: "e1" }));
      const running = await repository.claimNext({ kinds: EVENT_KINDS });

      expect(await repository.insert(backgroundJobRequest(EVENT, { subjectId: "e1" }, { idempotencyKey: "e1" })))
        .toEqual({ inserted: false });

      expect(await repository.complete(running!)).toBe("deleted");
      expect(receipt.inserted && await row(receipt.jobId)).toBeUndefined();
    });

    it("keeps a waiting level-triggered job from being claimed until the producer that folded into it commits", async () => {
      const id = await insert("s1", { idempotencyKey: "s1" });
      let commitProducer!: () => void;
      const producerMayCommit = new Promise<void>((resolve) => {
        commitProducer = resolve;
      });
      let folded!: () => void;
      const duplicateFolded = new Promise<void>((resolve) => {
        folded = resolve;
      });
      const producer = database.kysely.transaction().execute(async (trx) => {
        await repository.insert(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" }), trx);
        folded();
        await producerMayCommit;
      });
      await duplicateFolded;

      // A run that started now would read state from before the producer's change.
      expect(await repository.claimNext({ kinds: KINDS })).toBeNull();

      commitProducer();
      await producer;
      expect(await repository.claimNext({ kinds: KINDS })).toMatchObject({ id });
    });
  });
});
