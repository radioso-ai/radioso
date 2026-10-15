import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  BACKGROUND_JOB_DRAIN_BUDGET_SECONDS,
  BACKGROUND_JOB_MAX_TIMEOUT_SECONDS,
  BackgroundJobRuntime,
  DefaultBackgroundJobQueue,
  NonRetryableBackgroundJobError,
  backgroundJobHandler,
  backgroundJobRequest,
  defineBackgroundJob,
  type BackgroundJobHandlerRegistration,
  type BackgroundJobWakePort,
} from "../../../src/shared/background-jobs/index.js";
import { AppError } from "../../../src/shared/domain/errors.js";
import { InMemoryBackgroundJobStore } from "../../support/inMemoryBackgroundJobStore.js";

const START = new Date("2026-10-15T10:00:00.000Z");

// The store reads the same faked clock the runtime's heartbeat and deadline timers run on.
// `vi.setSystemTime` moves that clock without firing timers: a worker that stalls.
const clock = { now: () => new Date(Date.now()) };

const createLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const createMetrics = () => ({
  incrementCounter: vi.fn(),
  observeHistogram: vi.fn(),
});

/** A promise the test resolves by hand: holds a handler mid-run at a known point. */
const barrier = () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, released };
};

const REFRESH = defineBackgroundJob({
  kind: "test.refresh",
  payload: z.object({ subjectId: z.string(), note: z.string().optional() }),
  onDuplicateKey: "rerun",
  maxAttempts: 3,
  leaseSeconds: 60,
  timeoutSeconds: 50,
  retryBaseDelaySeconds: 10,
});

const EVENT = defineBackgroundJob({
  kind: "test.event",
  payload: z.object({ eventId: z.string() }),
  onDuplicateKey: "ignore",
  leaseSeconds: 60,
  timeoutSeconds: 50,
});

const SHORT = defineBackgroundJob({
  kind: "test.short",
  payload: z.object({ value: z.number() }),
  onDuplicateKey: "ignore",
  leaseSeconds: 15,
  timeoutSeconds: 10,
});

const setup = (handlers: BackgroundJobHandlerRegistration[]) => {
  const store = new InMemoryBackgroundJobStore(clock);
  const wake: BackgroundJobWakePort & { requestDrain: ReturnType<typeof vi.fn> } = {
    requestDrain: vi.fn(async () => {}),
  };
  const logger = createLogger();
  const metrics = createMetrics();
  const errorReporter = { report: vi.fn(async () => undefined) };
  const queue = new DefaultBackgroundJobQueue({ writer: store, wake, logger, metrics });
  const runtime = new BackgroundJobRuntime({ store, handlers, wake, logger, metrics, errorReporter, now: clock.now });
  return { store, wake, logger, metrics, errorReporter, queue, runtime };
};

const onlyRow = (store: InMemoryBackgroundJobStore) => {
  const rows = [...store.rows.values()];
  expect(rows).toHaveLength(1);
  return rows[0];
};

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BackgroundJobRuntime", () => {
  it("runs a due job with its parsed payload and deletes it once the handler succeeds", async () => {
    const handled: unknown[] = [];
    const { queue, runtime, store } = setup([
      backgroundJobHandler(REFRESH, async (payload, context) => {
        handled.push({ payload, attempt: context.attempt, aborted: context.signal.aborted });
      }),
    ]);
    await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }));

    const result = await runtime.drain({ maxJobs: 5 });

    expect(handled).toEqual([{ payload: { subjectId: "s1" }, attempt: 1, aborted: false }]);
    expect(result).toEqual({ claimed: 1, completed: 1, requeued: 0, retried: 0, deadLettered: 0, superseded: 0 });
    expect(store.rows.size).toBe(0);
  });

  it("returns a failed job to waiting with a doubling backoff and wakes a worker for when it is due", async () => {
    const { queue, runtime, store, wake } = setup([
      backgroundJobHandler(REFRESH, async () => {
        throw new Error("provider unavailable");
      }),
    ]);
    await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }));
    await vi.advanceTimersByTimeAsync(0);
    wake.requestDrain.mockClear();

    expect(await runtime.drain({ maxJobs: 5 })).toMatchObject({ claimed: 1, retried: 1 });
    const row = onlyRow(store);
    expect(row).toMatchObject({ status: "pending", attempts: 1, lastError: "Error" });
    expect(row.availableAt).toEqual(new Date(START.getTime() + 10_000));
    expect(wake.requestDrain).toHaveBeenCalledWith({ notBefore: row.availableAt });

    // Not due yet: a drain before the backoff elapses finds nothing.
    expect(await runtime.drain({ maxJobs: 5 })).toMatchObject({ claimed: 0 });

    vi.setSystemTime(Date.now() + 10_000);
    expect(await runtime.drain({ maxJobs: 1 })).toMatchObject({ claimed: 1, retried: 1 });
    expect(onlyRow(store).availableAt).toEqual(new Date(Date.now() + 20_000));
  });

  it("dead-letters a job on its last attempt, drops its payload, and reports only its shape", async () => {
    const { queue, runtime, store, errorReporter } = setup([
      backgroundJobHandler(REFRESH, async () => {
        throw new Error("provider echoed SENTINEL-visitor-text");
      }),
    ]);
    await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1", note: "SENTINEL-payload-text" }, { idempotencyKey: "s1" }));

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await runtime.drain({ maxJobs: 1 });
      vi.setSystemTime(Date.now() + 3_600_000);
    }

    const row = onlyRow(store);
    expect(row).toMatchObject({ status: "dead", attempts: 3, lastError: "Error", idempotencyKey: "s1", payload: null });
    expect(row.deadAt).not.toBeNull();
    expect(errorReporter.report).toHaveBeenCalledOnce();
    const [report] = errorReporter.report.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(report).toEqual({
      errorType: "background_job.dead_lettered",
      severity: "error",
      metadata: { kind: "test.refresh", attempt: 3, jobId: row.id, lastError: "Error" },
    });
    expect(JSON.stringify([...store.rows.values()])).not.toContain("SENTINEL");
    // A dead job is never claimed again.
    expect(await runtime.drain({ maxJobs: 5 })).toMatchObject({ claimed: 0 });
  });

  it("dead-letters at once when the handler reports a failure no retry can fix", async () => {
    const { queue, runtime, store } = setup([
      backgroundJobHandler(REFRESH, async () => {
        throw new NonRetryableBackgroundJobError("subject deleted");
      }),
    ]);
    await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }));

    expect(await runtime.drain({ maxJobs: 5 })).toMatchObject({ claimed: 1, deadLettered: 1 });
    expect(onlyRow(store)).toMatchObject({ status: "dead", attempts: 1, lastError: "NonRetryableBackgroundJobError" });
  });

  it("dead-letters a stored payload that no longer matches its schema without running the handler", async () => {
    const handle = vi.fn(async () => {});
    const { runtime, store } = setup([backgroundJobHandler(REFRESH, handle)]);
    await store.insert({ kind: REFRESH.kind, payload: { subjectId: 42 }, onDuplicateKey: "rerun" });

    expect(await runtime.drain({ maxJobs: 5 })).toMatchObject({ deadLettered: 1 });
    expect(handle).not.toHaveBeenCalled();
    expect(onlyRow(store).lastError).toBe("InvalidBackgroundJobPayloadError");
  });

  describe("errors it stores", () => {
    it("keeps only the error's class, never its message, which can carry conversation text or credentials", async () => {
      const { queue, runtime, store } = setup([
        backgroundJobHandler(REFRESH, async () => {
          throw new Error("provider said: Authorization: Bearer sk-live-SECRET; visitor wrote 'my card is 4242'");
        }),
      ]);
      await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }));

      await runtime.drain({ maxJobs: 1 });

      expect(onlyRow(store).lastError).toBe("Error");
    });

    it("adds an application error's code, which is an identifier rather than text", async () => {
      const { queue, runtime, store } = setup([
        backgroundJobHandler(REFRESH, async () => {
          throw new AppError(503, "provider_unavailable", "upstream echoed the prompt: tell me about my order 1234");
        }),
      ]);
      await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }));

      await runtime.drain({ maxJobs: 1 });

      expect(onlyRow(store).lastError).toBe("AppError [provider_unavailable]");
    });

    it("drops a code that is not a plain identifier, and a code on anything but an application error", async () => {
      let thrown = 0;
      const { queue, runtime, store } = setup([
        backgroundJobHandler(REFRESH, async () => {
          thrown += 1;
          throw thrown === 1
            ? new AppError(500, "token sk-live-SECRET", "x")
            : Object.assign(new Error("x"), { code: "SECRET_FROM_A_LIBRARY" });
        }),
      ]);
      await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }));

      await runtime.drain({ maxJobs: 1 });
      expect(onlyRow(store).lastError).toBe("AppError");

      vi.setSystemTime(Date.now() + 10_000);
      await runtime.drain({ maxJobs: 1 });
      expect(onlyRow(store).lastError).toBe("Error");
    });
  });

  describe("leases", () => {
    it("renews a slow handler's lease, so a second worker never re-enters it even after a stall past the first lease", async () => {
      const { store, queue, logger } = setup([]);
      const hold = barrier();
      let entries = 0;
      const handler = backgroundJobHandler(REFRESH, async () => {
        entries += 1;
        await hold.released;
      });
      const first = new BackgroundJobRuntime({ store, handlers: [handler], logger, now: clock.now });
      const second = new BackgroundJobRuntime({ store, handlers: [handler], logger, now: clock.now });
      await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }));

      const running = first.drain({ maxJobs: 1 });
      await vi.advanceTimersByTimeAsync(40_000);
      // Heartbeats at 20 s and 40 s moved the lease to 100 s from the start.
      expect(onlyRow(store).leaseExpiresAt).toEqual(new Date(START.getTime() + 100_000));

      // The worker stalls for 25 s with no timer firing: past the first lease, inside the renewed one.
      vi.setSystemTime(Date.now() + 25_000);
      expect(await second.drain({ maxJobs: 1 })).toMatchObject({ claimed: 0 });

      hold.release();
      expect(await running).toMatchObject({ claimed: 1, completed: 1 });
      expect(entries).toBe(1);
      expect(store.rows.size).toBe(0);
    });

    it("aborts a run whose lease another worker took over, and writes nothing back", async () => {
      const { store, queue, logger } = setup([]);
      const hold = barrier();
      const seen: { attempt: number; abortReason?: string }[] = [];
      const handler = backgroundJobHandler(REFRESH, async (_payload, context) => {
        const entry: { attempt: number; abortReason?: string } = { attempt: context.attempt };
        seen.push(entry);
        context.signal.addEventListener("abort", () => {
          entry.abortReason = (context.signal.reason as Error).name;
        });
        if (context.attempt === 1) {
          await hold.released;
        }
      });
      const stalled = new BackgroundJobRuntime({ store, handlers: [handler], logger, now: clock.now });
      const other = new BackgroundJobRuntime({ store, handlers: [handler], logger, now: clock.now });
      await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }));

      const staleDrain = stalled.drain({ maxJobs: 1 });
      await vi.advanceTimersByTimeAsync(0);
      // A stall longer than the whole lease: no heartbeat fires, the lease expires, another worker takes over.
      vi.setSystemTime(Date.now() + 61_000);
      expect(await other.drain({ maxJobs: 1 })).toMatchObject({ claimed: 1, completed: 1 });

      // The stalled worker's next heartbeat finds its claim gone and aborts the run it still holds.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await staleDrain).toMatchObject({ claimed: 1, completed: 0, superseded: 1 });
      expect(seen).toEqual([{ attempt: 1, abortReason: "BackgroundJobLeaseLostError" }, { attempt: 2 }]);
      expect(store.rows.size).toBe(0);
      hold.release();
    });

    it("abandons a handler that outlives its deadline, aborts it, and schedules a retry", async () => {
      const { store, queue } = setup([]);
      let signal: AbortSignal | undefined;
      const stuck = new BackgroundJobRuntime({
        store,
        handlers: [backgroundJobHandler(REFRESH, async (_payload, context) => {
          signal = context.signal;
          await new Promise(() => {}); // never settles and ignores the signal
        })],
        logger: createLogger(),
        now: clock.now,
      });
      await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }));

      const draining = stuck.drain({ maxJobs: 1 });
      await vi.advanceTimersByTimeAsync(50_000);

      expect(await draining).toMatchObject({ claimed: 1, retried: 1 });
      expect(signal?.aborted).toBe(true);
      expect((signal?.reason as Error).name).toBe("BackgroundJobTimeoutError");
      expect(onlyRow(store)).toMatchObject({ status: "pending", attempts: 1, lastError: "BackgroundJobTimeoutError" });
    });

    it("dead-letters a job whose every lease expired instead of running it past its retry budget", async () => {
      const handle = vi.fn(async () => {});
      const { runtime, store } = setup([backgroundJobHandler(REFRESH, handle)]);
      const receipt = await store.insert(backgroundJobRequest(REFRESH, { subjectId: "s1" }));
      // Three claims whose workers died mid-run, each lease left to expire.
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await store.claimNext({ kinds: [{ kind: REFRESH.kind, leaseSeconds: 60 }] });
        vi.setSystemTime(Date.now() + 61_000);
      }

      expect(await runtime.drain({ maxJobs: 1 })).toMatchObject({ claimed: 1, deadLettered: 1 });
      expect(handle).not.toHaveBeenCalled();
      expect(receipt.inserted && store.rows.get(receipt.jobId)).toMatchObject({
        status: "dead",
        attempts: 4,
        lastError: "BackgroundJobLeaseExpiredError",
      });
    });
  });

  describe("duplicate keys", () => {
    it("reruns a level-triggered job once more when its key is enqueued while it runs", async () => {
      const hold = barrier();
      const runs: number[] = [];
      const { queue, runtime, store, wake } = setup([
        backgroundJobHandler(REFRESH, async () => {
          runs.push(runs.length + 1);
          if (runs.length === 1) {
            await hold.released;
          }
        }),
      ]);
      await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" }));

      const draining = runtime.drain({ maxJobs: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(runs).toEqual([1]);
      // The work this refresh already read is now stale: a newer turn committed.
      expect(await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" })))
        .toEqual({ inserted: false });
      wake.requestDrain.mockClear();

      hold.release();
      expect(await draining).toMatchObject({ claimed: 1, completed: 0, requeued: 1 });
      expect(onlyRow(store)).toMatchObject({ status: "pending", attempts: 0, rerunRequested: false });
      expect(wake.requestDrain).toHaveBeenCalledOnce();

      expect(await runtime.drain({ maxJobs: 1 })).toMatchObject({ claimed: 1, completed: 1 });
      expect(runs).toEqual([1, 2]);
      expect(store.rows.size).toBe(0);
    });

    it("drops a one-shot job's duplicate key while it runs", async () => {
      const hold = barrier();
      const handle = vi.fn(async () => {
        await hold.released;
      });
      const { queue, runtime, store } = setup([backgroundJobHandler(EVENT, handle)]);
      await queue.enqueue(backgroundJobRequest(EVENT, { eventId: "e1" }, { idempotencyKey: "e1" }));

      const draining = runtime.drain({ maxJobs: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(await queue.enqueue(backgroundJobRequest(EVENT, { eventId: "e1" }, { idempotencyKey: "e1" })))
        .toEqual({ inserted: false });

      hold.release();
      expect(await draining).toMatchObject({ completed: 1, requeued: 0 });
      expect(handle).toHaveBeenCalledOnce();
      expect(store.rows.size).toBe(0);
    });

    it("folds a duplicate into a job that has not started yet, in either mode", async () => {
      const { queue, store } = setup([]);

      await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" }));
      await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" }));
      await queue.enqueue(backgroundJobRequest(EVENT, { eventId: "e1" }, { idempotencyKey: "e1" }));
      await queue.enqueue(backgroundJobRequest(EVENT, { eventId: "e1" }, { idempotencyKey: "e1" }));

      expect([...store.rows.values()].map((row) => [row.kind, row.status, row.rerunRequested])).toEqual([
        ["test.refresh", "pending", false],
        ["test.event", "pending", false],
      ]);
    });
  });

  describe("dead-letter hook", () => {
    const deadLetterCalls = () => {
      const calls: { payload: unknown; idempotencyKey: string | null; attempt: number; error: string; hasTransaction: boolean }[] = [];
      const onDeadLetter = vi.fn(async (payload: unknown, context: {
        idempotencyKey: string | null;
        attempt: number;
        error: string;
        transaction: unknown;
      }) => {
        calls.push({
          payload,
          idempotencyKey: context.idempotencyKey,
          attempt: context.attempt,
          error: context.error,
          hasTransaction: context.transaction !== undefined,
        });
      });
      return { calls, onDeadLetter };
    };

    it("runs once with the payload when the last attempt fails", async () => {
      const { calls, onDeadLetter } = deadLetterCalls();
      const { queue, runtime } = setup([
        backgroundJobHandler(REFRESH, async () => {
          throw new Error("still failing");
        }, { onDeadLetter }),
      ]);
      await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" }));

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await runtime.drain({ maxJobs: 1 });
        vi.setSystemTime(Date.now() + 3_600_000);
      }

      expect(calls).toEqual([
        { payload: { subjectId: "s1" }, idempotencyKey: "s1", attempt: 3, error: "Error", hasTransaction: true },
      ]);
    });

    it("runs when the last attempt passes its deadline", async () => {
      const { calls, onDeadLetter } = deadLetterCalls();
      const ONE_SHOT = defineBackgroundJob({
        kind: "test.one_shot",
        payload: z.object({ eventId: z.string() }),
        onDuplicateKey: "ignore",
        maxAttempts: 1,
        leaseSeconds: 60,
        timeoutSeconds: 50,
      });
      const { queue, runtime } = setup([
        backgroundJobHandler(ONE_SHOT, async () => {
          await new Promise(() => {});
        }, { onDeadLetter }),
      ]);
      await queue.enqueue(backgroundJobRequest(ONE_SHOT, { eventId: "e1" }, { idempotencyKey: "e1" }));

      const draining = runtime.drain({ maxJobs: 1 });
      await vi.advanceTimersByTimeAsync(50_000);

      expect(await draining).toMatchObject({ deadLettered: 1 });
      expect(calls).toEqual([
        { payload: { eventId: "e1" }, idempotencyKey: "e1", attempt: 1, error: "BackgroundJobTimeoutError", hasTransaction: true },
      ]);
    });

    it("runs without a payload, but with the key, when the stored payload no longer parses", async () => {
      const { calls, onDeadLetter } = deadLetterCalls();
      const handle = vi.fn(async () => {});
      const { runtime, store } = setup([backgroundJobHandler(REFRESH, handle, { onDeadLetter })]);
      await store.insert({ kind: REFRESH.kind, payload: { subjectId: 42 }, onDuplicateKey: "rerun", idempotencyKey: "s1" });

      await runtime.drain({ maxJobs: 1 });

      expect(handle).not.toHaveBeenCalled();
      expect(calls).toEqual([
        { payload: null, idempotencyKey: "s1", attempt: 1, error: "InvalidBackgroundJobPayloadError", hasTransaction: true },
      ]);
    });

    it("runs when repeated crashes used up the attempts", async () => {
      const { calls, onDeadLetter } = deadLetterCalls();
      const { runtime, store } = setup([backgroundJobHandler(REFRESH, async () => {}, { onDeadLetter })]);
      await store.insert(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" }));
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await store.claimNext({ kinds: [{ kind: REFRESH.kind, leaseSeconds: 60 }] });
        vi.setSystemTime(Date.now() + 61_000);
      }

      await runtime.drain({ maxJobs: 1 });

      expect(calls).toEqual([
        { payload: { subjectId: "s1" }, idempotencyKey: "s1", attempt: 4, error: "BackgroundJobLeaseExpiredError", hasTransaction: true },
      ]);
    });

    it("is not run by an attempt whose claim was taken over, so it runs once", async () => {
      const { calls, onDeadLetter } = deadLetterCalls();
      const { store, queue, logger } = setup([]);
      const LAST_TRY = defineBackgroundJob({
        kind: "test.last_try",
        payload: z.object({ eventId: z.string() }),
        onDuplicateKey: "ignore",
        maxAttempts: 1,
        leaseSeconds: 60,
        timeoutSeconds: 50,
      });
      const hold = barrier();
      const handler = backgroundJobHandler(LAST_TRY, async () => {
        await hold.released;
        throw new Error("failed after its claim was taken over");
      }, { onDeadLetter });
      const stalled = new BackgroundJobRuntime({ store, handlers: [handler], logger, now: clock.now });
      const other = new BackgroundJobRuntime({ store, handlers: [handler], logger, now: clock.now });
      await queue.enqueue(backgroundJobRequest(LAST_TRY, { eventId: "e1" }, { idempotencyKey: "e1" }));

      const staleDrain = stalled.drain({ maxJobs: 1 });
      await vi.advanceTimersByTimeAsync(0);
      vi.setSystemTime(Date.now() + 61_000);
      // The other worker finds the only attempt spent and dead-letters the job.
      expect(await other.drain({ maxJobs: 1 })).toMatchObject({ deadLettered: 1 });

      hold.release();
      expect(await staleDrain).toMatchObject({ deadLettered: 0, superseded: 1 });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ attempt: 2, error: "BackgroundJobLeaseExpiredError" });
    });

    it("still parks the job when the hook fails, and reports the failure by shape only", async () => {
      const { queue, runtime, store, errorReporter } = setup([
        backgroundJobHandler(SHORT, async () => {
          throw new NonRetryableBackgroundJobError("gone");
        }, {
          onDeadLetter: async () => {
            throw new Error("hook failed on SENTINEL-hook-text");
          },
        }),
      ]);
      await queue.enqueue(backgroundJobRequest(SHORT, { value: 1 }));

      expect(await runtime.drain({ maxJobs: 1 })).toMatchObject({ deadLettered: 1 });
      expect(onlyRow(store)).toMatchObject({ status: "dead", payload: null, lastError: "NonRetryableBackgroundJobError" });
      expect(errorReporter.report).toHaveBeenCalledWith({
        errorType: "background_job.dead_letter_hook_failed",
        severity: "error",
        metadata: expect.objectContaining({ kind: "test.short", hookError: "Error" }),
      });
      expect(JSON.stringify(errorReporter.report.mock.calls)).not.toContain("SENTINEL");
    });
  });

  describe("time budget", () => {
    it("leaves a pushed drain room for a kind at the longest deadline, even after time has passed before admission", async () => {
      expect(BACKGROUND_JOB_DRAIN_BUDGET_SECONDS).toBeGreaterThan(BACKGROUND_JOB_MAX_TIMEOUT_SECONDS);
      const LONGEST = defineBackgroundJob({
        kind: "test.longest",
        payload: z.object({ eventId: z.string() }),
        onDuplicateKey: "ignore",
        leaseSeconds: BACKGROUND_JOB_MAX_TIMEOUT_SECONDS + 60,
        timeoutSeconds: BACKGROUND_JOB_MAX_TIMEOUT_SECONDS,
      });
      const { queue, runtime } = setup([backgroundJobHandler(LONGEST, async () => {})]);
      await queue.enqueue(backgroundJobRequest(LONGEST, { eventId: "e1" }));
      // The request arrived 10 s before the drain's first admission check (auth, body parsing, a cold start).
      const startedAt = Date.now() - 10_000;

      expect(await runtime.drain({ maxJobs: 1, budgetMs: BACKGROUND_JOB_DRAIN_BUDGET_SECONDS * 1_000, startedAt }))
        .toMatchObject({ claimed: 1, completed: 1 });
    });

    it("claims a job only while its kind's deadline still fits in the drain's budget", async () => {
      const { queue, runtime, store } = setup([
        backgroundJobHandler(SHORT, async () => {
          await new Promise((resolve) => setTimeout(resolve, 8_000));
        }),
        backgroundJobHandler(REFRESH, async () => {}),
      ]);
      for (const value of [1, 2, 3]) {
        await queue.enqueue(backgroundJobRequest(SHORT, { value }));
      }
      await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }));

      const draining = runtime.drain({ maxJobs: 10, budgetMs: 20_000 });
      await vi.advanceTimersByTimeAsync(20_000);

      // 10 s fits at 0 s and 8 s; at 16 s only 4 s remain. The 50 s kind never fits a 20 s budget.
      expect(await draining).toMatchObject({ claimed: 2, completed: 2 });
      expect([...store.rows.values()].map((row) => row.kind).sort()).toEqual(["test.refresh", "test.short"]);
    });
  });

  it("claims only the kinds it has handlers for", async () => {
    const { runtime, store } = setup([backgroundJobHandler(REFRESH, async () => {})]);
    await store.insert(backgroundJobRequest(SHORT, { value: 1 }));

    expect(await runtime.drain({ maxJobs: 5 })).toMatchObject({ claimed: 0 });
    expect(onlyRow(store)).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("stops a drain at maxJobs and runs the rest on the next one", async () => {
    const { queue, runtime, store } = setup([backgroundJobHandler(REFRESH, async () => {})]);
    for (const subjectId of ["a", "b", "c"]) {
      await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId }));
    }

    expect(await runtime.drain({ maxJobs: 2 })).toMatchObject({ claimed: 2, completed: 2 });
    expect(store.rows.size).toBe(1);
    expect(await runtime.drain({ maxJobs: 2 })).toMatchObject({ claimed: 1, completed: 1 });
  });

  it("refuses two handlers for the same kind", () => {
    expect(() => new BackgroundJobRuntime({
      store: new InMemoryBackgroundJobStore(clock),
      handlers: [backgroundJobHandler(REFRESH, async () => {}), backgroundJobHandler(REFRESH, async () => {})],
      logger: createLogger(),
    })).toThrow(/test\.refresh/);
  });

  it("records kind, attempt, outcome and latency, and never the payload", async () => {
    const { queue, runtime, logger, metrics } = setup([
      backgroundJobHandler(REFRESH, async () => {
        throw new Error("boom");
      }),
    ]);
    await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1", note: "visitor said something private" }));
    vi.setSystemTime(Date.now() + 2_000);

    await runtime.drain({ maxJobs: 1 });

    expect(metrics.incrementCounter).toHaveBeenCalledWith("background_jobs_total", expect.objectContaining({
      labels: { kind: "test.refresh", outcome: "retried" },
    }));
    expect(metrics.observeHistogram).toHaveBeenCalledWith("background_job_wait_ms", expect.objectContaining({
      labels: { kind: "test.refresh" },
      value: 2_000,
    }));
    expect(metrics.observeHistogram).toHaveBeenCalledWith("background_job_run_duration_ms", expect.objectContaining({
      labels: { kind: "test.refresh", outcome: "retried" },
    }));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "test.refresh", attempt: 1, outcome: "retried", errorType: "Error" }),
      expect.any(String),
    );
    const logged = JSON.stringify([
      ...logger.debug.mock.calls,
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ]);
    expect(logged).not.toContain("private");
    expect(logged).not.toContain("s1");
  });

  it("drains on its poll loop until stopped, and stop waits for the run in flight", async () => {
    const store = new InMemoryBackgroundJobStore(clock);
    const hold = barrier();
    const started = vi.fn();
    const runtime = new BackgroundJobRuntime({
      store,
      handlers: [backgroundJobHandler(REFRESH, async () => {
        started();
        await hold.released;
      })],
      logger: createLogger(),
      pollIntervalMs: 1_000,
      now: clock.now,
    });
    await store.insert(backgroundJobRequest(REFRESH, { subjectId: "s1" }));

    runtime.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toHaveBeenCalledOnce();

    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    hold.release();
    await stopping;
    expect(store.rows.size).toBe(0);
  });
});

describe("defineBackgroundJob", () => {
  it("refuses a deadline that does not leave the lease room to fence a stalled run", () => {
    expect(() => defineBackgroundJob({
      kind: "test.bad",
      payload: z.object({}),
      onDuplicateKey: "ignore",
      leaseSeconds: 60,
      timeoutSeconds: 60,
    })).toThrow(/lease/);
  });

  it("refuses a deadline longer than one worker drain can hold", () => {
    expect(() => defineBackgroundJob({
      kind: "test.bad",
      payload: z.object({}),
      onDuplicateKey: "ignore",
      leaseSeconds: 900,
      timeoutSeconds: 600,
    })).toThrow(/drain/);
  });
});

describe("DefaultBackgroundJobQueue", () => {
  it("wakes a worker once for the job it stores, not for a duplicate", async () => {
    const { queue, store, wake } = setup([]);

    const first = await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" }));
    const second = await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(first.inserted).toBe(true);
    expect(second).toEqual({ inserted: false });
    expect(store.rows.size).toBe(1);
    expect(wake.requestDrain).toHaveBeenCalledOnce();
  });

  it("resolves once the job is stored, without waiting on the wake", async () => {
    const store = new InMemoryBackgroundJobStore(clock);
    const wake = { requestDrain: vi.fn(() => new Promise<void>(() => {})) };
    const queue = new DefaultBackgroundJobQueue({ writer: store, wake, logger: createLogger() });

    await expect(queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }))).resolves.toMatchObject({ inserted: true });
    expect(wake.requestDrain).toHaveBeenCalledOnce();
    expect(store.rows.size).toBe(1);
  });

  it("enqueues the same key again once the earlier job has completed", async () => {
    const { queue, runtime, store } = setup([backgroundJobHandler(REFRESH, async () => {})]);
    await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" }));
    await runtime.drain({ maxJobs: 1 });

    const again = await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" }));

    expect(again.inserted).toBe(true);
    expect(store.rows.size).toBe(1);
  });

  it("rejects a payload that does not match the kind's schema before anything is written", () => {
    const { store } = setup([]);

    expect(() => backgroundJobRequest(REFRESH, { subjectId: 7 } as never)).toThrow();
    expect(store.rows.size).toBe(0);
  });

  it("never fails the enqueue when the wake is lost, and says so without the payload", async () => {
    const store = new InMemoryBackgroundJobStore(clock);
    const logger = createLogger();
    const metrics = createMetrics();
    const queue = new DefaultBackgroundJobQueue({
      writer: store,
      wake: { requestDrain: vi.fn(async () => { throw new Error("cloud tasks down"); }) },
      logger,
      metrics,
    });

    await expect(queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "secret-subject" }))).resolves.toMatchObject({ inserted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ errorType: "Error" }), expect.any(String));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret-subject");
    expect(metrics.incrementCounter).toHaveBeenCalledWith("background_job_wakes_total", expect.objectContaining({
      labels: { result: "failed" },
    }));
  });
});
