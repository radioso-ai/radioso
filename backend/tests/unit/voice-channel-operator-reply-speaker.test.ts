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
  const settle = (to: Speech) => vi.fn(async ({ messageIds, claimTurnId }: { messageIds: string[]; claimTurnId: string }) =>
    messageIds.filter((messageId) => {
      const current = speech.get(messageId);
      if (current?.state !== "claimed" || current.claimTurnId !== claimTurnId) return false;
      speech.set(messageId, to);
      return true;
    }));
  return {
    speech,
    claims: {
      claimPendingOperatorReplies: vi.fn(async ({ claimTurnId }: { claimTurnId: string }) =>
        replies.filter((reply) => {
          if (speech.get(reply.messageId)?.state !== "pending") return false;
          speech.set(reply.messageId, { state: "claimed", claimTurnId });
          return true;
        })),
      markOperatorRepliesSpoken: settle({ state: "spoken" }),
      skipOperatorReplies: settle({ state: "skipped" }),
      releaseOperatorReplies: settle({ state: "pending" }),
    },
  };
};

const speakerOver = (store: ReturnType<typeof claimStore>, overrides: { claimTurnId?: string; withoutAudit?: boolean } = {}) => {
  const logger = { warn: vi.fn() };
  const metrics = { observeHistogram: vi.fn(), incrementCounter: vi.fn() };
  const audit = vi.fn(async () => undefined);
  const speaker = new OperatorReplySpeaker({
    replies: { claims: store.claims, newClaimTurnId: () => overrides.claimTurnId ?? "turn-1" },
    ...(overrides.withoutAudit ? {} : { audit }),
    withinTimeout: (write) => write,
    logger,
    metrics,
  }, session);
  return { speaker, logger, metrics, audit };
};

describe("operator reply speaker", () => {
  it("claims the pending replies in one write and speaks those with words as pieces that are never the last", async () => {
    const store = claimStore([wordless, fourWorks]);
    const { speaker } = speakerOver(store);

    const claimed = await speaker.claim(conversationId);

    expect([...speaker.speech(claimed)]).toEqual([
      { type: "speech", text: "Yes, four works. ", last: false },
      { type: "speech", text: "Bring your card\n", last: false },
    ]);
    expect(store.claims.claimPendingOperatorReplies).toHaveBeenCalledWith({ workspaceId, conversationId, claimTurnId: "turn-1" });
    expect(store.speech.get(fourWorks.messageId)).toEqual({ state: "claimed", claimTurnId: "turn-1" });
    expect(speaker.holdsClaims).toBe(true);
  });

  it("records the claimed replies spoken once the caller heard them through, then counts and audits them, and skips the wordless ones", async () => {
    const store = claimStore([wordless, fourWorks]);
    const { speaker, metrics, audit } = speakerOver(store);
    await speaker.claim(conversationId);

    // Both pieces of the reply were heard through.
    await speaker.settle(2);

    expect(store.speech.get(fourWorks.messageId)).toEqual({ state: "spoken" });
    expect(store.speech.get(wordless.messageId)).toEqual({ state: "skipped" });
    expect(speaker.spokenCount).toBe(1);
    expect(metrics.incrementCounter).toHaveBeenCalledWith("voice_operator_reply_spoken_total", expect.objectContaining({ value: 1 }));
    expect(audit).toHaveBeenCalledWith({ workspaceId, conversationId, messageIds: [fourWorks.messageId] });
    expect(speaker.holdsClaims).toBe(false);
  });

  it("settles its claims without an audit to write", async () => {
    const store = claimStore([fourWorks]);
    const { speaker } = speakerOver(store, { withoutAudit: true });
    await speaker.claim(conversationId);

    await speaker.settle(2);

    expect(store.speech.get(fourWorks.messageId)).toEqual({ state: "spoken" });
    expect(speaker.spokenCount).toBe(1);
  });

  it("hands the claimed replies back when the caller did not hear them through, and keeps that first decision", async () => {
    const store = claimStore([fourWorks]);
    const { speaker, metrics, audit } = speakerOver(store);
    await speaker.claim(conversationId);

    // The caller spoke over the reply's last piece.
    await speaker.settle(1);
    await speaker.settle(2);

    expect(store.speech.get(fourWorks.messageId)).toEqual({ state: "pending" });
    expect(store.claims.markOperatorRepliesSpoken).not.toHaveBeenCalled();
    expect(speaker.spokenCount).toBe(0);
    expect(metrics.incrementCounter).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("records spoken the replies the caller heard through and hands back the one they cut into, or all when the turn failed", async () => {
    const bringCard = { messageId: "reply-card", text: "Bring your card." };
    const store = claimStore([fourWorks, bringCard]);
    const { speaker, audit } = speakerOver(store);
    await speaker.claim(conversationId);

    // The first reply's two pieces were heard through; the caller spoke over the second reply.
    await speaker.settle(2);

    expect(store.speech.get(fourWorks.messageId)).toEqual({ state: "spoken" });
    expect(store.speech.get(bringCard.messageId)).toEqual({ state: "pending" });
    expect(audit).toHaveBeenCalledWith({ workspaceId, conversationId, messageIds: [fourWorks.messageId] });

    const failedStore = claimStore([fourWorks]);
    const failed = speakerOver(failedStore).speaker;
    await failed.claim(conversationId);
    await failed.settle(null);
    expect(failedStore.speech.get(fourWorks.messageId)).toEqual({ state: "pending" });
  });

  it("settles a claim still being written once it lands", async () => {
    const store = claimStore([fourWorks]);
    let land!: () => void;
    const landed = new Promise<void>((resolve) => { land = resolve; });
    const claimPending = store.claims.claimPendingOperatorReplies.getMockImplementation()!;
    store.claims.claimPendingOperatorReplies.mockImplementation(async (input) => {
      await landed;
      return claimPending(input);
    });
    const { speaker } = speakerOver(store);

    const claiming = speaker.claim(conversationId);
    const settled = speaker.settle(0);
    land();
    await Promise.all([claiming, settled]);

    expect(store.speech.get(fourWorks.messageId)).toEqual({ state: "pending" });
  });

  it("speaks nothing another turn claimed first, and claims once", async () => {
    const store = claimStore([fourWorks]);
    const first = speakerOver(store, { claimTurnId: "turn-1" }).speaker;
    const second = speakerOver(store, { claimTurnId: "turn-2" }).speaker;

    await first.claim(conversationId);
    expect(await second.claim(conversationId)).toEqual([]);
    await first.settle(0);
    expect(await second.claim(conversationId)).toEqual([]);

    expect(store.claims.claimPendingOperatorReplies).toHaveBeenCalledTimes(2);
  });

  it("settles nothing for a turn that claimed nothing", () => {
    const { speaker } = speakerOver(claimStore([]));

    expect(speaker.settle(0)).toBeNull();
    expect(speaker.holdsClaims).toBe(false);
  });

  it("warns with the step and leaves the claim to expire when a write fails", async () => {
    const store = claimStore([fourWorks]);
    store.claims.releaseOperatorReplies.mockRejectedValue(new Error("connection reset"));
    const { speaker, logger } = speakerOver(store);
    await speaker.claim(conversationId);

    await speaker.settle(0);

    expect(logger.warn).toHaveBeenCalledWith(
      { agentId: session.agentId, vendor: "elevenlabs", conversationId, errorClass: "Error", step: "release" },
      "Voice turn could not update the teammate's pending replies",
    );
    expect(store.speech.get(fourWorks.messageId)).toEqual({ state: "claimed", claimTurnId: "turn-1" });
  });
});
