import { describe, expect, it } from "vitest";

import { emailMailboxPolicyRef } from "../../../src/modules/emailChannel/public.js";
import { createEmailReviewHarness, REVIEW_PUBLISHABLE_FACTS } from "../../support/inMemoryEmailReview.js";

const MINUTE_MS = 60_000;

/** A draft mailbox, one thread on it, and the clock moved to its review's due time. */
const dueThread = async (options: Parameters<typeof createEmailReviewHarness>[0] = {}) => {
  const h = createEmailReviewHarness(options);
  const mailbox = h.seedMailbox();
  const thread = await h.openThread(mailbox);
  h.advance(MINUTE_MS);
  return { h, mailbox, ...thread };
};

describe("EmailReviewRunner", () => {
  describe("claiming", () => {
    it("claims a review only once it is due, under a lease, and reviews the revision it read", async () => {
      const h = createEmailReviewHarness();
      const mailbox = h.seedMailbox();
      const { conversationId } = await h.openThread(mailbox);
      h.respond.mockImplementation(async () => {
        // Leased while it runs: a concurrent drain claims nothing.
        expect(await h.threads.claimDueReviews({ limit: 10, leaseSeconds: 300 })).toEqual([]);
        return h.draftTurn(conversationId);
      });

      expect(await h.drain()).toMatchObject({ claimed: 0 });
      expect(h.respond).not.toHaveBeenCalled();

      h.advance(MINUTE_MS);
      expect(await h.drain()).toMatchObject({ claimed: 1, held: 1 });

      expect(h.respond).toHaveBeenCalledOnce();
      expect(h.heldRows.of(conversationId)).toEqual([expect.objectContaining({ reviewRef: `email:${conversationId}:1`, state: "pending" })]);
      expect(h.threads.links.get(conversationId)).toMatchObject({ reviewDueAt: null, reviewCompletedRevision: 1, reviewAttempts: 0 });
      expect(await h.drain()).toMatchObject({ claimed: 0 });
    });

    it("skips the model when the revision's review ref is already held, and only completes", async () => {
      const { h, mailbox, conversationId, messageId } = await dueThread();
      // A worker held the revision's draft, then died before completing it.
      await h.heldReplies.hold({
        workspaceId: mailbox.workspaceId,
        conversationId,
        agentId: mailbox.agentId,
        answersMessageId: messageId,
        ownershipVersion: 0,
        policy: { ref: emailMailboxPolicyRef(mailbox.id), version: mailbox.policyVersion },
        reviewRef: `email:${conversationId}:1`,
        holdReason: "draft_mode",
        facts: REVIEW_PUBLISHABLE_FACTS,
        draft: { text: "Held before the crash.", presentation: {} },
      });

      expect(await h.drain()).toMatchObject({ claimed: 1, already_held: 1 });

      expect(h.respond).not.toHaveBeenCalled();
      expect(h.heldRows.of(conversationId)).toHaveLength(1);
      expect(h.threads.links.get(conversationId)).toMatchObject({ reviewDueAt: null, reviewCompletedRevision: 1 });
    });
  });

  describe("the turn", () => {
    it("asks respond for a review of the newest customer message with the mailbox's history window", async () => {
      const { h, mailbox, conversationId } = await dueThread();
      const newest = await h.receive(conversationId, "Also, can I change the address?");
      h.respond.mockResolvedValue(h.draftTurn(conversationId));

      await h.drain();

      expect(h.respond).toHaveBeenCalledWith({
        workspaceId: mailbox.workspaceId,
        agentId: mailbox.agentId,
        conversationId,
        respondToMessageId: newest,
        executionMode: "review",
        historyWindow: { maxMessages: mailbox.threadContextMessages },
      });
    });

    it("supersedes the previous pending draft before it holds the new one", async () => {
      const { h, conversationId } = await dueThread();
      h.respond.mockResolvedValue(h.draftTurn(conversationId, {}, "First draft."));
      await h.drain();

      await h.receive(conversationId, "Any news?");
      h.advance(MINUTE_MS);
      h.respond.mockResolvedValue(h.draftTurn(conversationId, {}, "Second draft."));
      await h.drain();

      expect(h.heldRows.of(conversationId).map((row) => [row.draft.text, row.state, row.supersededReason])).toEqual([
        ["First draft.", "superseded", "newer_inbound"],
        ["Second draft.", "pending", null],
      ]);
    });

    it("holds a draft bound to the policy and ownership the review ran under, with the decision's reason", async () => {
      const { h, mailbox, conversationId, messageId } = await dueThread();
      const turn = h.draftTurn(conversationId, { coverage: "partial" });
      h.respond.mockResolvedValue(turn);

      await h.drain();

      expect(h.hold).toHaveBeenCalledWith({
        workspaceId: mailbox.workspaceId,
        conversationId,
        agentId: mailbox.agentId,
        answersMessageId: messageId,
        ownershipVersion: 0,
        policy: { ref: emailMailboxPolicyRef(mailbox.id), version: 1 },
        reviewRef: `email:${conversationId}:1`,
        holdReason: "draft_mode",
        facts: turn.kind === "draft" ? turn.facts : never(),
        draft: turn.kind === "draft" ? turn.draft : never(),
      });
      expect(h.counted("email_publication_decisions_total")).toEqual([{ decision: "hold", reason: "draft_mode" }]);
      expect(h.counted("email_review_turns_total")).toEqual([{ result: "reply", grounding: "grounded", coverage: "partial" }]);
    });

    it("holds as sending_not_verified while the mailbox's domain cannot send (FR-004)", async () => {
      const { h, conversationId } = await dueThread({ sendingStatus: "pending" });
      h.respond.mockResolvedValue(h.draftTurn(conversationId));

      await h.drain();

      expect(h.heldRows.of(conversationId)).toEqual([expect.objectContaining({ state: "pending", holdReason: "sending_not_verified" })]);
    });

    it("holds a draft whose policy moved during the turn as superseded, and reviews again under the new policy", async () => {
      const { h, mailbox, conversationId } = await dueThread();
      h.respond.mockImplementationOnce(async () => {
        await h.mailboxes.appendPolicyVersion({
          mailboxId: mailbox.id,
          expectedVersion: 1,
          engagementMode: "draft",
          enabled: true,
          agentId: mailbox.agentId,
          changedByUserId: null,
        });
        return h.draftTurn(conversationId, {}, "Under the old policy.");
      });
      h.respond.mockResolvedValueOnce(h.draftTurn(conversationId, {}, "Under the new policy."));

      await h.drain();
      expect(h.heldRows.of(conversationId)).toEqual([
        expect.objectContaining({ state: "superseded", supersededReason: "policy_changed", holdReason: "authority_changed" }),
      ]);
      expect(h.threads.links.get(conversationId)).toMatchObject({ reviewRevision: 2, reviewCompletedRevision: 0 });
      expect(h.requestDrain).toHaveBeenCalledWith({ maxJobs: expect.any(Number), stage: "review" });

      await h.drain();
      expect(h.heldRows.of(conversationId).at(-1)).toMatchObject({
        state: "pending",
        policy: { ref: emailMailboxPolicyRef(mailbox.id), version: 2 },
        draft: expect.objectContaining({ text: "Under the new policy." }),
      });
      expect(h.threads.links.get(conversationId)).toMatchObject({ reviewDueAt: null, reviewCompletedRevision: 2 });
    });

    it("runs no turn once the mailbox no longer lets the agent answer, and hands the thread to a person", async () => {
      const { h, mailbox, conversationId } = await dueThread();
      await h.mailboxes.appendPolicyVersion({
        mailboxId: mailbox.id,
        expectedVersion: 1,
        engagementMode: "operator_only",
        enabled: true,
        agentId: mailbox.agentId,
        changedByUserId: null,
      });

      expect(await h.drain()).toMatchObject({ claimed: 1, not_runnable: 1 });

      expect(h.respond).not.toHaveBeenCalled();
      expect(h.handoffs).toEqual([{ conversationId, reason: "operator_only_mailbox" }]);
      expect(h.threads.links.get(conversationId)).toMatchObject({ reviewDueAt: null, reviewCompletedRevision: 1 });
    });

    it("never runs a draft review on a mailbox whose accepted policy was upgraded past the deployment's modes", async () => {
      const { h, conversationId } = await dueThread({ supportedModes: ["operator_only"] });

      await h.drain();

      expect(h.respond).not.toHaveBeenCalled();
      expect(h.handoffs).toEqual([{ conversationId, reason: "operator_only_mailbox" }]);
    });
  });

  describe("results without a draft", () => {
    it("hands a draftless turn to a person with the engine's reason", async () => {
      const { h, conversationId } = await dueThread();
      h.respond.mockResolvedValue({
        kind: "no_draft",
        conversationId,
        ownershipVersion: 0,
        facts: { outcome: "unavailable", grounding: "unknown", coverage: "not_assessed", handoff: { requested: true, reason: "customer_requested_human" }, suppressedEffects: [], citationCount: 0 },
      });

      expect(await h.drain()).toMatchObject({ no_draft: 1 });

      expect(h.handoffs).toEqual([{ conversationId, reason: "customer_requested_human" }]);
      expect(h.heldRows.of(conversationId)).toEqual([]);
      expect(h.counted("email_publication_decisions_total")).toEqual([{ decision: "no_reply", reason: "customer_requested_human" }]);
    });

    it("hands a draftless turn with no engine reason off as review_unavailable", async () => {
      const { h, conversationId } = await dueThread();
      h.respond.mockResolvedValue({
        kind: "no_draft",
        conversationId,
        ownershipVersion: 0,
        facts: { outcome: "unavailable", grounding: "unknown", coverage: "unavailable", handoff: { requested: false }, suppressedEffects: [], citationCount: 0 },
      });

      await h.drain();

      expect(h.handoffs).toEqual([{ conversationId, reason: "review_unavailable" }]);
    });

    it("does nothing for a conversation a person owns", async () => {
      const { h, conversationId } = await dueThread();
      h.respond.mockResolvedValue({ kind: "human_owned", conversationId, ownershipVersion: 1 });

      expect(await h.drain()).toMatchObject({ human_owned: 1 });

      expect(h.handoffs).toEqual([]);
      expect(h.heldRows.of(conversationId)).toEqual([]);
      expect(h.threads.links.get(conversationId)).toMatchObject({ reviewDueAt: null, reviewCompletedRevision: 1 });
    });
  });

  describe("completion", () => {
    it("completes only its own revision: newer mail during the turn keeps its due time, and its review runs next", async () => {
      const { h, conversationId } = await dueThread();
      h.respond.mockImplementationOnce(async () => {
        await h.receive(conversationId, "One more thing.");
        return h.draftTurn(conversationId, {}, "Answers the first message.");
      });
      h.respond.mockResolvedValueOnce(h.draftTurn(conversationId, {}, "Answers both."));

      await h.drain();

      const link = h.threads.links.get(conversationId)!;
      expect(link).toMatchObject({ reviewRevision: 2, reviewCompletedRevision: 0 });
      expect(link.reviewDueAt).not.toBeNull();
      expect(h.heldRows.of(conversationId)).toEqual([expect.objectContaining({ state: "superseded", supersededReason: "newer_inbound" })]);
      // The overtaken claim lets go at once, and a drain is asked for the newer revision.
      expect(h.threads.reviewLeases.has(conversationId)).toBe(false);
      expect(h.requestDrain).toHaveBeenCalledWith({ maxJobs: expect.any(Number), stage: "review" });

      await h.drain();
      expect(h.heldRows.of(conversationId).filter((row) => row.state === "pending")).toEqual([
        expect.objectContaining({ reviewRef: `email:${conversationId}:2`, draft: expect.objectContaining({ text: "Answers both." }) }),
      ]);
      expect(h.threads.links.get(conversationId)).toMatchObject({ reviewDueAt: null, reviewCompletedRevision: 2 });
    });
  });

  describe("failures", () => {
    it("retries a failed review at the backoff time and asks for a drain then", async () => {
      const { h, conversationId } = await dueThread();
      h.respond.mockRejectedValue(new Error("model timeout"));

      expect(await h.drain()).toMatchObject({ retrying: 1 });
      const firstRetry = new Date(h.clock().getTime() + 30_000);
      expect(h.threads.links.get(conversationId)?.reviewDueAt).toEqual(firstRetry);
      expect(h.threads.reviewErrors.get(conversationId)).toBe("review_failed");
      expect(h.requestDrain).toHaveBeenLastCalledWith({ maxJobs: expect.any(Number), stage: "review", scheduleAt: firstRetry });
      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId, attempt: 1, errorName: "Error" }),
        "email_review_turn_failed",
      );

      h.advance(30_000);
      await h.drain();
      const secondRetry = new Date(h.clock().getTime() + 120_000);
      expect(h.threads.links.get(conversationId)?.reviewDueAt).toEqual(secondRetry);
      expect(h.counted("email_review_turns_total")).toEqual([
        { result: "error", grounding: "none", coverage: "none" },
        { result: "error", grounding: "none", coverage: "none" },
      ]);
    });

    it("hands the thread off as review_unavailable after the last attempt fails", async () => {
      const { h, conversationId } = await dueThread({ maxAttempts: 2 });
      h.respond.mockRejectedValue(new Error("model timeout"));

      await h.drain();
      h.advance(30_000);
      expect(await h.drain()).toMatchObject({ failed: 1 });

      expect(h.handoffs).toEqual([{ conversationId, reason: "review_unavailable" }]);
      expect(h.threads.links.get(conversationId)).toMatchObject({ reviewDueAt: null, reviewCompletedRevision: 1 });
      expect(h.heldRows.of(conversationId)).toEqual([]);
    });
  });
});

const never = (): never => {
  throw new Error("unreachable");
};
