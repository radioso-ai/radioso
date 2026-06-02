import { describe, expect, it, vi } from "vitest";

import type { ActionRequestRecord } from "../../src/db/repositories/actionRequestRepository.js";
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
  status: "pending",
  attempts: 0,
  ...overrides,
});

const outbox = (pending: ActionRequestRecord[]): ActionOutboxConsumerPort & {
  markDispatched: ReturnType<typeof vi.fn>;
  markFailed: ReturnType<typeof vi.fn>;
} => ({
  claimPending: vi.fn(async () => pending),
  markDispatched: vi.fn(async () => {}),
  markFailed: vi.fn(async () => {}),
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
  it("routes a pending request to its handler (with payload + context) and marks it dispatched", async () => {
    const handle = vi.fn(async () => {});
    const store = outbox([request()]);
    const dispatcher = new ActionDispatcher(store, new ActionHandlerRegistry([{ type: "contact.send", handler: { handle } }]));

    const result = await dispatcher.dispatchPending();

    expect(handle).toHaveBeenCalledWith({
      payload: { email: "x@y.z" },
      context: { workspaceId: "ws_1", accountId: null, conversationId: "conv_1" },
    });
    expect(store.markDispatched).toHaveBeenCalledWith("r1");
    expect(store.markFailed).not.toHaveBeenCalled();
    expect(result).toEqual({ dispatched: 1, failed: 0 });
  });

  it("marks a request failed (never dropped) when no handler is registered for its type", async () => {
    const store = outbox([request({ type: "unknown.action" })]);
    const dispatcher = new ActionDispatcher(store, new ActionHandlerRegistry());

    const result = await dispatcher.dispatchPending();

    expect(store.markFailed).toHaveBeenCalledWith("r1", "no_handler_for_type:unknown.action");
    expect(result).toEqual({ dispatched: 0, failed: 1 });
  });

  it("marks a request failed with the error when the handler throws", async () => {
    const store = outbox([request()]);
    const dispatcher = new ActionDispatcher(
      store,
      new ActionHandlerRegistry([{ type: "contact.send", handler: { handle: vi.fn(async () => { throw new Error("smtp down"); }) } }]),
    );

    const result = await dispatcher.dispatchPending();

    expect(store.markFailed).toHaveBeenCalledWith("r1", "smtp down");
    expect(store.markDispatched).not.toHaveBeenCalled();
    expect(result).toEqual({ dispatched: 0, failed: 1 });
  });
});
