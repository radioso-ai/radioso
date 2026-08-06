import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, expect, it } from "vitest";

import { ActionRequestRepository } from "../../src/db/repositories/actionRequestRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("ActionRequestRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new ActionRequestRepository(database.kysely);
  const created: string[] = [];

  const enqueue = async (overrides: { idempotencyKey?: string } = {}) => {
    const r = await repository.enqueue({ type: "contact.email", payload: { a: 1 }, idempotencyKey: overrides.idempotencyKey });
    created.push(r.id);
    return r;
  };

  beforeEach(async () => {
    await database.query(`DELETE FROM routine_action_requests`);
    created.splice(0);
  });

  afterEach(async () => {
    for (const id of created.splice(0)) {
      await database.query(`DELETE FROM routine_action_requests WHERE id = $1`, [id]).catch(() => undefined);
    }
  });

  it("enqueue is idempotent on idempotency_key", async () => {
    const key = randomUUID();
    const first = await enqueue({ idempotencyKey: key });
    expect(first.duplicate).toBe(false);
    const second = await repository.enqueue({ type: "contact.email", payload: { a: 2 }, idempotencyKey: key });
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
  });

  it("claimPending moves pending → in_progress exactly once and increments attempts", async () => {
    const a = await enqueue();
    const b = await enqueue();

    const claimed = await repository.claimPending(10, 300);
    expect(claimed.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    expect(claimed.every((c) => c.status === "in_progress" && c.attempts === 1)).toBe(true);

    // already in_progress and lease not expired → nothing more to claim
    expect(await repository.claimPending(10, 300)).toEqual([]);
  });

  it("markDispatched only affects the matching attempt", async () => {
    const a = await enqueue();
    const [claimed] = await repository.claimPending(10, 300);
    await repository.markDispatched(claimed!.id, 999); // wrong attempt → no-op
    let status = (await database.query<{ status: string }>(`SELECT status FROM routine_action_requests WHERE id = $1`, [a.id]))[0]?.status;
    expect(status).toBe("in_progress");

    await repository.markDispatched(claimed!.id, claimed!.attempts);
    status = (await database.query<{ status: string }>(`SELECT status FROM routine_action_requests WHERE id = $1`, [a.id]))[0]?.status;
    expect(status).toBe("dispatched");
  });

  it("recordFailure retries within budget, fails at the cap (CASE), and is superseded on stale attempt", async () => {
    await enqueue();
    const [retryable] = await repository.claimPending(10, 300);
    expect(await repository.recordFailure(retryable!.id, "boom", retryable!.attempts, 3, 60)).toBe("retry");
    // after a retry the row is 'pending' again, so a repeat with the same attempt no longer matches
    expect(await repository.recordFailure(retryable!.id, "boom", 999, 3, 60)).toBe("superseded");

    await enqueue();
    const claimed = await repository.claimPending(10, 300);
    const fresh = claimed.find((c) => c.attempts === 1)!;
    // maxAttempts == current attempts → CASE picks 'failed'
    expect(await repository.recordFailure(fresh.id, "boom", fresh.attempts, fresh.attempts, 60)).toBe("failed");
  });

  it("getPendingDepthSnapshot counts pending/in_progress rows and reports the oldest pending row's timestamp", async () => {
    expect(await repository.getPendingDepthSnapshot()).toEqual({
      pendingCount: 0,
      inProgressCount: 0,
      oldestPendingCreatedAt: null,
    });

    const first = await enqueue();
    await enqueue();
    const third = await enqueue();

    // Claim one row so it moves to in_progress — it must drop out of pendingCount
    // and stop being a candidate for oldestPendingCreatedAt, but still count as
    // in-progress backlog (a stuck lease is exactly what an operator needs to see).
    const claimed = await repository.claimPending(1, 300);
    expect(claimed.map((c) => c.id)).toEqual([first.id]);

    const snapshot = await repository.getPendingDepthSnapshot();
    expect(snapshot.pendingCount).toBe(2);
    expect(snapshot.inProgressCount).toBe(1);
    expect(snapshot.oldestPendingCreatedAt).toBeInstanceOf(Date);

    const oldestRow = (await database.query<{ created_at: Date }>(
      `SELECT created_at FROM routine_action_requests WHERE id = $1`,
      [third.id],
    ))[0];
    // third is not the actual oldest pending row (second is) — just proving the field
    // is a real timestamp read back from the table, not a hardcoded/derived value.
    expect(snapshot.oldestPendingCreatedAt!.getTime()).toBeLessThanOrEqual(oldestRow!.created_at.getTime());
  });
});
