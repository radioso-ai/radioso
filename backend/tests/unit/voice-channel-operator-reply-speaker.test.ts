import { describe, expect, it, vi } from "vitest";

import { OperatorReplySpeaker } from "../../src/modules/voiceChannel/services/operatorReplySpeaker.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const conversationId = "55555555-5555-4555-8555-555555555555";
const session = { workspaceId, agentId: "22222222-2222-4222-8222-222222222222", vendor: "elevenlabs" };
const fourWorks = { messageId: "reply-four", text: "Yes, **four** works. Bring your card" };
const wordless = { messageId: "reply-wordless", text: "**" };

type Speech = { state: "pending" } | { state: "claimed"; claimTurnId: string } | { state: "spoken" } | { state: "skipped" };

/** Chat's store of the conversation's teammate replies, as the message repository keeps their speech state. */
const claimStore = (replies: Array<{ messageId: string; text: string }>) => {
  const speech = new Map<string, Speech>(replies.map((reply) => [reply.messageId, { state: "pending" }]));
  const replace = (messageIds: string[], from: (state: Speech) => boolean, to: Speech) =>
    messageIds.filter((messageId) => {
      const current = speech.get(messageId);
      if (!current || !from(current)) return false;
      speech.set(messageId, to);
      return true;
    });
  const heldBy = (claimTurnId: string) => (state: Speech) => state.state === "claimed" && state.claimTurnId === claimTurnId;
  const isPending = (state: Speech) => state.state === "pending";
  return {
    speech,
    claims: {
      pendingOperatorReplies: vi.fn(async () => replies.filter((reply) => speech.get(reply.messageId)?.state === "pending")),
      claimOperatorReplies: vi.fn(async ({ messageIds, claimTurnId }: { messageIds: string[]; claimTurnId: string }) =>
        replace(messageIds, isPending, { state: "claimed", claimTurnId })),
      releaseOperatorReplies: vi.fn(async ({ messageIds, claimTurnId }: { messageIds: string[]; claimTurnId: string }) =>
        replace(messageIds, heldBy(claimTurnId), { state: "pending" })),
      skipOperatorReplies: vi.fn(async ({ messageIds }: { messageIds: string[] }) => replace(messageIds, isPending, { state: "skipped" })),
    },
    recordSpoken: vi.fn(async ({ messageIds, claimTurnId }: { messageIds: string[]; claimTurnId: string }) =>
      replace(messageIds, heldBy(claimTurnId), { state: "spoken" })),
  };
};

const speakerOver = (store: ReturnType<typeof claimStore>, overrides: { claimTurnId?: string } = {}) => {
  const logger = { warn: vi.fn() };
  const metrics = { observeHistogram: vi.fn(), incrementCounter: vi.fn() };
  const speaker = new OperatorReplySpeaker({
    replies: { claims: store.claims, newClaimTurnId: () => overrides.claimTurnId ?? "turn-1" },
    recordSpoken: store.recordSpoken,
    withinTimeout: (write) => write,
    logger,
    metrics,
  }, session);
  return { speaker, logger, metrics };
};

describe("operator reply speaker", () => {
  it("claims the pending replies with words to say and speaks them as pieces that are never the last", async () => {
    const store = claimStore([wordless, fourWorks]);
    const { speaker } = speakerOver(store);

    const claimed = await speaker.claim(conversationId, await speaker.pending(conversationId));

    expect([...speaker.speech(claimed)]).toEqual([
      { type: "speech", text: "Yes, four works. ", last: false },
      { type: "speech", text: "Bring your card\n", last: false },
    ]);
    expect(store.claims.claimOperatorReplies).toHaveBeenCalledWith({ workspaceId, conversationId, messageIds: [fourWorks.messageId], claimTurnId: "turn-1" });
    expect(store.speech.get(fourWorks.messageId)).toEqual({ state: "claimed", claimTurnId: "turn-1" });
  });

  it("records the claimed replies spoken once the turn was heard, counts them, and skips the wordless ones", async () => {
    const store = claimStore([wordless, fourWorks]);
    const { speaker, metrics } = speakerOver(store);
    await speaker.claim(conversationId, await speaker.pending(conversationId));

    await speaker.settle(true);

    expect(store.speech.get(fourWorks.messageId)).toEqual({ state: "spoken" });
    expect(store.speech.get(wordless.messageId)).toEqual({ state: "skipped" });
    expect(speaker.spokenCount).toBe(1);
    expect(metrics.incrementCounter).toHaveBeenCalledWith("voice_operator_reply_spoken_total", expect.objectContaining({ value: 1 }));
  });

  it("hands the claimed replies back when the turn was not heard", async () => {
    const store = claimStore([fourWorks]);
    const { speaker, metrics } = speakerOver(store);
    await speaker.claim(conversationId, await speaker.pending(conversationId));

    await speaker.settle(false);

    expect(store.speech.get(fourWorks.messageId)).toEqual({ state: "pending" });
    expect(store.recordSpoken).not.toHaveBeenCalled();
    expect(speaker.spokenCount).toBe(0);
    expect(metrics.incrementCounter).not.toHaveBeenCalled();
  });

  it("speaks nothing another turn claimed first", async () => {
    const store = claimStore([fourWorks]);
    const first = speakerOver(store, { claimTurnId: "turn-1" }).speaker;
    const second = speakerOver(store, { claimTurnId: "turn-2" }).speaker;
    const pending = await first.pending(conversationId);

    await first.claim(conversationId, pending);
    const claimedLate = await second.claim(conversationId, pending);

    expect(claimedLate).toEqual([]);
    await second.settle(false);
    expect(store.speech.get(fourWorks.messageId)).toEqual({ state: "claimed", claimTurnId: "turn-1" });
  });

  it("settles nothing for a turn that took on no replies", () => {
    const { speaker } = speakerOver(claimStore([]));

    expect(speaker.settle(true)).toBeNull();
  });

  it("warns with the step and leaves the claim when a write fails", async () => {
    const store = claimStore([fourWorks]);
    store.claims.releaseOperatorReplies.mockRejectedValue(new Error("connection reset"));
    const { speaker, logger } = speakerOver(store);
    await speaker.claim(conversationId, await speaker.pending(conversationId));

    await speaker.settle(false);

    expect(logger.warn).toHaveBeenCalledWith(
      { agentId: session.agentId, vendor: "elevenlabs", conversationId, errorClass: "Error", step: "release" },
      "Voice turn could not update the teammate's pending replies",
    );
    expect(store.speech.get(fourWorks.messageId)).toEqual({ state: "claimed", claimTurnId: "turn-1" });
  });
});
