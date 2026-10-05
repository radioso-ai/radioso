import type { ConnectorTurnResult } from "@radioso/connector-api";
import { describe, expect, it } from "vitest";

import { emailSendKey } from "../../../src/modules/emailChannel/public.js";
import { emailOutcomeTable, type EmailOutcomeRow } from "../../fixtures/conversation-quality/emailOutcomeTable.js";
import { createEmailReviewHarness, REVIEW_PUBLISHABLE_FACTS, type EmailReviewHarness } from "../../support/inMemoryEmailReview.js";

const DRAFT_TEXT = "Your refund was issued on Monday and reaches your card within five days.";
const operator = { accountId: "account-1", workspaceId: "11111111-1111-4111-8111-111111111111", userId: "user-1" };

const turnFor = (row: EmailOutcomeRow, conversationId: string): ConnectorTurnResult => {
  const turn = row.turn;
  if (turn === null) throw new Error(`Row ${row.id} runs no turn`);
  if (turn.kind === "human_owned") return { kind: "human_owned", conversationId, ownershipVersion: 1 };
  const facts = { ...REVIEW_PUBLISHABLE_FACTS, ...turn.facts };
  return turn.kind === "draft"
    ? { kind: "draft", conversationId, ownershipVersion: 0, facts, draft: { text: DRAFT_TEXT, presentation: {} } }
    : { kind: "no_draft", conversationId, ownershipVersion: 0, facts };
};

/** One row's thread on a mailbox in the row's mode, reviewed once with the row's turn result. */
const review = async (row: EmailOutcomeRow): Promise<{ h: EmailReviewHarness; conversationId: string }> => {
  const h = createEmailReviewHarness({ supportedModes: ["operator_only", "draft", "auto"] });
  const mailbox = h.seedMailbox({ engagementMode: row.mode });
  const { conversationId } = await h.openThread(mailbox);
  if (row.sendBudget === "exhausted") {
    const link = h.threads.links.get(conversationId)!;
    h.threads.links.set(conversationId, { ...link, autoSendsSinceRenewal: mailbox.threadSendBudget });
  }
  if (row.ownership === "human_owned") {
    await h.ownership.requestHandoff({ conversationId, workspaceId: mailbox.workspaceId, reason: "operator_takeover" });
  }
  if (row.turn !== null) h.respond.mockResolvedValue(turnFor(row, conversationId));
  h.advance(60_000);
  await h.drain();
  return { h, conversationId };
};

/**
 * The Engagement Outcome Table (spec.md), structurally: each row's review runs against a stub
 * `respond`, and the decision, the held reply an operator sees, the send it queues, the attention it
 * leaves, and the customer-visible history are checked. No model runs, so this gates every PR. Only
 * the `auto` row that publishes queues a send, and even its draft stays out of history until the
 * send is dispatched (research B9).
 */
describe("Email engagement outcome table", () => {
  it.each(emailOutcomeTable.map((row) => [row.id, row] as const))("%s", async (_id, row) => {
    const { h, conversationId } = await review(row);
    const { expected } = row;

    expect(h.respond).toHaveBeenCalledTimes(expected.reviewAsked ? 1 : 0);
    expect(h.counted("email_publication_decisions_total")).toEqual(expected.decision ? [expected.decision] : []);

    const open = await h.heldReplies.list(operator, { attention: "open", limit: 10 });
    if (expected.heldReply) {
      expect(open.items).toEqual([expect.objectContaining({ conversationId, state: "pending", attentionOpen: true, ...expected.heldReply })]);
    } else {
      expect(open.items).toEqual([]);
      if (!expected.queuedAuto) expect(h.heldRows.of(conversationId)).toEqual([]);
    }

    if (expected.queuedAuto) {
      // Queued, not sent: the held reply waits for dispatch, asks no teammate, and one keyed send is queued.
      const [queued, ...others] = h.heldRows.of(conversationId);
      expect(others).toEqual([]);
      expect(queued).toMatchObject({ state: "queued_auto", attentionClearedAt: null });
      expect(h.outbox).toEqual([{ type: "email.send", idempotencyKey: emailSendKey.heldReply(queued.id) }]);
    } else {
      // No send is queued, so no send intent can exist.
      expect(h.outbox).toEqual([]);
    }

    const ownership = await h.ownership.load(conversationId);
    switch (expected.attention.kind) {
      case "approval":
        // A held reply asks for a decision; it never takes the conversation from the agent.
        expect(ownership).toBeNull();
        expect(h.handoffs).toEqual([]);
        break;
      case "human_owned":
        expect(h.handoffs).toEqual([{ conversationId, reason: expected.attention.reason }]);
        expect(ownership).toMatchObject({ state: "human_owned", reason: expected.attention.reason });
        break;
      case "unchanged":
        expect(h.handoffs).toEqual([]);
        break;
    }

    // The draft stays out of the customer-visible history: only the customer's message is there.
    expect(h.history.filter((message) => message.conversationId === conversationId).map((message) => message.role)).toEqual(["user"]);
    expect(h.history.some((message) => message.content === DRAFT_TEXT)).toBe(false);
  });

  it("holds or hands off every auto row that does not publish, and queues no send for it (SC-005)", () => {
    const auto = emailOutcomeTable.filter((row) => row.mode === "auto");
    expect(auto.filter((row) => row.expected.queuedAuto).map((row) => row.id)).toEqual(["auto-grounded-complete"]);
    for (const row of auto.filter((candidate) => !candidate.expected.queuedAuto)) {
      const heldOrHandedOff = row.expected.heldReply !== null || row.expected.attention.kind === "human_owned" || row.ownership === "human_owned";
      expect(heldOrHandedOff, row.id).toBe(true);
    }
  });

  it("covers every row of the spec's table", () => {
    expect(emailOutcomeTable.map((row) => row.id)).toEqual([
      "operator_only-accepted",
      "draft-grounded-complete",
      "draft-partial",
      "draft-no-context",
      "draft-out-of-scope",
      "draft-handoff-with-text",
      "draft-suppressed-effect",
      "draft-no-text-engine-reason",
      "draft-unavailable",
      "draft-human-owned-conversation",
      "auto-grounded-complete",
      "auto-budget-exhausted-grounded-complete",
      "auto-budget-exhausted-partial",
      "auto-partial",
      "auto-no-context",
      "auto-out-of-scope",
      "auto-handoff-with-text",
      "auto-suppressed-effect",
      "auto-no-text-engine-reason",
      "auto-unavailable",
      "auto-human-owned-conversation",
    ]);
  });
});
