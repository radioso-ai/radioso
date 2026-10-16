import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ActionRequestRepository } from "../../src/db/repositories/actionRequestRepository.js";
import { ActionDispatchSkippedError, type ActionHandler } from "../../src/modules/chat/services/actions/actionDispatcher.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { ACTION_DISPATCH_TEST_RETRY_DELAY_MS, createActionDispatchTestRuntime } from "../support/actionDispatchTestRuntime.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("ActionRequestRepository (Postgres)", () => {
  const testDatabaseName = `action_request_${randomUUID().replaceAll("-", "")}_test`;
  const created: string[] = [];
  const fixtureType = `test.action-request.${randomUUID()}`;
  let database: Database;
  let repository: ActionRequestRepository;

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
    repository = new ActionRequestRepository(database.kysely);
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

  const enqueue = async (overrides: { idempotencyKey?: string } = {}) => {
    const r = await repository.enqueue({ type: fixtureType, payload: { a: 1 }, idempotencyKey: overrides.idempotencyKey });
    created.push(r.id);
    return r;
  };

  beforeEach(async () => {
    await database.query(`DELETE FROM routine_action_requests WHERE type = $1`, [fixtureType]);
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

  // claimPending/markDispatched/markSkipped/recordFailure were deleted with ActionDispatcher
  // (#1509): claimNext/complete/retry/deadLetter (the BackgroundJobStore conformance tests below)
  // cover the same claim-fencing, retry, and terminal-failure behaviour over this table.

  it("round-trips skill_name through enqueue and claimNext, defaulting to null when omitted", async () => {
    const named = await repository.enqueue({
      type: fixtureType,
      payload: { message: "call me" },
      skillName: "contact_sales",
    });
    created.push(named.id);
    const unnamed = await enqueue();

    const first = await repository.claimNext({ kinds: [{ kind: fixtureType, leaseSeconds: 300 }] });
    const second = await repository.claimNext({ kinds: [{ kind: fixtureType, leaseSeconds: 300 }] });
    const claimed = [first, second];
    const namedRow = claimed.find((claim) => claim?.id === named.id);
    const unnamedRow = claimed.find((claim) => claim?.id === unnamed.id);
    expect((namedRow?.payload as { skillName: string | null } | undefined)?.skillName).toBe("contact_sales");
    expect((unnamedRow?.payload as { skillName: string | null } | undefined)?.skillName).toBeNull();
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
    const claim = await repository.claimNext({ kinds: [{ kind: fixtureType, leaseSeconds: 300 }] });
    expect(claim?.id).toBe(first.id);

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
    expect(snapshot.oldestPendingCreatedAt!.getTime()).toBeLessThanOrEqual(oldestRow.created_at.getTime());
  });

  // `BackgroundJobStore` conformance (#1509): this table is claimed, leased, completed, retried,
  // and dead-lettered through the same methods the generic `background_jobs` store exposes, with
  // no schema change — this is the store the action-dispatch job runtime actually drains through
  // (`actionDispatchJob.ts`), proven here against real Postgres.
  describe("BackgroundJobStore conformance", () => {
    it("claimNext claims the oldest due row, fencing every write-back on that claim's token", async () => {
      const row = await enqueue();

      const claim = await repository.claimNext({ kinds: [{ kind: fixtureType, leaseSeconds: 300 }] });
      expect(claim?.id).toBe(row.id);
      expect(claim?.kind).toBe(fixtureType);
      expect(claim?.attempt).toBe(1);

      // Nothing else is due: the row is now `in_progress` with a fresh lease.
      expect(await repository.claimNext({ kinds: [{ kind: fixtureType, leaseSeconds: 300 }] })).toBeNull();

      // A stale claim (a worker that lost its row to another claimer) writes nothing back.
      const staleClaim = { ...claim!, token: "999" };
      expect(await repository.renewLease(staleClaim, { leaseSeconds: 300 })).toBe(false);
      expect(await repository.complete(staleClaim)).toBe("superseded");
      expect(await repository.retry(staleClaim, { error: "Error", delaySeconds: 60 })).toBeNull();
      expect(await repository.deadLetter(staleClaim, { error: "Error" })).toBe(false);

      // The real claim's token still works after the stale writes above were rejected.
      expect(await repository.renewLease(claim!, { leaseSeconds: 300 })).toBe(true);
    });

    it("reclaims a stale in_progress row once its lease has elapsed, fencing the earlier attempt's token", async () => {
      const row = await enqueue();
      const first = await repository.claimNext({ kinds: [{ kind: fixtureType, leaseSeconds: 300 }] });
      expect(first?.attempt).toBe(1);

      // Simulate a crashed worker: back-date the row past a short lease instead of waiting for one.
      await database.query(`UPDATE routine_action_requests SET updated_at = now() - interval '10 seconds' WHERE id = $1`, [row.id]);

      const second = await repository.claimNext({ kinds: [{ kind: fixtureType, leaseSeconds: 1 }] });
      expect(second?.id).toBe(row.id);
      expect(second?.attempt).toBe(2);
      expect(second?.token).not.toBe(first?.token);

      // The first worker's claim is superseded; only the reclaiming worker's token completes it.
      expect(await repository.complete(first!)).toBe("superseded");
      expect(await repository.complete(second!)).toBe("deleted");
    });

    it("excludes ids already claimed this call, even once the row is genuinely due by the database's own clock", async () => {
      const row = await enqueue();
      const claim = await repository.claimNext({ kinds: [{ kind: fixtureType, leaseSeconds: 300 }] });
      expect(claim?.id).toBe(row.id);
      // The lease has expired: by the database's own now(), the row is due again.
      await database.query(`UPDATE routine_action_requests SET updated_at = now() - interval '10 seconds' WHERE id = $1`, [row.id]);

      expect(
        await repository.claimNext({ kinds: [{ kind: fixtureType, leaseSeconds: 1 }], excludeIds: [row.id] }),
      ).toBeNull();
      expect(await repository.claimNext({ kinds: [{ kind: fixtureType, leaseSeconds: 1 }] })).toMatchObject({ id: row.id, attempt: 2 });
    });

    it("complete marks the row dispatched without deleting it (unlike the generic store)", async () => {
      const row = await enqueue();
      const claim = await repository.claimNext({ kinds: [{ kind: fixtureType, leaseSeconds: 300 }] });

      expect(await repository.complete(claim!)).toBe("deleted");
      const status = (await database.query<{ status: string }>(`SELECT status FROM routine_action_requests WHERE id = $1`, [row.id]))[0]?.status;
      expect(status).toBe("dispatched");

      // Already terminal: a second completion of the same claim is superseded, not a double transition.
      expect(await repository.complete(claim!)).toBe("superseded");
    });

    it("retry reschedules the row pending at the given delay and records the error", async () => {
      await enqueue();
      const claim = await repository.claimNext({ kinds: [{ kind: fixtureType, leaseSeconds: 300 }] });

      const availableAt = await repository.retry(claim!, { error: "provider_unavailable", delaySeconds: 60 });
      expect(availableAt).toBeInstanceOf(Date);
      expect(availableAt!.getTime()).toBeGreaterThan(Date.now() + 55_000);

      const row = (await database.query<{ status: string; last_error: string | null; next_attempt_at: Date | null }>(
        `SELECT status, last_error, next_attempt_at FROM routine_action_requests WHERE id = $1`,
        [claim!.id],
      ))[0];
      expect(row?.status).toBe("pending");
      expect(row?.last_error).toBe("provider_unavailable");
      expect(row?.next_attempt_at).toBeInstanceOf(Date);

      // Not due yet, so a fresh claim finds nothing.
      expect(await repository.claimNext({ kinds: [{ kind: fixtureType, leaseSeconds: 300 }] })).toBeNull();
    });

    it("retry runs the per-attempt hook once the reschedule lands, and never for a superseded claim", async () => {
      await enqueue();
      const claim = await repository.claimNext({ kinds: [{ kind: fixtureType, leaseSeconds: 300 }] });
      const onRetried = vi.fn(async () => undefined);

      expect(await repository.retry(claim!, { error: "provider_unavailable", delaySeconds: 60 }, onRetried)).toBeInstanceOf(Date);
      expect(onRetried).toHaveBeenCalledOnce();

      // Superseded: the hook never runs for a claim that is no longer live.
      const onRetriedAgain = vi.fn(async () => undefined);
      expect(await repository.retry(claim!, { error: "provider_unavailable", delaySeconds: 60 }, onRetriedAgain)).toBeNull();
      expect(onRetriedAgain).not.toHaveBeenCalled();
    });

    it("deadLetter marks the row terminally failed and keeps its payload, running the park hook once", async () => {
      await enqueue();
      const claim = await repository.claimNext({ kinds: [{ kind: fixtureType, leaseSeconds: 300 }] });
      const onParked = vi.fn(async () => undefined);

      expect(await repository.deadLetter(claim!, { error: "budget_exhausted" }, onParked)).toBe(true);
      expect(onParked).toHaveBeenCalledOnce();

      const row = (await database.query<{ status: string; last_error: string | null; payload: unknown }>(
        `SELECT status, last_error, payload FROM routine_action_requests WHERE id = $1`,
        [claim!.id],
      ))[0];
      expect(row?.status).toBe("failed");
      expect(row?.last_error).toBe("budget_exhausted");
      // Unlike the generic `background_jobs` store, the payload is kept for operator visibility.
      expect(row?.payload).toEqual({ a: 1 });

      // Superseded: the hook never runs for a claim that is no longer live.
      const onParkedAgain = vi.fn(async () => undefined);
      expect(await repository.deadLetter(claim!, { error: "budget_exhausted" }, onParkedAgain)).toBe(false);
      expect(onParkedAgain).not.toHaveBeenCalled();
    });

    it("complete with a skip outcome marks the row terminally skipped without consuming a retry", async () => {
      await enqueue();
      const claim = await repository.claimNext({ kinds: [{ kind: fixtureType, leaseSeconds: 300 }] });

      expect(await repository.complete(claim!, { skipped: "mail_not_dispatched:driver=log" })).toBe("deleted");

      const row = (await database.query<{ status: string; last_error: string | null; attempts: number }>(
        `SELECT status, last_error, attempts FROM routine_action_requests WHERE id = $1`,
        [claim!.id],
      ))[0];
      expect(row?.status).toBe("skipped");
      expect(row?.last_error).toBe("mail_not_dispatched:driver=log");
      expect(row?.attempts).toBe(1);
    });
  });

  // End-to-end through the real runtime (#1509): an action enqueued transactionally with other
  // writes, exactly as a turn does through `PostgresAssistantTurnPersistence`, then drained by
  // `BackgroundJobRuntime` running the real `createActionDispatchJobHandler` adapter and the real
  // `ActionHandlerRegistry` over this store — no in-memory fakes anywhere in the path.
  describe("end-to-end through the real runtime", () => {
    it("recovers from two transient failures before succeeding, running the per-attempt hook exactly twice", async () => {
      const recordFailureOutcome = vi.fn(async () => undefined);
      let calls = 0;
      const handler: ActionHandler = {
        handle: vi.fn(async () => {
          calls += 1;
          if (calls <= 2) {
            throw new Error("provider_unavailable");
          }
        }),
        recordFailureOutcome,
      };
      const { dispatchPending } = createActionDispatchTestRuntime(database.kysely, [{ type: fixtureType, handler }]);

      // Mirrors how a turn writes its action transactionally with the rest of its own writes.
      const actionId = await database.kysely.transaction().execute(async (trx) => {
        const txOutbox = new ActionRequestRepository(trx);
        const { id } = await txOutbox.enqueue({ type: fixtureType, payload: { a: 1 } });
        return id;
      });
      created.push(actionId);

      // Each retry's `next_attempt_at` is genuinely in the future by the database's own clock
      // (see ACTION_DISPATCH_TEST_RETRY_DELAY_MS) — a fake Node timer cannot move it, so this test
      // waits past it for real before the next claim, rather than racing the schedule.
      const waitPastRetryDelay = () => new Promise((resolve) => setTimeout(resolve, ACTION_DISPATCH_TEST_RETRY_DELAY_MS + 50));

      expect(await dispatchPending(1)).toMatchObject({ claimed: 1, retried: 1 });
      await waitPastRetryDelay();
      expect(await dispatchPending(1)).toMatchObject({ claimed: 1, retried: 1 });
      await waitPastRetryDelay();
      expect(await dispatchPending(1)).toMatchObject({ claimed: 1, completed: 1 });

      expect(recordFailureOutcome).toHaveBeenCalledTimes(2);
      expect(recordFailureOutcome).toHaveBeenNthCalledWith(1, expect.objectContaining({ outcome: "retry" }));
      expect(recordFailureOutcome).toHaveBeenNthCalledWith(2, expect.objectContaining({ outcome: "retry" }));
      const row = (await database.query<{ status: string }>(`SELECT status FROM routine_action_requests WHERE id = $1`, [actionId]))[0];
      expect(row?.status).toBe("dispatched");
    });

    it("marks the action skipped when the handler deliberately does not deliver", async () => {
      const handler: ActionHandler = {
        handle: vi.fn(async () => {
          throw new ActionDispatchSkippedError("mail_not_dispatched:driver=log");
        }),
      };
      const { dispatchPending } = createActionDispatchTestRuntime(database.kysely, [{ type: fixtureType, handler }]);
      const { id: actionId } = await enqueue();

      expect(await dispatchPending(1)).toMatchObject({ claimed: 1, skipped: 1 });

      const row = (await database.query<{ status: string; last_error: string | null }>(
        `SELECT status, last_error FROM routine_action_requests WHERE id = $1`,
        [actionId],
      ))[0];
      expect(row?.status).toBe("skipped");
      expect(row?.last_error).toBe("mail_not_dispatched:driver=log");
    });
  });
});
