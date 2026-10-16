import { describe, expect, it, vi } from "vitest";

import {
  BackgroundJobRuntime,
  DefaultBackgroundJobQueue,
  backgroundJobRequest,
  type BackgroundJobWakePort,
} from "../../src/shared/background-jobs/index.js";
import {
  ACTION_DISPATCH_JOB,
  createActionDispatchJobHandler,
  type ActionDispatchPersistedOutcome,
} from "../../src/modules/chat/services/actions/actionDispatchJob.js";
import { ActionDispatchSkippedError, ActionHandlerRegistry, type ActionHandler } from "../../src/modules/chat/services/actions/actionDispatcher.js";
import { InMemoryBackgroundJobStore, type InMemoryBackgroundJobRow } from "../support/inMemoryBackgroundJobStore.js";

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

const setup = (
  registry: ActionHandlerRegistry,
  options: Parameters<typeof createActionDispatchJobHandler>[1] = {},
) => {
  const clock = createClock();
  const store = new InMemoryBackgroundJobStore(clock);
  const wake: BackgroundJobWakePort & { requestDrain: ReturnType<typeof vi.fn> } = {
    requestDrain: vi.fn(async () => {}),
  };
  const logger = createLogger();
  const queue = new DefaultBackgroundJobQueue({ writer: store, wake, logger });
  const runtime = new BackgroundJobRuntime({
    store,
    handlers: [createActionDispatchJobHandler(registry, options)],
    wake,
    logger,
    now: clock.now,
  });
  return { clock, store, queue, runtime, logger };
};

const onlyRow = (store: InMemoryBackgroundJobStore): InMemoryBackgroundJobRow => {
  const rows = [...store.rows.values()];
  expect(rows).toHaveLength(1);
  return rows[0];
};

const actionPayload = (
  overrides: Partial<{
    type: string;
    payload: Record<string, unknown>;
    workspaceId: string | null;
    accountId: string | null;
    conversationId: string | null;
    idempotencyKey: string | null;
    skillName: string | null;
  }> = {},
) => ({
  type: "contact.send",
  payload: { email: "a@example.com" },
  workspaceId: "ws_1",
  accountId: null,
  conversationId: "conv_1",
  idempotencyKey: "k1",
  skillName: null,
  ...overrides,
});

describe("action dispatch job handler", () => {
  it("routes a claimed request to its registered handler with the row's routing fields in context", async () => {
    const handle = vi.fn(async () => undefined);
    const registry = new ActionHandlerRegistry([{ type: "contact.send", handler: { handle } }]);
    const { queue, runtime, store } = setup(registry);
    await queue.enqueue(backgroundJobRequest(ACTION_DISPATCH_JOB, actionPayload({ skillName: "contact_sales" })));

    const result = await runtime.drain({ maxJobs: 1 });

    expect(result).toMatchObject({ claimed: 1, completed: 1 });
    expect(handle).toHaveBeenCalledWith({
      payload: { email: "a@example.com" },
      context: {
        requestId: expect.any(String),
        workspaceId: "ws_1",
        accountId: null,
        conversationId: "conv_1",
        idempotencyKey: "k1",
        attempt: 1,
        skillName: "contact_sales",
      },
    });
    expect(store.rows.size).toBe(0);
  });

  it("resolves with a skip outcome, not a retry, when the handler throws ActionDispatchSkippedError", async () => {
    const handler: ActionHandler = {
      handle: vi.fn(async () => {
        throw new ActionDispatchSkippedError("mail_not_dispatched:driver=log");
      }),
    };
    const registry = new ActionHandlerRegistry([{ type: "contact.send", handler }]);
    const { queue, runtime } = setup(registry);
    await queue.enqueue(backgroundJobRequest(ACTION_DISPATCH_JOB, actionPayload()));

    const result = await runtime.drain({ maxJobs: 1 });

    expect(result).toMatchObject({ claimed: 1, skipped: 1, completed: 0, retried: 0, deadLettered: 0 });
  });

  it("fails the run (for the generic retry policy) without calling recordFailureOutcome when no handler is registered for the type", async () => {
    const registry = new ActionHandlerRegistry();
    const { queue, runtime, store } = setup(registry);
    await queue.enqueue(backgroundJobRequest(ACTION_DISPATCH_JOB, actionPayload({ type: "unknown.action" })));

    const result = await runtime.drain({ maxJobs: 1 });

    expect(result).toMatchObject({ claimed: 1, retried: 1 });
    expect(onlyRow(store).lastError).toBe("Error");
  });

  it("calls recordFailureOutcome with outcome 'retry' through the per-attempt hook, and 'failed' through the dead-letter hook on the terminal attempt", async () => {
    const recordFailureOutcome = vi.fn(async () => undefined);
    const handler: ActionHandler = {
      handle: vi.fn(async () => {
        throw new Error("smtp down");
      }),
      recordFailureOutcome,
    };
    const registry = new ActionHandlerRegistry([{ type: "contact.send", handler }]);
    const { clock, queue, runtime, store } = setup(registry);
    await queue.enqueue(backgroundJobRequest(ACTION_DISPATCH_JOB, actionPayload()));

    for (let attempt = 1; attempt <= ACTION_DISPATCH_JOB.policy.maxAttempts; attempt += 1) {
      await runtime.drain({ maxJobs: 1 });
      clock.advanceSeconds(3_600);
      const outcome = attempt < ACTION_DISPATCH_JOB.policy.maxAttempts ? "retry" : "failed";
      expect(recordFailureOutcome).toHaveBeenNthCalledWith(attempt, expect.objectContaining({ outcome }));
    }
    expect(recordFailureOutcome).toHaveBeenCalledTimes(ACTION_DISPATCH_JOB.policy.maxAttempts);
    expect(onlyRow(store)).toMatchObject({ status: "dead", lastError: "Error" });
  });

  it("recovers from a transient failure: a handler that fails twice then succeeds runs the per-attempt hook exactly twice", async () => {
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
    const registry = new ActionHandlerRegistry([{ type: "contact.send", handler }]);
    const { clock, queue, runtime, store } = setup(registry);
    await queue.enqueue(backgroundJobRequest(ACTION_DISPATCH_JOB, actionPayload()));

    const retryDelaysSeconds = ACTION_DISPATCH_JOB.policy.retryDelaysSeconds ?? [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      expect(await runtime.drain({ maxJobs: 1 })).toMatchObject({ claimed: 1, retried: 1 });
      clock.advanceSeconds(retryDelaysSeconds[attempt - 1] + 1);
    }
    expect(await runtime.drain({ maxJobs: 1 })).toMatchObject({ claimed: 1, completed: 1 });

    expect(recordFailureOutcome).toHaveBeenCalledTimes(2);
    expect(recordFailureOutcome).toHaveBeenNthCalledWith(1, expect.objectContaining({ outcome: "retry" }));
    expect(recordFailureOutcome).toHaveBeenNthCalledWith(2, expect.objectContaining({ outcome: "retry" }));
    expect(store.rows.size).toBe(0);
  });

  it("reports claimed/dispatched and claimed/retry through onPersistedOutcome, mirroring ActionDispatcher's prior events", async () => {
    const events: ActionDispatchPersistedOutcome[] = [];
    const onPersistedOutcome = vi.fn(({ outcome }: { outcome: ActionDispatchPersistedOutcome }) => {
      events.push(outcome);
    });
    let calls = 0;
    const handler: ActionHandler = {
      handle: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("provider_unavailable");
        }
      }),
    };
    const registry = new ActionHandlerRegistry([{ type: "contact.send", handler }]);
    const { clock, queue, runtime } = setup(registry, { onPersistedOutcome });
    await queue.enqueue(backgroundJobRequest(ACTION_DISPATCH_JOB, actionPayload()));

    await runtime.drain({ maxJobs: 1 });
    clock.advanceSeconds(61);
    await runtime.drain({ maxJobs: 1 });

    expect(events).toEqual(["claimed", "retry", "claimed", "dispatched"]);
    expect(onPersistedOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ type: "contact.send" }), outcome: "claimed" }),
    );
  });

  it("aborts a handler that outlives ACTION_DISPATCH_JOB's own deadline and schedules a retry", async () => {
    // `ActionHandler.handle` is never handed a signal (see the class doc comment on
    // `ACTION_DISPATCH_JOB`): a handler that never settles — a hung HTTP call to a bounded
    // transport (Resend, a webhook) with no timeout of its own — relies on the runtime's own
    // deadline to abandon the run and free the job for a retry, rather than blocking forever.
    vi.useFakeTimers({ now: START });
    try {
      const handler: ActionHandler = {
        handle: vi.fn(async () => {
          await new Promise(() => {}); // never settles
        }),
      };
      const registry = new ActionHandlerRegistry([{ type: "contact.send", handler }]);
      const { queue, runtime, store } = setup(registry);
      await queue.enqueue(backgroundJobRequest(ACTION_DISPATCH_JOB, actionPayload()));

      const draining = runtime.drain({ maxJobs: 1 });
      await vi.advanceTimersByTimeAsync(ACTION_DISPATCH_JOB.policy.timeoutSeconds * 1_000 + 1_000);

      expect(await draining).toMatchObject({ claimed: 1, retried: 1 });
      expect(onlyRow(store)).toMatchObject({ status: "pending", attempts: 1, lastError: "BackgroundJobTimeoutError" });
      expect(ACTION_DISPATCH_JOB.policy.timeoutSeconds).toBe(120);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { outcome: "claimed" as const, handle: vi.fn(async () => undefined), expectCompleted: true },
    { outcome: "dispatched" as const, handle: vi.fn(async () => undefined), expectCompleted: true },
    {
      outcome: "retry" as const,
      handle: vi.fn(async () => { throw new Error("provider_unavailable"); }),
      expectCompleted: false,
    },
    {
      outcome: "skipped" as const,
      handle: vi.fn(async () => { throw new ActionDispatchSkippedError("mail_not_dispatched:driver=log"); }),
      expectCompleted: false,
    },
  ])("isolates a throwing $outcome observer from the real dispatch outcome", async ({ outcome, handle, expectCompleted }) => {
    const onPersistedOutcome = vi.fn(({ outcome: actual }: { outcome: ActionDispatchPersistedOutcome }) => {
      if (actual === outcome) {
        throw new Error("observer unavailable");
      }
    });
    const registry = new ActionHandlerRegistry([{ type: "contact.send", handler: { handle } }]);
    const { queue, runtime } = setup(registry, { onPersistedOutcome });
    await queue.enqueue(backgroundJobRequest(ACTION_DISPATCH_JOB, actionPayload()));

    const result = await runtime.drain({ maxJobs: 1 });

    expect(onPersistedOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome }));
    if (expectCompleted) {
      expect(result).toMatchObject({ claimed: 1, completed: 1 });
    } else if (outcome === "retry") {
      expect(result).toMatchObject({ claimed: 1, retried: 1 });
    } else {
      expect(result).toMatchObject({ claimed: 1, skipped: 1 });
    }
    // A throwing observer must never turn a real send into a resend: the handler ran exactly once.
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing 'failed' observer from the terminal dead-letter outcome", async () => {
    const onPersistedOutcome = vi.fn(({ outcome }: { outcome: ActionDispatchPersistedOutcome }) => {
      if (outcome === "failed") {
        throw new Error("observer unavailable");
      }
    });
    const handle = vi.fn(async () => { throw new Error("smtp down"); });
    const registry = new ActionHandlerRegistry([{ type: "contact.send", handler: { handle } }]);
    const { queue, runtime } = setup(registry, { onPersistedOutcome, job: { ...ACTION_DISPATCH_JOB, policy: { ...ACTION_DISPATCH_JOB.policy, maxAttempts: 1 } } });
    await queue.enqueue(backgroundJobRequest(ACTION_DISPATCH_JOB, actionPayload()));

    const result = await runtime.drain({ maxJobs: 1 });

    expect(onPersistedOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    expect(result).toMatchObject({ claimed: 1, deadLettered: 1 });
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("does not call recordFailureOutcome when the handler does not implement it", async () => {
    const handler: ActionHandler = {
      handle: vi.fn(async () => {
        throw new Error("smtp down");
      }),
    };
    const registry = new ActionHandlerRegistry([{ type: "contact.send", handler }]);
    const { queue, runtime } = setup(registry);
    await queue.enqueue(backgroundJobRequest(ACTION_DISPATCH_JOB, actionPayload()));

    await expect(runtime.drain({ maxJobs: 1 })).resolves.toMatchObject({ retried: 1 });
  });

  it("keeps the outbox's old effective retry window: 60s, 120s, 300s, 600s across 4 retries (18 minutes)", () => {
    // The old flat 60 s backoff (`ActionDispatchWorker`'s poll-driven sweep, never woken on
    // retry) spent its 5 attempts over roughly 20 minutes in practice, because nothing woke a
    // retry early — it waited for the next poll tick or the sweep. The generic runtime wakes a
    // retry at its own availableAt, so a flat 60 s schedule here would finish all 5 attempts in
    // about 4 minutes, failing a transient 5-minute outage for good instead of riding it out.
    // This growing schedule keeps the old effective window.
    expect(ACTION_DISPATCH_JOB.policy.retryDelaysSeconds).toEqual([60, 120, 300, 600]);
    const totalDelaySeconds = (ACTION_DISPATCH_JOB.policy.retryDelaysSeconds ?? []).reduce((sum, seconds) => sum + seconds, 0);
    expect(totalDelaySeconds).toBe(1_080); // 18 minutes across the 4 retries before the 5th (final) attempt
  });
});
