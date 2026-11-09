import { describe, expect, it, vi } from "vitest";

import type { ConversationClarificationStore, RoutineStartOffer } from "@radioso/conversation-contract";

import { DeferredRoutineOffer, type RoutineOfferStore } from "../../src/modules/chat/services/routines/deferredRoutineOffer.js";

const offer: RoutineStartOffer = {
  routineId: "room_booking",
  label: "Room booking",
  pending: {
    sessionId: "conv_1",
    source: "routine_activation",
    mode: "offer",
    candidates: [{ id: "room_booking", label: "Room booking", confidence: 0.9, payload: { routineId: "room_booking" } }],
    status: "pending",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
};

const plainTurn = { routineRan: false, clarification: null, handsOff: false };

const heldAndComposed = () => {
  const deferred = new DeferredRoutineOffer();
  deferred.hold(offer);
  deferred.closing();
  return deferred;
};

describe("DeferredRoutineOffer", () => {
  it("shows the offer when the reply was composed with it and nothing else took the turn", () => {
    expect(heldAndComposed().shown(plainTurn)).toEqual({ pending: offer.pending, routineId: "room_booking" });
  });

  it("drops the offer when a routine took the turn over and replaced the answer", () => {
    expect(heldAndComposed().shown({ ...plainTurn, routineRan: true })).toBeNull();
  });

  it("drops the offer when another clarification took the turn's pending row", () => {
    const question = { kind: "save" as const, pending: { ...offer.pending, source: "routine_activation", mode: "ask" as const } };

    expect(heldAndComposed().shown({ ...plainTurn, clarification: question })).toBeNull();
    expect(heldAndComposed().shown({ ...plainTurn, clarification: { kind: "clear", sessionId: "conv_1", outcome: "declined" } }))
      .not.toBeNull();
  });

  it("drops the offer when the reply hands the visitor to a person, which leaves the closing out", () => {
    expect(heldAndComposed().shown({ ...plainTurn, handsOff: true })).toBeNull();
  });

  it("drops the offer when no reply was composed with the closing", () => {
    const deferred = new DeferredRoutineOffer();
    deferred.hold(offer);

    expect(deferred.shown(plainTurn)).toBeNull();
  });

  it("writes a shown offer's pending row and memory where no turn transaction does", async () => {
    const store: RoutineOfferStore = { loadOffered: vi.fn(async () => ["table_booking"]), record: vi.fn(async () => {}) };
    const clarifications: ConversationClarificationStore = { loadPending: vi.fn(), save: vi.fn(async () => {}), clear: vi.fn() };
    const deferred = new DeferredRoutineOffer(store, clarifications);
    deferred.hold(offer);
    deferred.closing();

    await expect(deferred.loadOffered({ sessionId: "conv_1" })).resolves.toEqual(["table_booking"]);
    await deferred.commit(deferred.shown(plainTurn)!);

    expect(clarifications.save).toHaveBeenCalledWith(offer.pending);
    expect(store.record).toHaveBeenCalledWith({ sessionId: "conv_1", routineId: "room_booking" });
  });
});
