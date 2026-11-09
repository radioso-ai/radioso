import { describe, expect, it, vi } from "vitest";

import type { ConversationClarificationStore, PendingClarification } from "@radioso/conversation-contract";

import { DeferredClarificationStore } from "../../src/modules/chat/services/clarification/deferredClarificationStore.js";

const pending: PendingClarification = {
  sessionId: "conv_1",
  source: "test_surface",
  candidates: [{ id: "a", label: "Alpha", confidence: 0.8, payload: { opaque: "a" } }],
  askedEventId: "assistant_msg_1",
  status: "pending",
  expiresAt: "2026-06-10T12:00:00.000Z",
};

const innerStore = (): ConversationClarificationStore => ({
  loadPending: vi.fn(async () => pending),
  save: vi.fn(async () => {}),
  clear: vi.fn(async () => {}),
});

describe("DeferredClarificationStore", () => {
  it("captures save without writing until commit", async () => {
    const inner = innerStore();
    const store = new DeferredClarificationStore(inner);

    await store.save(pending);

    expect(inner.save).not.toHaveBeenCalled();
    expect(store.getTransition()).toEqual({ kind: "save", pending });

    await store.commit();
    expect(inner.save).toHaveBeenCalledWith(pending);
    expect(store.getTransition()).toBeNull();
  });

  it("captures clear without writing until commit", async () => {
    const inner = innerStore();
    const store = new DeferredClarificationStore(inner);

    await store.clear({ sessionId: "conv_1", outcome: "declined" });

    expect(inner.clear).not.toHaveBeenCalled();
    expect(store.getTransition()).toEqual({ kind: "clear", sessionId: "conv_1", outcome: "declined" });

    await store.commit();
    expect(inner.clear).toHaveBeenCalledWith({ sessionId: "conv_1", outcome: "declined" });
  });

  it("passes loadPending through and consumes one transition", async () => {
    const inner = innerStore();
    const store = new DeferredClarificationStore(inner);

    await expect(store.loadPending({ sessionId: "conv_1" })).resolves.toEqual(pending);
    await store.save(pending);

    expect(store.consumeTransition()).toEqual({ kind: "save", pending });
    expect(store.consumeTransition()).toBeNull();
  });

  it("keeps a routine offer with the pending row it accompanies, so both commit together", async () => {
    const inner = innerStore();
    const offerMemory = { loadOffered: vi.fn(async () => ["table_booking"]), recordOffered: vi.fn(async () => {}) };
    const store = new DeferredClarificationStore(inner, offerMemory);

    await store.save(pending);
    await store.recordOffered({ sessionId: "conv_1", routineId: "room_booking" });

    await expect(store.loadOffered({ sessionId: "conv_1" })).resolves.toEqual(["table_booking", "room_booking"]);
    expect(offerMemory.recordOffered).not.toHaveBeenCalled();
    expect(store.getTransition()).toEqual({ kind: "save", pending, offeredRoutineIds: ["room_booking"] });

    await store.commit();
    expect(inner.save).toHaveBeenCalledWith(pending);
    expect(offerMemory.recordOffered).toHaveBeenCalledExactlyOnceWith({ sessionId: "conv_1", routineId: "room_booking" });
  });

  it("remembers this turn's offers when the host keeps no offer memory, as a replayed turn does", async () => {
    const store = new DeferredClarificationStore(innerStore());

    await store.recordOffered({ sessionId: "conv_1", routineId: "room_booking" });

    await expect(store.loadOffered({ sessionId: "conv_1" })).resolves.toEqual(["room_booking"]);
  });
});
