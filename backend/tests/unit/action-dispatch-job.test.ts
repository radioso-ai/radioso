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

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      expect(await runtime.drain({ maxJobs: 1 })).toMatchObject({ claimed: 1, retried: 1 });
      clock.advanceSeconds(61);
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
});
