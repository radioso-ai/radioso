import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ChatTurnDisconnectAbortError,
  ChatTurnSupersededError,
  type ConversationTurnInterruptionObserver,
  type ConversationTurnRegistry,
} from "../../src/modules/chat/services/conversationTurnRegistry.js";

/** One registry implementation under the shared lease contract. */
export interface ConversationTurnRegistryHarness {
  registry: ConversationTurnRegistry;
  /**
   * Resolves once every turn started so far has taken its place in the conversation's order, so a
   * wait that is still pending is pending for its predecessors, not for its own registration.
   * Supersession never needs it: that applies inside `start`.
   */
  settle(): Promise<void>;
  close(): Promise<void>;
}

/** Resolves on the next macrotask with whether `promise` is still unsettled. */
export const isPending = async (promise: Promise<unknown>): Promise<boolean> => {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  return !settled;
};

const speechLike = { supersedeAfterEmission: true };

/**
 * The lease contract every `ConversationTurnRegistry` keeps for turns of one process. A newer turn
 * supersedes in `start` itself, before any I/O, so a predecessor's synchronous latches can never
 * slip in between. Each case runs on a fresh conversation id, so a registry backed by shared
 * storage needs no reset.
 */
export const describeConversationTurnRegistryContract = (
  label: string,
  createHarness: (observer: ConversationTurnInterruptionObserver) => Promise<ConversationTurnRegistryHarness>,
): void => {
  describe(`${label} (conversation turn lease contract)`, () => {
    let harness: ConversationTurnRegistryHarness;
    let turnCancelled: ReturnType<typeof vi.fn<ConversationTurnInterruptionObserver["turnCancelled"]>>;
    let conversationId: string;

    beforeEach(async () => {
      turnCancelled = vi.fn<ConversationTurnInterruptionObserver["turnCancelled"]>();
      harness = await createHarness({ turnCancelled });
      conversationId = randomUUID();
    });

    afterEach(async () => {
      await harness.close();
    });

    it("cancels an unlatched predecessor and holds its successor until cleanup completes", async () => {
      const first = harness.registry.start(conversationId);
      first.setStage("rendering");

      const second = harness.registry.start(conversationId);

      expect(first.signal.aborted).toBe(true);
      expect(() => first.throwIfCancelled()).toThrowError(ChatTurnSupersededError);
      expect(turnCancelled).toHaveBeenCalledWith({
        conversationId,
        reason: "superseded",
        stage: "rendering",
        scope: "local",
      });
      await harness.settle();
      expect(await isPending(second.waitForPredecessor())).toBe(true);

      first.complete();
      await second.waitForPredecessor();
      second.complete();
    });

    it("does not cancel a predecessor after its emission latch is set", async () => {
      const first = harness.registry.start(conversationId);
      first.beginEmission();

      const second = harness.registry.start(conversationId);

      expect(first.signal.aborted).toBe(false);
      expect(turnCancelled).not.toHaveBeenCalled();
      await harness.settle();
      expect(await isPending(second.waitForPredecessor())).toBe(true);

      first.complete();
      await second.waitForPredecessor();
      second.complete();
    });

    it("runs a turn at once when the conversation's previous turn already completed", async () => {
      const first = harness.registry.start(conversationId);
      await first.waitForPredecessor();
      first.complete();

      const second = harness.registry.start(conversationId);
      await second.waitForPredecessor();

      expect(first.signal.aborted).toBe(false);
      expect(second.signal.aborted).toBe(false);
      second.complete();
    });

    it("orders the turns of each conversation on their own", async () => {
      const first = harness.registry.start(conversationId);
      const other = harness.registry.start(randomUUID());

      await other.waitForPredecessor();
      expect(first.signal.aborted).toBe(false);
      expect(other.signal.aborted).toBe(false);
      first.complete();
      other.complete();
    });

    describe("superseding after emission", () => {
      it("cancels a predecessor that started emitting when both turns supersede after emission", async () => {
        const first = harness.registry.start(conversationId, speechLike);
        first.beginEmission();

        const second = harness.registry.start(conversationId, speechLike);

        expect(first.signal.aborted).toBe(true);
        expect(() => first.throwIfCancelled()).toThrowError(
          expect.objectContaining({
            name: "ChatTurnSupersededError",
            stage: "persisting",
            afterEmission: true,
            replacedByNewerInput: true,
          }),
        );
        expect(turnCancelled).toHaveBeenCalledWith({
          conversationId,
          reason: "superseded",
          stage: "persisting",
          scope: "local",
        });
        await harness.settle();
        expect(await isPending(second.waitForPredecessor())).toBe(true);

        first.complete();
        await second.waitForPredecessor();
        second.complete();
      });

      it("reports a speech-like turn cancelled before it emitted as cancelled before emission", async () => {
        const first = harness.registry.start(conversationId, speechLike);
        first.setStage("routing");

        const second = harness.registry.start(conversationId, speechLike);

        expect(() => first.throwIfCancelled()).toThrowError(
          expect.objectContaining({ stage: "routing", afterEmission: false, replacedByNewerInput: true }),
        );
        first.complete();
        second.complete();
      });

      it("cancels a speech-like turn that has not emitted for a newer default-mode turn without calling its input replaced", async () => {
        const first = harness.registry.start(conversationId, speechLike);
        first.setStage("routing");

        const second = harness.registry.start(conversationId);

        expect(first.signal.aborted).toBe(true);
        expect(() => first.throwIfCancelled()).toThrowError(
          expect.objectContaining({ stage: "routing", afterEmission: false, replacedByNewerInput: false }),
        );
        first.complete();
        second.complete();
      });

      it("never calls a default-mode turn's input replaced", async () => {
        const first = harness.registry.start(conversationId);

        const second = harness.registry.start(conversationId, speechLike);

        expect(() => first.throwIfCancelled()).toThrowError(expect.objectContaining({ replacedByNewerInput: false }));
        first.complete();
        second.complete();
      });

      it("lets an emitting chat turn finish when only the newer turn supersedes after emission", async () => {
        const first = harness.registry.start(conversationId);
        first.beginEmission();

        const second = harness.registry.start(conversationId, speechLike);

        expect(first.signal.aborted).toBe(false);
        first.complete();
        second.complete();
      });

      it("lets a speech-like turn that began committing finish, holding the newer one until it completes", async () => {
        const first = harness.registry.start(conversationId, speechLike);
        first.beginEmission();
        first.beginCommit();

        const second = harness.registry.start(conversationId, speechLike);

        expect(first.signal.aborted).toBe(false);
        expect(() => first.throwIfCancelled()).not.toThrow();
        expect(turnCancelled).not.toHaveBeenCalled();
        await harness.settle();
        expect(await isPending(second.waitForPredecessor())).toBe(true);

        first.complete();
        await second.waitForPredecessor();
        second.complete();
      });

      it("atomically refuses to begin committing a turn a newer one already superseded", async () => {
        const first = harness.registry.start(conversationId, speechLike);
        first.beginEmission();
        const second = harness.registry.start(conversationId, speechLike);

        expect(() => first.beginCommit()).toThrowError(
          expect.objectContaining({ name: "ChatTurnSupersededError", afterEmission: true, replacedByNewerInput: true }),
        );
        first.complete();
        second.complete();
      });

      it("lets an emitting speech-like turn finish when the newer turn is a default chat turn", async () => {
        const first = harness.registry.start(conversationId, speechLike);
        first.beginEmission();

        const second = harness.registry.start(conversationId);

        expect(first.signal.aborted).toBe(false);
        first.complete();
        second.complete();
      });
    });

    it("waits for every older turn still in flight, even when the turn between them ended first", async () => {
      const first = harness.registry.start(conversationId);
      first.beginEmission();
      const second = harness.registry.start(conversationId);
      second.complete();

      const third = harness.registry.start(conversationId);

      expect(first.signal.aborted).toBe(false);
      await harness.settle();
      expect(await isPending(third.waitForPredecessor())).toBe(true);
      first.complete();
      await third.waitForPredecessor();
      third.complete();
    });

    it("lets only the turn right behind a turn decide whether it is cut off", async () => {
      const first = harness.registry.start(conversationId, speechLike);
      first.beginEmission();
      const second = harness.registry.start(conversationId);
      expect(first.signal.aborted).toBe(false);
      second.complete();

      const third = harness.registry.start(conversationId, speechLike);

      expect(first.signal.aborted).toBe(false);
      first.complete();
      await third.waitForPredecessor();
      third.complete();
    });

    it("keeps newer registry ownership when an older turn completes", async () => {
      const first = harness.registry.start(conversationId);
      const second = harness.registry.start(conversationId);

      first.complete();
      const third = harness.registry.start(conversationId);

      expect(second.signal.aborted).toBe(true);
      expect(third.signal.aborted).toBe(false);
      second.complete();
      await third.waitForPredecessor();
      third.complete();
    });

    it("atomically refuses to latch a turn that was already cancelled", async () => {
      const first = harness.registry.start(conversationId);
      first.setStage("preparing");
      const second = harness.registry.start(conversationId);

      expect(() => first.beginEmission()).toThrowError(
        expect.objectContaining({
          code: "chat_turn_superseded",
          details: {
            conversationId,
            reason: "superseded",
            stage: "preparing",
          },
        }),
      );
      first.complete();
      second.complete();
    });

    it("cancels a lease externally after disconnect, aborting its signal and reporting through the cancellation observer", async () => {
      const lease = harness.registry.start(conversationId);
      lease.setStage("rendering");

      lease.cancelAfterDisconnect();

      expect(lease.signal.aborted).toBe(true);
      expect(() => lease.throwIfCancelled()).toThrowError(ChatTurnDisconnectAbortError);
      expect(turnCancelled).toHaveBeenCalledWith({
        conversationId,
        reason: "disconnect_timeout",
        stage: "rendering",
        scope: "local",
      });
      lease.complete();
    });

    it("releases the successor of a turn cancelled after disconnect once that turn completes", async () => {
      const first = harness.registry.start(conversationId);
      first.beginEmission();
      const second = harness.registry.start(conversationId);

      first.cancelAfterDisconnect();
      await harness.settle();
      expect(await isPending(second.waitForPredecessor())).toBe(true);

      first.complete();
      await second.waitForPredecessor();
      expect(second.signal.aborted).toBe(false);
      second.complete();
    });

    it("does not report a disconnect cancellation twice when the lease is already cancelled", async () => {
      const lease = harness.registry.start(conversationId);

      lease.cancelAfterDisconnect();
      lease.cancelAfterDisconnect();

      expect(turnCancelled).toHaveBeenCalledTimes(1);
      lease.complete();
    });

    it("does not cancel a lease that has already completed", async () => {
      const lease = harness.registry.start(conversationId);

      lease.complete();
      lease.cancelAfterDisconnect();

      expect(lease.signal.aborted).toBe(false);
      expect(turnCancelled).not.toHaveBeenCalled();
    });
  });
};
