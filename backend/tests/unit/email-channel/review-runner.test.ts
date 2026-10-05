import { describe, expect, it, vi } from "vitest";

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

    it("logs the completed review at info with its ids and outcome, never the draft", async () => {
      const { h, mailbox, conversationId } = await dueThread();
      h.respond.mockResolvedValue(h.draftTurn(conversationId, {}, "A draft only the teammate reads."));

      await h.drain();

      expect(h.logger.info).toHaveBeenCalledWith({
        conversationId,
        workspaceId: mailbox.workspaceId,
        mailboxId: mailbox.id,
        revision: 1,
        attempt: 1,
        outcome: "held",
        reviewAgain: false,
      }, "email_review_completed");
      expect(JSON.stringify(h.logger.info.mock.calls)).not.toContain("A draft only the teammate reads.");
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

  describe("automatic publication (research B9)", () => {
    const ALL_MODES = ["operator_only", "draft", "auto"] as const;

    /** An `auto` mailbox on a deployment that runs it, one thread, and the clock at its review. */
    const autoThread = async () => {
      const h = createEmailReviewHarness({ supportedModes: ALL_MODES });
      const mailbox = h.seedMailbox({ engagementMode: "auto" });
      const thread = await h.openThread(mailbox);
      h.advance(MINUTE_MS);
      return { h, mailbox, ...thread };
    };

    it("queues a publishable answer for an automatic send, bound to the policy and ownership the review ran under", async () => {
      const { h, mailbox, conversationId, messageId } = await autoThread();
      const turn = h.draftTurn(conversationId);
      h.respond.mockResolvedValue(turn);

      expect(await h.drain()).toMatchObject({ claimed: 1, queued_auto: 1, held: 0 });

      expect(h.queueAuto).toHaveBeenCalledExactlyOnceWith({
        workspaceId: mailbox.workspaceId,
        conversationId,
        agentId: mailbox.agentId,
        answersMessageId: messageId,
        ownershipVersion: 0,
        policy: { ref: emailMailboxPolicyRef(mailbox.id), version: 1 },
        reviewRef: `email:${conversationId}:1`,
        facts: turn.kind === "draft" ? turn.facts : never(),
        draft: turn.kind === "draft" ? turn.draft : never(),
      });
      expect(h.hold).not.toHaveBeenCalled();
      const [queued] = h.heldRows.of(conversationId);
      expect(h.heldRows.of(conversationId)).toEqual([expect.objectContaining({ state: "queued_auto", reviewRef: `email:${conversationId}:1` })]);
      expect(h.outbox).toEqual([{ type: "email.send", idempotencyKey: `email:send:held:${queued.id}` }]);
      expect(h.threads.links.get(conversationId)).toMatchObject({ autoSendsSinceRenewal: 1, reviewDueAt: null, reviewCompletedRevision: 1 });
      expect(h.counted("email_publication_decisions_total")).toEqual([{ decision: "publish", reason: "none" }]);
      // Nothing reaches the customer-visible history until the send is materialized at dispatch.
      expect(h.history.map((message) => message.role)).toEqual(["user"]);
    });

    it.each([
      ["ownership_changed", "authority_changed"],
      ["policy_changed", "authority_changed"],
      ["send_budget", "send_budget"],
      ["superseded", "authority_changed"],
    ] as const)("holds the answer for a teammate when queueing is refused with %s, as %s", async (refused, holdReason) => {
      const { h, mailbox, conversationId, messageId } = await autoThread();
      const turn = h.draftTurn(conversationId);
      h.respond.mockResolvedValue(turn);
      h.queueAuto.mockResolvedValueOnce({ ok: false, refused });

      expect(await h.drain()).toMatchObject({ claimed: 1, held: 1, queued_auto: 0 });

      expect(h.hold).toHaveBeenCalledExactlyOnceWith({
        workspaceId: mailbox.workspaceId,
        conversationId,
        agentId: mailbox.agentId,
        answersMessageId: messageId,
        ownershipVersion: 0,
        policy: { ref: emailMailboxPolicyRef(mailbox.id), version: 1 },
        reviewRef: `email:${conversationId}:1`,
        holdReason,
        facts: turn.kind === "draft" ? turn.facts : never(),
        draft: turn.kind === "draft" ? turn.draft : never(),
      });
      expect(h.outbox).toEqual([]);
      expect(h.counted("email_auto_queue_refusals_total")).toEqual([{ refused }]);
    });

    it("holds as send_budget, with no send queued, once the thread's sends are spent", async () => {
      const { h, mailbox, conversationId } = await autoThread();
      h.threads.links.set(conversationId, { ...h.threads.links.get(conversationId)!, autoSendsSinceRenewal: mailbox.threadSendBudget });
      h.respond.mockResolvedValue(h.draftTurn(conversationId));

      await h.drain();

      expect(h.queueAuto).not.toHaveBeenCalled();
      expect(h.heldRows.of(conversationId)).toEqual([expect.objectContaining({ state: "pending", holdReason: "send_budget" })]);
      expect(h.outbox).toEqual([]);
    });

    it("holds a result that is not publishable with its outcome labelled, and queues nothing", async () => {
      const { h, conversationId } = await autoThread();
      h.respond.mockResolvedValue(h.draftTurn(conversationId, { coverage: "partial" }));

      await h.drain();

      expect(h.queueAuto).not.toHaveBeenCalled();
      expect(h.heldRows.of(conversationId)).toEqual([expect.objectContaining({ state: "pending", holdReason: "outcome_not_publishable" })]);
      expect(h.outbox).toEqual([]);
    });

    it("never queues on a mailbox in auto while the deployment does not run auto", async () => {
      const h = createEmailReviewHarness({ supportedModes: ["operator_only", "draft"] });
      const mailbox = h.seedMailbox({ engagementMode: "auto" });
      const { conversationId } = await h.openThread(mailbox);
      h.advance(MINUTE_MS);
      h.respond.mockResolvedValue(h.draftTurn(conversationId));

      await h.drain();

      expect(h.queueAuto).not.toHaveBeenCalled();
      expect(h.heldRows.of(conversationId)).toEqual([expect.objectContaining({ state: "pending", holdReason: "draft_mode" })]);
    });

    it("completes a revision already queued without a second turn or a second send, after a crash before completion", async () => {
      const { h, conversationId } = await autoThread();
      h.respond.mockResolvedValue(h.draftTurn(conversationId));
      const completeReview = vi.spyOn(h.threads, "completeReview").mockRejectedValueOnce(new Error("connection reset"));

      expect(await h.drain()).toMatchObject({ retrying: 1 });
      h.advance(30_000);
      expect(await h.drain()).toMatchObject({ already_held: 1 });

      expect(h.respond).toHaveBeenCalledOnce();
      expect(h.outbox).toHaveLength(1);
      expect(h.threads.links.get(conversationId)).toMatchObject({ autoSendsSinceRenewal: 1, reviewDueAt: null, reviewCompletedRevision: 1 });
      expect(completeReview).toHaveBeenCalledTimes(2);
    });
  });

  describe("the reply triage (FR-017a)", () => {
    it("asks before the turn whether the revision's mail needs a reply, with the revision's ids", async () => {
      const { h, mailbox, conversationId } = await dueThread();
      h.respond.mockResolvedValue(h.draftTurn(conversationId));

      await h.drain();

      expect(h.replyTriage).toHaveBeenCalledExactlyOnceWith({
        workspaceId: mailbox.workspaceId,
        agentId: mailbox.agentId,
        conversationId,
        revision: 1,
        attempt: 1,
      });
      expect(h.replyTriage.mock.invocationCallOrder[0]).toBeLessThan(h.respond.mock.invocationCallOrder[0]);
    });

    it.each(["draft", "auto"] as const)(
      "runs no turn, holds nothing and asks no teammate on a %s mailbox when the mail needs no reply, and notes the thread",
      async (engagementMode) => {
        const h = createEmailReviewHarness({ supportedModes: ["operator_only", "draft", "auto"] });
        const mailbox = h.seedMailbox({ engagementMode });
        const { conversationId, messageId } = await h.openThread(mailbox);
        h.advance(MINUTE_MS);
        h.replyTriage.mockResolvedValue("no");

        expect(await h.drain()).toMatchObject({ claimed: 1, no_reply_needed: 1, held: 0, queued_auto: 0 });

        expect(h.respond).not.toHaveBeenCalled();
        expect(h.replyCompleteness).not.toHaveBeenCalled();
        expect(h.heldRows.of(conversationId)).toEqual([]);
        expect(h.handoffs).toEqual([]);
        expect(await h.ownership.load(conversationId)).toBeNull();
        expect(h.outbox).toEqual([]);
        expect(h.notes).toEqual([{ conversationId, messageId, code: "no_reply_needed" }]);
        // The revision is done, and the thread's automatic sends are untouched.
        expect(h.threads.links.get(conversationId)).toMatchObject({ reviewDueAt: null, reviewCompletedRevision: 1, autoSendsSinceRenewal: 0 });
        expect(h.logger.info).toHaveBeenCalledWith(expect.objectContaining({ conversationId, outcome: "no_reply_needed" }), "email_review_completed");
      },
    );

    it.each(["yes", "unsure", "unavailable"] as const)("runs the review as before when the triage says %s", async (verdict) => {
      const { h, conversationId } = await dueThread();
      h.replyTriage.mockResolvedValue(verdict);
      h.respond.mockResolvedValue(h.draftTurn(conversationId));

      expect(await h.drain()).toMatchObject({ claimed: 1, held: 1, no_reply_needed: 0 });

      expect(h.respond).toHaveBeenCalledOnce();
      expect(h.notes).toEqual([]);
    });

    it("does not triage a conversation a person owns, and leaves it to them", async () => {
      const { h, mailbox, conversationId } = await dueThread();
      await h.ownership.requestHandoff({ conversationId, workspaceId: mailbox.workspaceId, reason: "operator_takeover" });
      h.respond.mockResolvedValue({ kind: "human_owned", conversationId, ownershipVersion: 1 });
      h.replyTriage.mockResolvedValue("no");

      expect(await h.drain()).toMatchObject({ claimed: 1, human_owned: 1 });

      expect(h.replyTriage).not.toHaveBeenCalled();
      expect(h.notes).toEqual([]);
    });

    it("does not triage mail on a mailbox that no longer lets the agent answer", async () => {
      const h = createEmailReviewHarness();
      const mailbox = h.seedMailbox({ engagementMode: "operator_only" });
      await h.openThread(mailbox);
      h.advance(MINUTE_MS);

      await h.drain();

      expect(h.replyTriage).not.toHaveBeenCalled();
      expect(h.respond).not.toHaveBeenCalled();
    });
  });

  describe("the completeness check (FR-020)", () => {
    const autoThread = async () => {
      const h = createEmailReviewHarness({ supportedModes: ["operator_only", "draft", "auto"] });
      const mailbox = h.seedMailbox({ engagementMode: "auto" });
      const thread = await h.openThread(mailbox);
      h.advance(MINUTE_MS);
      return { h, mailbox, ...thread };
    };

    it("checks a reply every other gate would publish, once, with the draft, and publishes it when complete", async () => {
      const { h, mailbox, conversationId } = await autoThread();
      const turn = h.draftTurn(conversationId);
      h.respond.mockResolvedValue(turn);

      expect(await h.drain()).toMatchObject({ queued_auto: 1 });

      expect(h.replyCompleteness).toHaveBeenCalledExactlyOnceWith({
        workspaceId: mailbox.workspaceId,
        agentId: mailbox.agentId,
        conversationId,
        revision: 1,
        attempt: 1,
        draft: turn.kind === "draft" ? turn.draft : never(),
      });
    });

    it.each([
      ["partial", "partial"],
      ["not_answered", "unanswered"],
      ["unavailable", "unavailable"],
    ] as const)("holds a %s reply as incomplete_answer, its coverage shown as %s, and queues nothing", async (completeness, coverage) => {
      const { h, conversationId } = await autoThread();
      h.respond.mockResolvedValue(h.draftTurn(conversationId));
      h.replyCompleteness.mockResolvedValue({ completeness, unansweredAsks: completeness === "unavailable" ? null : 1 });

      expect(await h.drain()).toMatchObject({ held: 1, queued_auto: 0 });

      expect(h.queueAuto).not.toHaveBeenCalled();
      expect(h.heldRows.of(conversationId)).toEqual([expect.objectContaining({
        state: "pending",
        holdReason: "incomplete_answer",
        facts: expect.objectContaining({ grounding: "grounded", coverage }),
      })]);
      expect(h.outbox).toEqual([]);
      expect(h.counted("email_publication_decisions_total")).toEqual([{ decision: "hold", reason: "incomplete_answer" }]);
    });

    it("never checks a draft mailbox's reply: the mode holds it first", async () => {
      const { h, conversationId } = await dueThread({ supportedModes: ["operator_only", "draft", "auto"] });
      h.respond.mockResolvedValue(h.draftTurn(conversationId));

      await h.drain();

      expect(h.replyCompleteness).not.toHaveBeenCalled();
      expect(h.heldRows.of(conversationId)).toEqual([expect.objectContaining({ holdReason: "draft_mode", facts: expect.objectContaining({ coverage: "answered" }) })]);
    });

    it("never checks an auto reply an earlier gate holds", async () => {
      const { h, mailbox, conversationId } = await autoThread();
      h.threads.links.set(conversationId, { ...h.threads.links.get(conversationId)!, autoSendsSinceRenewal: mailbox.threadSendBudget });
      h.respond.mockResolvedValue(h.draftTurn(conversationId));

      await h.drain();

      expect(h.replyCompleteness).not.toHaveBeenCalled();
      expect(h.heldRows.of(conversationId)).toEqual([expect.objectContaining({ holdReason: "send_budget" })]);
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

  describe("the generation budget (FR-023, research B8)", () => {
    it("hands the thread off as generation_budget, running no turn, once the mailbox's generation budget is spent", async () => {
      const h = createEmailReviewHarness();
      const mailbox = h.seedMailbox({ hourlyGenerationBudget: 1 });
      const generated = await h.openThread(mailbox);
      const refused = await h.openThread(mailbox);
      h.advance(MINUTE_MS);
      h.respond.mockImplementation(async (input) => h.draftTurn(input.conversationId));

      expect(await h.drain()).toMatchObject({ claimed: 2, held: 1, budget_exhausted: 1 });

      expect(h.respond).toHaveBeenCalledOnce();
      expect(h.respond).toHaveBeenCalledWith(expect.objectContaining({ conversationId: generated.conversationId }));
      expect(h.handoffs).toEqual([{ conversationId: refused.conversationId, reason: "generation_budget" }]);
      expect(h.heldRows.of(refused.conversationId)).toEqual([]);
      expect(h.threads.links.get(refused.conversationId)).toMatchObject({ reviewDueAt: null, reviewCompletedRevision: 1 });
      expect(h.counted("email_budget_hits_total")).toEqual([{ budget: "mailbox_generation" }]);
      expect(h.mailboxes.records.get(mailbox.id)).toMatchObject({ generationWindowCount: 1 });
    });

    it("charges a revision once, however many attempts its review takes", async () => {
      const { h, mailbox, conversationId } = await dueThread();
      h.mailboxes.records.set(mailbox.id, { ...mailbox, hourlyGenerationBudget: 1 });
      h.respond.mockRejectedValueOnce(new Error("model timeout"));
      h.respond.mockResolvedValueOnce(h.draftTurn(conversationId));

      expect(await h.drain()).toMatchObject({ retrying: 1 });
      h.advance(30_000);
      expect(await h.drain()).toMatchObject({ held: 1 });

      expect(h.respond).toHaveBeenCalledTimes(2);
      expect(h.handoffs).toEqual([]);
      expect(h.counted("email_budget_hits_total")).toEqual([]);
      expect(h.mailboxes.records.get(mailbox.id)).toMatchObject({ generationWindowCount: 1 });
    });

    it("charges the thread's next revision again: newer mail meets the spent budget and goes to a person", async () => {
      const { h, mailbox, conversationId } = await dueThread();
      h.mailboxes.records.set(mailbox.id, { ...mailbox, hourlyGenerationBudget: 1 });
      h.respond.mockResolvedValue(h.draftTurn(conversationId));
      await h.drain();

      await h.receive(conversationId, "Any news?");
      h.advance(MINUTE_MS);
      expect(await h.drain()).toMatchObject({ claimed: 1, budget_exhausted: 1 });

      expect(h.respond).toHaveBeenCalledOnce();
      expect(h.handoffs).toEqual([{ conversationId, reason: "generation_budget" }]);
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
