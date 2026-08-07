import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { FacetExtractionJobRepository } from "../../../src/db/repositories/facetExtractionJobRepository.js";
import type { FacetExtractionJob } from "../../../src/modules/facets/contracts.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();
const claimableNow = () => new Date(Date.now() + 1_000);

describeIntegration("FacetExtractionJobRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new FacetExtractionJobRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const conversationId = randomUUID();

  const createMessage = async (): Promise<string> => {
    const messageId = randomUUID();
    await database.query(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content)
       VALUES ($1, $2, $3, 'user', 'facet job test message')`,
      [messageId, conversationId, workspaceId],
    );
    return messageId;
  };

  const seed = async (count: number): Promise<string[]> => {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const result = await repository.enqueue({ messageId: await createMessage(), workspaceId });
      ids.push(result.id);
    }
    return ids;
  };

  const readRow = async (jobId: string) => {
    const rows = await database.query<{
      status: string;
      attempt_count: number;
      claimed_at: Date | null;
      scheduled_at: Date;
      last_error: string | null;
    }>(
      `SELECT status, attempt_count, claimed_at, scheduled_at, last_error
       FROM facet_extraction_jobs WHERE id = $1`,
      [jobId],
    );
    return rows[0]!;
  };

  beforeAll(async () => {
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [accountId, "Facet Job Repository Test", `facet-job-repo-${accountId}@example.com`, "hash"],
    );
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)",
      [workspaceId, accountId, "Facet Job Repository Workspace", `facet-job-repo-${workspaceId}`],
    );
    await database.query(
      "INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)",
      [conversationId, workspaceId],
    );
  });

  beforeEach(async () => {
    await database.query(`DELETE FROM facet_extraction_jobs`);
    await database.query(`DELETE FROM messages WHERE workspace_id = $1`, [workspaceId]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM facet_extraction_jobs`).catch(() => undefined);
    await database.query(`DELETE FROM messages WHERE workspace_id = $1`, [workspaceId]).catch(() => undefined);
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("enqueue is idempotent for the same message_id", async () => {
    const messageId = await createMessage();

    const first = await repository.enqueue({ messageId, workspaceId });
    const second = await repository.enqueue({ messageId, workspaceId });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    const rows = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM facet_extraction_jobs WHERE message_id = $1`,
      [messageId],
    );
    expect(rows[0]!.count).toBe("1");
  });

  it("enqueue does not resurrect a terminal job for the same message", async () => {
    const messageId = await createMessage();
    const first = await repository.enqueue({ messageId, workspaceId });
    const [claimed] = await repository.claimBatch(10, claimableNow());
    await repository.markCompleted(claimed!);

    const second = await repository.enqueue({ messageId, workspaceId });

    expect(second.created).toBe(false);
    expect((await readRow(first.id)).status).toBe("completed");
  });

  it("enqueue can restart a terminal job when a current-facet backfill asks for it", async () => {
    const messageId = await createMessage();
    const first = await repository.enqueue({ messageId, workspaceId });
    const [claimed] = await repository.claimBatch(10, claimableNow());
    await repository.markCompleted(claimed!);

    const second = await repository.enqueue({ messageId, workspaceId, restartTerminal: true });

    expect(second).toEqual({ id: first.id, created: false });
    const row = await readRow(first.id);
    expect(row.status).toBe("queued");
    expect(row.attempt_count).toBe(0);
    expect(row.claimed_at).toBeNull();
  });

  it("claimBatch claims due queued rows and marks them processing", async () => {
    const ids = await seed(2);

    const claimed = await repository.claimBatch(10, claimableNow());

    expect(claimed.map((job) => job.id).sort()).toEqual([...ids].sort());
    expect(claimed.every((job) => job.status === "processing")).toBe(true);
    expect(claimed.every((job) => job.attemptCount === 1)).toBe(true);
    expect(claimed.every((job) => job.claimedAt !== null)).toBe(true);
    expect(claimed.every((job) => job.workspaceId === workspaceId)).toBe(true);

    // Already processing -> nothing left to claim.
    expect(await repository.claimBatch(10, claimableNow())).toEqual([]);
  });

  it("claimBatch honours the batch limit and skips rows scheduled in the future", async () => {
    const [future] = await seed(1);
    const [futureClaim] = await repository.claimBatch(10, claimableNow());
    await repository.markFailed(futureClaim!, "transient", new Date(Date.now() + 60_000));
    await seed(3);

    const claimed = await repository.claimBatch(2, claimableNow());

    expect(claimed).toHaveLength(2);
    expect(claimed.some((job) => job.id === future)).toBe(false);

    const remaining = await repository.claimBatch(10, claimableNow());
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).not.toBe(future);
  });

  it("concurrent claimBatch calls never claim the same row twice", async () => {
    const ids = await seed(20);

    const [first, second] = await Promise.all([
      repository.claimBatch(10, claimableNow()),
      repository.claimBatch(10, claimableNow()),
    ]);

    const claimedIds = [...first!, ...second!].map((job) => job.id);
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    expect(claimedIds.sort()).toEqual([...ids].sort());
  });

  it("claimBatch skips rows locked by another in-flight transaction (FOR UPDATE SKIP LOCKED)", async () => {
    const ids = await seed(6);

    let releaseHeldTransaction!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseHeldTransaction = resolve;
    });
    let insideClaim: FacetExtractionJob[] = [];

    // Hold the claim's row locks open in one transaction while a second claim runs.
    const heldTransaction = database.kysely.transaction().execute(async (trx) => {
      insideClaim = await new FacetExtractionJobRepository(trx).claimBatch(3, claimableNow());
      await gate;
    });

    try {
      await vi.waitFor(() => {
        expect(insideClaim).toHaveLength(3);
      });

      // Without SKIP LOCKED this claim would block on the held locks until the gate opens.
      const outsideClaim = await Promise.race([
        repository.claimBatch(3, claimableNow()),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("claimBatch blocked on locked rows")), 5_000),
        ),
      ]);

      const insideIds = insideClaim.map((job) => job.id);
      const outsideIds = outsideClaim.map((job) => job.id);
      expect(outsideIds).toHaveLength(3);
      expect(insideIds.some((id) => outsideIds.includes(id))).toBe(false);
      expect([...insideIds, ...outsideIds].sort()).toEqual([...ids].sort());
    } finally {
      releaseHeldTransaction();
      await heldTransaction;
    }
  });

  it("markFailed with a next schedule returns the row to the queue for a later attempt", async () => {
    const [id] = await seed(1);
    const nextScheduledAt = new Date(Date.now() + 30_000);

    const [claimed] = await repository.claimBatch(10, claimableNow());

    await repository.markFailed(claimed!, "provider timeout", nextScheduledAt);

    const row = await readRow(id!);
    expect(row.status).toBe("queued");
    expect(row.claimed_at).toBeNull();
    expect(row.last_error).toBe("provider timeout");
    expect(new Date(row.scheduled_at).getTime()).toBe(nextScheduledAt.getTime());
    expect(await repository.claimBatch(10, claimableNow())).toEqual([]);
  });

  it("markFailed without a next schedule is terminal", async () => {
    const [id] = await seed(1);
    const [claimed] = await repository.claimBatch(10, claimableNow());

    await repository.markFailed(claimed!, "invalid request", null);

    const row = await readRow(id!);
    expect(row.status).toBe("failed");
    expect(row.claimed_at).toBeNull();
    expect(row.last_error).toBe("invalid request");
    expect(await repository.claimBatch(10, claimableNow())).toEqual([]);
  });

  it("markCompleted and markSkipped are terminal", async () => {
    const [completedId, skippedId] = await seed(2);
    const [completed, skippedClaim] = await repository.claimBatch(10, claimableNow());

    await repository.markCompleted(completed!);
    await repository.markSkipped(skippedClaim!, "message_deleted");

    expect((await readRow(completedId!)).status).toBe("completed");
    const skippedRow = await readRow(skippedId!);
    expect(skippedRow.status).toBe("skipped");
    expect(skippedRow.last_error).toBe("message_deleted");
    expect(await repository.claimBatch(10, claimableNow())).toEqual([]);
  });

  it("markCompleted clears a stale retry error", async () => {
    const [id] = await seed(1);
    const [firstClaim] = await repository.claimBatch(10, claimableNow());
    await repository.markFailed(firstClaim!, "provider timeout", new Date(Date.now() - 1_000));
    const [secondClaim] = await repository.claimBatch(10, claimableNow());

    await repository.markCompleted(secondClaim!);

    const row = await readRow(id!);
    expect(row.status).toBe("completed");
    expect(row.last_error).toBeNull();
  });

  it("releaseExpiredClaims returns abandoned processing rows to the queue", async () => {
    const [id] = await seed(1);
    await repository.claimBatch(10, claimableNow());

    // Nothing to release while the lease is fresh.
    expect(await repository.releaseExpiredClaims({
      claimedAtOrBefore: new Date(Date.now() - 60_000),
      maxAttempts: 3,
    })).toBe(0);

    const released = await repository.releaseExpiredClaims({
      claimedAtOrBefore: new Date(Date.now() + 60_000),
      maxAttempts: 3,
    });

    expect(released).toBe(1);
    const row = await readRow(id!);
    expect(row.status).toBe("queued");
    expect(row.claimed_at).toBeNull();
    expect(row.attempt_count).toBe(1);
    expect((await repository.claimBatch(10, claimableNow()))[0]!.attemptCount).toBe(2);
  });

  it("ignores terminal updates from an expired claim after the row is reclaimed", async () => {
    const [id] = await seed(1);
    const claimedAt = claimableNow();
    const [staleClaim] = await repository.claimBatch(10, claimedAt);
    await repository.releaseExpiredClaims({
      claimedAtOrBefore: new Date(claimedAt.getTime() + 10 * 60_000),
      maxAttempts: 3,
    });
    const [freshClaim] = await repository.claimBatch(10, new Date(claimedAt.getTime() + 11 * 60_000));

    expect(await repository.markCompleted(staleClaim!)).toBe(false);
    expect(await repository.markCompleted(freshClaim!)).toBe(true);

    const row = await readRow(id!);
    expect(row.status).toBe("completed");
    expect(row.attempt_count).toBe(2);
  });

  it("terminally fails expired claims once the attempt budget is exhausted", async () => {
    const [id] = await seed(1);
    const claimedAt = claimableNow();
    await repository.claimBatch(10, claimedAt);

    const changed = await repository.releaseExpiredClaims({
      claimedAtOrBefore: new Date(claimedAt.getTime() + 10 * 60_000),
      maxAttempts: 1,
    });

    expect(changed).toBe(1);
    const row = await readRow(id!);
    expect(row.status).toBe("failed");
    expect(row.claimed_at).toBeNull();
    expect(row.last_error).toBe("claim_expired");
    expect(await repository.claimBatch(10, new Date(claimedAt.getTime() + 11 * 60_000))).toEqual([]);
  });
});
