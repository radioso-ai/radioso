import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  BackgroundJobRuntime,
  DefaultBackgroundJobQueue,
  NonRetryableBackgroundJobError,
  backgroundJobHandler,
  backgroundJobRequest,
  defineBackgroundJob,
  type BackgroundJobHandlerRegistration,
  type BackgroundJobWakePort,
} from "../../../src/shared/background-jobs/index.js";
import { InMemoryBackgroundJobStore } from "../../support/inMemoryBackgroundJobStore.js";

const START = new Date("2026-10-15T10:00:00.000Z");

const createClock = () => {
  let current = START.getTime();
  return {
    now: () => new Date(current),
    advanceSeconds: (seconds: number) => {
      current += seconds * 1_000;
    },
  };
};

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

const REFRESH = defineBackgroundJob({
  kind: "test.refresh",
  payload: z.object({ subjectId: z.string(), note: z.string().optional() }),
  maxAttempts: 3,
  leaseSeconds: 60,
  retryBaseDelaySeconds: 10,
});

const OTHER = defineBackgroundJob({
  kind: "test.other",
  payload: z.object({ value: z.number() }),
});

const setup = (handlers: (store: InMemoryBackgroundJobStore) => BackgroundJobHandlerRegistration[]) => {
  const clock = createClock();
  const store = new InMemoryBackgroundJobStore(clock);
  const wake: BackgroundJobWakePort & { requestDrain: ReturnType<typeof vi.fn> } = {
    requestDrain: vi.fn(async () => {}),
  };
  const logger = createLogger();
  const metrics = createMetrics();
  const errorReporter = { report: vi.fn(async () => undefined) };
  const queue = new DefaultBackgroundJobQueue({ writer: store, wake, logger, metrics });
  const runtime = new BackgroundJobRuntime({
    store,
    handlers: handlers(store),
    wake,
    logger,
    metrics,
    errorReporter,
    now: clock.now,
  });
  return { clock, store, wake, logger, metrics, errorReporter, queue, runtime };
};

describe("BackgroundJobRuntime", () => {
  it("runs a due job with its parsed payload and deletes it once the handler succeeds", async () => {
    const handled: unknown[] = [];
    const { queue, runtime, store } = setup(() => [
      backgroundJobHandler(REFRESH, async (payload, context) => {
        handled.push({ payload, attempt: context.attempt });
      }),
    ]);
    await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }));

    const result = await runtime.drain({ maxJobs: 5 });

    expect(handled).toEqual([{ payload: { subjectId: "s1" }, attempt: 1 }]);
    expect(result).toEqual({ claimed: 1, completed: 1, retried: 0, deadLettered: 0, superseded: 0 });
    expect(store.rows.size).toBe(0);
  });

  it("returns a failed job to waiting with a doubling backoff and wakes a worker for when it is due", async () => {
    const { clock, queue, runtime, store, wake } = setup(() => [
      backgroundJobHandler(REFRESH, async () => {
        throw new Error("provider unavailable");
      }),
    ]);
    await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }));
    wake.requestDrain.mockClear();

    expect(await runtime.drain({ maxJobs: 5 })).toMatchObject({ claimed: 1, retried: 1 });
    const [row] = [...store.rows.values()];
    expect(row).toMatchObject({ status: "pending", attempts: 1, lastError: "Error: provider unavailable" });
    expect(row.availableAt).toEqual(new Date(START.getTime() + 10_000));
    expect(wake.requestDrain).toHaveBeenCalledWith({ notBefore: row.availableAt });

    // Not due yet: a drain before the backoff elapses finds nothing.
    expect(await runtime.drain({ maxJobs: 5 })).toMatchObject({ claimed: 0 });

    clock.advanceSeconds(10);
    expect(await runtime.drain({ maxJobs: 1 })).toMatchObject({ claimed: 1, retried: 1 });
    expect([...store.rows.values()][0].availableAt).toEqual(new Date(clock.now().getTime() + 20_000));
  });

  it("dead-letters a job on its last attempt and keeps the error for inspection", async () => {
    const { clock, queue, runtime, store, errorReporter } = setup(() => [
      backgroundJobHandler(REFRESH, async () => {
        throw new Error("still failing");
      }),
    ]);
    await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }));

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await runtime.drain({ maxJobs: 1 });
      clock.advanceSeconds(3_600);
    }

    const [row] = [...store.rows.values()];
    expect(row).toMatchObject({ status: "dead", attempts: 3, lastError: "Error: still failing" });
    expect(row.deadAt).not.toBeNull();
    expect(errorReporter.report).toHaveBeenCalledWith(expect.objectContaining({
      errorType: "background_job.dead_lettered",
      metadata: expect.objectContaining({ kind: "test.refresh", attempt: 3 }),
    }));
    // A dead job is never claimed again.
    expect(await runtime.drain({ maxJobs: 5 })).toMatchObject({ claimed: 0 });
  });

  it("dead-letters at once when the handler reports a failure no retry can fix", async () => {
    const { queue, runtime, store } = setup(() => [
      backgroundJobHandler(REFRESH, async () => {
        throw new NonRetryableBackgroundJobError("subject deleted");
      }),
    ]);
    await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }));

    expect(await runtime.drain({ maxJobs: 5 })).toMatchObject({ claimed: 1, deadLettered: 1 });
    expect([...store.rows.values()][0]).toMatchObject({ status: "dead", attempts: 1 });
  });

  it("dead-letters a stored payload that no longer matches its schema without running the handler", async () => {
    const handle = vi.fn(async () => {});
    const { runtime, store } = setup(() => [backgroundJobHandler(REFRESH, handle)]);
    await store.insert({ kind: REFRESH.kind, payload: { subjectId: 42 } });

    expect(await runtime.drain({ maxJobs: 5 })).toMatchObject({ deadLettered: 1 });
    expect(handle).not.toHaveBeenCalled();
    expect([...store.rows.values()][0].lastError).toContain("InvalidBackgroundJobPayloadError");
  });

  it("takes over a job whose lease expired and fences the stale run out of completing it", async () => {
    const clock = createClock();
    const store = new InMemoryBackgroundJobStore(clock);
    const logger = createLogger();
    let releaseStaleRun!: () => void;
    const staleRunBlocked = new Promise<void>((resolve) => {
      releaseStaleRun = resolve;
    });
    const attemptsSeen: number[] = [];
    const handler = backgroundJobHandler(REFRESH, async (_payload, context) => {
      attemptsSeen.push(context.attempt);
      if (context.attempt === 1) {
        await staleRunBlocked;
      }
    });
    const crashedWorker = new BackgroundJobRuntime({ store, handlers: [handler], logger, now: clock.now });
    const survivingWorker = new BackgroundJobRuntime({ store, handlers: [handler], logger, now: clock.now });
    await store.insert(backgroundJobRequest(REFRESH, { subjectId: "s1" }));

    const staleDrain = crashedWorker.drain({ maxJobs: 1 });
    await vi.waitFor(() => expect(attemptsSeen).toEqual([1]));

    // Still leased: nobody else may take it.
    expect(await survivingWorker.drain({ maxJobs: 1 })).toMatchObject({ claimed: 0 });

    clock.advanceSeconds(61);
    // The surviving worker reclaims the job and finishes it; the job is gone.
    expect(await survivingWorker.drain({ maxJobs: 1 })).toMatchObject({ claimed: 1, completed: 1 });
    expect(store.rows.size).toBe(0);

    releaseStaleRun();
    expect(await staleDrain).toMatchObject({ claimed: 1, completed: 0, superseded: 1 });
    expect(attemptsSeen).toEqual([1, 2]);
  });

  it("dead-letters a job whose every lease expired instead of running it past its retry budget", async () => {
    const handle = vi.fn(async () => {});
    const { clock, runtime, store } = setup(() => [backgroundJobHandler(REFRESH, handle)]);
    const receipt = await store.insert(backgroundJobRequest(REFRESH, { subjectId: "s1" }));
    // Three claims whose workers died mid-run, each lease left to expire.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await store.claimNext({ kinds: [{ kind: REFRESH.kind, leaseSeconds: 60 }] });
      clock.advanceSeconds(61);
    }

    expect(await runtime.drain({ maxJobs: 1 })).toMatchObject({ claimed: 1, deadLettered: 1 });
    expect(handle).not.toHaveBeenCalled();
    expect(receipt.inserted && store.rows.get(receipt.jobId)).toMatchObject({ status: "dead", attempts: 4 });
  });

  it("claims only the kinds it has handlers for", async () => {
    const { runtime, store } = setup(() => [backgroundJobHandler(REFRESH, async () => {})]);
    await store.insert(backgroundJobRequest(OTHER, { value: 1 }));

    expect(await runtime.drain({ maxJobs: 5 })).toMatchObject({ claimed: 0 });
    expect([...store.rows.values()][0]).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("stops a drain at maxJobs and runs the rest on the next one", async () => {
    const { queue, runtime, store } = setup(() => [backgroundJobHandler(REFRESH, async () => {})]);
    for (const subjectId of ["a", "b", "c"]) {
      await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId }));
    }

    expect(await runtime.drain({ maxJobs: 2 })).toMatchObject({ claimed: 2, completed: 2 });
    expect(store.rows.size).toBe(1);
    expect(await runtime.drain({ maxJobs: 2 })).toMatchObject({ claimed: 1, completed: 1 });
  });

  it("refuses two handlers for the same kind", () => {
    const clock = createClock();
    expect(() => new BackgroundJobRuntime({
      store: new InMemoryBackgroundJobStore(clock),
      handlers: [backgroundJobHandler(REFRESH, async () => {}), backgroundJobHandler(REFRESH, async () => {})],
      logger: createLogger(),
    })).toThrow(/test\.refresh/);
  });

  it("records kind, attempt, outcome and latency, and never the payload", async () => {
    const { clock, queue, runtime, logger, metrics } = setup(() => [
      backgroundJobHandler(REFRESH, async () => {
        throw new Error("boom");
      }),
    ]);
    await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1", note: "visitor said something private" }));
    clock.advanceSeconds(2);

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
    vi.useFakeTimers();
    try {
      const clock = createClock();
      const store = new InMemoryBackgroundJobStore(clock);
      let finishRun!: () => void;
      const runFinished = new Promise<void>((resolve) => {
        finishRun = resolve;
      });
      const started = vi.fn();
      const runtime = new BackgroundJobRuntime({
        store,
        handlers: [backgroundJobHandler(REFRESH, async () => {
          started();
          await runFinished;
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

      finishRun();
      await stopping;
      expect(store.rows.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DefaultBackgroundJobQueue", () => {
  it("coalesces enqueues with the same key while the job waits, and wakes only for the first", async () => {
    const { queue, store, wake } = setup(() => []);

    const first = await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" }));
    const second = await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" }));

    expect(first.inserted).toBe(true);
    expect(second).toEqual({ inserted: false });
    expect(store.rows.size).toBe(1);
    expect(wake.requestDrain).toHaveBeenCalledOnce();
  });

  it("enqueues the same key again once the earlier job has completed", async () => {
    const { queue, runtime, store } = setup(() => [backgroundJobHandler(REFRESH, async () => {})]);
    await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" }));
    await runtime.drain({ maxJobs: 1 });

    const again = await queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "s1" }, { idempotencyKey: "s1" }));

    expect(again.inserted).toBe(true);
    expect(store.rows.size).toBe(1);
  });

  it("rejects a payload that does not match the kind's schema before anything is written", async () => {
    const { store } = setup(() => []);

    expect(() => backgroundJobRequest(REFRESH, { subjectId: 7 } as never)).toThrow();
    expect(store.rows.size).toBe(0);
  });

  it("never fails the enqueue when the wake is lost, and says so without the payload", async () => {
    const { store, logger, metrics } = setup(() => []);
    const queue = new DefaultBackgroundJobQueue({
      writer: store,
      wake: { requestDrain: vi.fn(async () => { throw new Error("cloud tasks down"); }) },
      logger,
      metrics,
    });

    await expect(queue.enqueue(backgroundJobRequest(REFRESH, { subjectId: "secret-subject" }))).resolves.toMatchObject({ inserted: true });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ errorType: "Error" }), expect.any(String));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret-subject");
    expect(metrics.incrementCounter).toHaveBeenCalledWith("background_job_wakes_total", expect.objectContaining({
      labels: { result: "failed" },
    }));
  });
});
