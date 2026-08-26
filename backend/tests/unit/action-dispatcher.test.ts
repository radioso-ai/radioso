import { describe, expect, it, vi } from "vitest";

import type {
  ActionFailureOutcome,
  ActionRequestRecord,
} from "../../src/db/repositories/actionRequestRepository.js";
import {
  ActionDispatcher,
  ActionHandlerRegistry,
  type ActionHandler,
  type ActionOutboxConsumerPort,
} from "../../src/modules/chat/services/actions/actionDispatcher.js";

const request = (overrides: Partial<ActionRequestRecord> = {}): ActionRequestRecord => ({
  id: "r1",
  type: "contact.send",
  payload: { email: "x@y.z" },
  workspaceId: "ws_1",
  accountId: null,
  conversationId: "conv_1",
  idempotencyKey: "k1",
  // A claimed row, as claimPending returns it: in_progress with its attempt version.
  status: "in_progress",
  attempts: 1,
  skillName: null,
  ...overrides,
});

const outbox = (
  pending: ActionRequestRecord[],
  failureOutcome: ActionFailureOutcome = "failed",
): ActionOutboxConsumerPort & {
  claimPending: ReturnType<typeof vi.fn>;
  markDispatched: ReturnType<typeof vi.fn>;
  recordFailure: ReturnType<typeof vi.fn>;
} => ({
  claimPending: vi.fn(async () => pending),
  markDispatched: vi.fn(async () => true),
  recordFailure: vi.fn(async () => failureOutcome),
});

describe("ActionHandlerRegistry", () => {
  it("resolves a registered handler and rejects duplicate registrations", () => {
    const handler: ActionHandler = { handle: vi.fn() };
    const registry = new ActionHandlerRegistry([{ type: "contact.send", handler }]);
    expect(registry.resolve("contact.send")).toBe(handler);
    expect(registry.resolve("unknown")).toBeNull();
    expect(registry.isEmpty).toBe(false);
    expect(() => registry.register("contact.send", handler)).toThrow("already registered");
  });
});

describe("ActionDispatcher", () => {
  it("claims with the lease, routes to the handler (payload + context), and marks dispatched", async () => {
    const handle = vi.fn(async () => {});
    const store = outbox([request()]);
    const dispatcher = new ActionDispatcher(
      store,
      new ActionHandlerRegistry([{ type: "contact.send", handler: { handle } }]),
      { leaseSeconds: 300 },
    );

    const result = await dispatcher.dispatchPending();

    expect(store.claimPending).toHaveBeenCalledWith(20, 300);
    expect(handle).toHaveBeenCalledWith({
      payload: { email: "x@y.z" },
      context: {
        requestId: "r1",
        workspaceId: "ws_1",
        accountId: null,
        conversationId: "conv_1",
        idempotencyKey: "k1",
        attempt: 1,
        skillName: null,
      },
    });
    expect(store.markDispatched).toHaveBeenCalledWith("r1", 1);
    expect(store.recordFailure).not.toHaveBeenCalled();
    expect(result).toEqual({ dispatched: 1, retried: 0, failed: 0 });
  });

  it("carries the row's skill_name through to the handler context", async () => {
    const handle = vi.fn(async () => {});
    const store = outbox([request({ skillName: "contact_sales" })]);
    const dispatcher = new ActionDispatcher(
      store,
      new ActionHandlerRegistry([{ type: "contact.send", handler: { handle } }]),
    );

    await dispatcher.dispatchPending();

    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ skillName: "contact_sales" }) }),
    );
  });

  it("records a failure (never dropped) when no handler is registered for its type", async () => {
    const store = outbox([request({ type: "unknown.action" })], "failed");
    const dispatcher = new ActionDispatcher(store, new ActionHandlerRegistry(), {
      maxAttempts: 5,
      retryBackoffSeconds: 60,
    });

    const result = await dispatcher.dispatchPending();

    expect(store.recordFailure).toHaveBeenCalledWith("r1", "no_handler_for_type:unknown.action", 1, 5, 60);
    expect(result).toEqual({ dispatched: 0, retried: 0, failed: 1 });
  });

  it("counts a within-budget handler failure as a retry, not a terminal failure", async () => {
    const recordFailureOutcome = vi.fn(async () => {});
    const store = outbox([request()], "retry");
    const dispatcher = new ActionDispatcher(
      store,
      new ActionHandlerRegistry([{
        type: "contact.send",
        handler: {
          handle: vi.fn(async () => {
            throw new Error("smtp down");
          }),
          recordFailureOutcome,
        },
      }]),
    );

    const result = await dispatcher.dispatchPending();

    expect(store.recordFailure).toHaveBeenCalledWith("r1", "smtp down", 1, expect.any(Number), expect.any(Number));
    expect(recordFailureOutcome).toHaveBeenCalledWith({
      payload: { email: "x@y.z" },
      context: {
        requestId: "r1",
        workspaceId: "ws_1",
        accountId: null,
        conversationId: "conv_1",
        idempotencyKey: "k1",
        attempt: 1,
        skillName: null,
      },
      outcome: "retry",
      error: "smtp down",
    });
    expect(store.markDispatched).not.toHaveBeenCalled();
    expect(result).toEqual({ dispatched: 0, retried: 1, failed: 0 });
  });

  it("marks terminal handler skips as dispatched when the handler returns successfully", async () => {
    const handle = vi.fn(async () => undefined);
    const store = outbox([request({ type: "webhook.send" })]);
    const dispatcher = new ActionDispatcher(
      store,
      new ActionHandlerRegistry([{ type: "webhook.send", handler: { handle } }]),
    );

    const result = await dispatcher.dispatchPending();

    expect(store.markDispatched).toHaveBeenCalledWith("r1", 1);
    expect(store.recordFailure).not.toHaveBeenCalled();
    expect(result).toEqual({ dispatched: 1, retried: 0, failed: 0 });
  });

  it("does not report delivery when a stale mark-dispatched claim is a no-op", async () => {
    const handle = vi.fn(async () => undefined);
    const store = {
      ...outbox([request()]),
      markDispatched: vi.fn(async () => false),
    } as unknown as ActionOutboxConsumerPort & { markDispatched: ReturnType<typeof vi.fn> };
    const onPersistedOutcome = vi.fn();
    const dispatcher = new ActionDispatcher(
      store,
      new ActionHandlerRegistry([{ type: "contact.send", handler: { handle } }]),
      {},
      onPersistedOutcome,
    );

    await expect(dispatcher.dispatchPending()).resolves.toEqual({ dispatched: 0, retried: 0, failed: 0 });
    expect(store.markDispatched).toHaveBeenCalledWith("r1", 1);
    expect(handle).toHaveBeenCalledOnce();
    expect(onPersistedOutcome).toHaveBeenCalledTimes(1);
    expect(onPersistedOutcome).toHaveBeenCalledWith({ request: expect.objectContaining({ id: "r1" }), outcome: "claimed" });
  });

  it("reports each real persisted claim and delivery transition through the product-neutral observer", async () => {
    const onPersistedOutcome = vi.fn();
    const store = outbox([request()]);
    const dispatcher = new ActionDispatcher(
      store,
      new ActionHandlerRegistry([{ type: "contact.send", handler: { handle: vi.fn() } }]),
      {},
      onPersistedOutcome,
    );

    await dispatcher.dispatchPending();

    expect(onPersistedOutcome.mock.calls.map(([event]) => event.outcome)).toEqual(["claimed", "dispatched"]);
  });

  it.each([
    {
      name: "claimed",
      failureOutcome: "failed" as const,
      handle: vi.fn(async () => undefined),
      throwingOutcome: "claimed" as const,
      expected: { dispatched: 1, retried: 0, failed: 0 },
    },
    {
      name: "dispatched",
      failureOutcome: "failed" as const,
      handle: vi.fn(async () => undefined),
      throwingOutcome: "dispatched" as const,
      expected: { dispatched: 1, retried: 0, failed: 0 },
    },
    {
      name: "retry",
      failureOutcome: "retry" as const,
      handle: vi.fn(async () => { throw new Error("provider unavailable"); }),
      throwingOutcome: "retry" as const,
      expected: { dispatched: 0, retried: 1, failed: 0 },
    },
    {
      name: "failed",
      failureOutcome: "failed" as const,
      handle: vi.fn(async () => { throw new Error("invalid destination"); }),
      throwingOutcome: "failed" as const,
      expected: { dispatched: 0, retried: 0, failed: 1 },
    },
  ])("isolates a throwing $name observer from persisted dispatcher outcomes", async ({
    failureOutcome,
    handle,
    throwingOutcome,
    expected,
  }) => {
    const store = outbox([request()], failureOutcome);
    const observer = vi.fn((event: { outcome: string }) => {
      if (event.outcome === throwingOutcome) {
        throw new Error("observer unavailable");
      }
    });
    const dispatcher = new ActionDispatcher(
      store,
      new ActionHandlerRegistry([{ type: "contact.send", handler: { handle } }]),
      {},
      observer,
    );

    await expect(dispatcher.dispatchPending()).resolves.toEqual(expected);
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ outcome: throwingOutcome }));
    if (throwingOutcome === "dispatched") {
      expect(store.recordFailure).not.toHaveBeenCalled();
    }
  });

  it("ignores a superseded claim's result (another worker reclaimed the row)", async () => {
    const store = outbox([request()], "superseded");
    const dispatcher = new ActionDispatcher(
      store,
      new ActionHandlerRegistry([{ type: "contact.send", handler: { handle: vi.fn(async () => { throw new Error("slow"); }) } }]),
    );

    const result = await dispatcher.dispatchPending();

    expect(result).toEqual({ dispatched: 0, retried: 0, failed: 0 });
  });

  it("counts a budget-exhausted handler failure as a terminal failure", async () => {
    const store = outbox([request()], "failed");
    const dispatcher = new ActionDispatcher(
      store,
      new ActionHandlerRegistry([{ type: "contact.send", handler: { handle: vi.fn(async () => { throw new Error("smtp down"); }) } }]),
    );

    const result = await dispatcher.dispatchPending();

    expect(result).toEqual({ dispatched: 0, retried: 0, failed: 1 });
  });
});
