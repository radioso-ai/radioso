import { describe, expect, it, vi } from "vitest";
import type { ConversationRoutineStore, RoutineState } from "@radioso/conversation-contract";

import { DeferredRoutineStore } from "../../src/modules/chat/services/routines/deferredRoutineStore.js";

const state = (overrides: Partial<RoutineState> = {}): RoutineState => ({
  sessionId: "conv_1",
  routineId: "contact.request",
  path: ["ask_email"],
  variables: {},
  status: "active",
  ...overrides,
});

const innerStore = (): ConversationRoutineStore & {
  loadActive: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
} => ({
  loadActive: vi.fn(async () => null),
  save: vi.fn(async () => {}),
  clear: vi.fn(async () => {}),
});

describe("DeferredRoutineStore", () => {
  it("records the state the turn started on beside the transition it captures (#1543)", async () => {
    const inner = innerStore();
    const started = state({ path: ["ask_injury"] });
    inner.loadActive.mockResolvedValue(started);
    const store = new DeferredRoutineStore(inner);

    await store.loadActive({ sessionId: "conv_1" });
    // A later read in the same turn is not where it started.
    inner.loadActive.mockResolvedValue(state({ path: ["ask_injury", "confirm"] }));
    await store.loadActive({ sessionId: "conv_1" });
    await store.save(state({ path: ["ask_injury", "confirm"] }));

    expect(store.getTransition()).toMatchObject({ kind: "save", startedFrom: started });
    await store.clear({ sessionId: "conv_1" });
    expect(store.getTransition()).toEqual({ kind: "clear", sessionId: "conv_1", startedFrom: started });
  });

  it("seeds a fresh execution with its activation message and preserves an existing execution's anchor", async () => {
    const inner = innerStore();
    const fresh = new DeferredRoutineStore(inner, "activation-message");
    await fresh.save(state({ executionId: "execution-new" }));
    expect(fresh.getTransition()).toMatchObject({
      kind: "save",
      state: { executionId: "execution-new", startedMessageId: "activation-message" },
    });

    const resumed = new DeferredRoutineStore(inner, "current-message");
    await resumed.save(state({ executionId: "execution-existing", startedMessageId: "original-message" }));
    expect(resumed.getTransition()).toMatchObject({
      kind: "save",
      state: { executionId: "execution-existing", startedMessageId: "original-message" },
    });
  });

  it("reads through loadActive but defers save until commit", async () => {
    const inner = innerStore();
    const deferred = new DeferredRoutineStore(inner);

    await deferred.loadActive({ sessionId: "conv_1" });
    expect(inner.loadActive).toHaveBeenCalledWith({ sessionId: "conv_1" });

    const next = state({ path: ["ask_email", "ask_message"] });
    await deferred.save(next);
    expect(inner.save).not.toHaveBeenCalled(); // not yet written

    await deferred.commit();
    expect(inner.save).toHaveBeenCalledWith(next);
  });

  it("defers clear until commit", async () => {
    const inner = innerStore();
    const deferred = new DeferredRoutineStore(inner);

    await deferred.clear({ sessionId: "conv_1" });
    expect(inner.clear).not.toHaveBeenCalled();

    await deferred.commit();
    expect(inner.clear).toHaveBeenCalledWith({ sessionId: "conv_1" });
  });

  it("only flushes the latest transition, and is a no-op when nothing was captured", async () => {
    const inner = innerStore();
    const deferred = new DeferredRoutineStore(inner);

    // Nothing captured → commit writes nothing (recoverability: never advanced).
    await deferred.commit();
    expect(inner.save).not.toHaveBeenCalled();
    expect(inner.clear).not.toHaveBeenCalled();

    // The final transition wins (the engine walks to a terminal → clear).
    await deferred.save(state());
    await deferred.clear({ sessionId: "conv_1" });
    await deferred.commit();
    expect(inner.save).not.toHaveBeenCalled();
    expect(inner.clear).toHaveBeenCalledTimes(1);

    // Already flushed → a second commit is a no-op.
    inner.clear.mockClear();
    await deferred.commit();
    expect(inner.clear).not.toHaveBeenCalled();
  });
});
