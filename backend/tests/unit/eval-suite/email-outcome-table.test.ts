import type { ConnectorTurnResult } from "@radioso/connector-api";
import { describe, expect, it } from "vitest";

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
  const h = createEmailReviewHarness({ supportedModes: ["operator_only", "draft"] });
  const mailbox = h.seedMailbox({ engagementMode: row.mode });
  const { conversationId } = await h.openThread(mailbox);
  if (row.ownership === "human_owned") {
    await h.ownership.requestHandoff({ conversationId, workspaceId: mailbox.workspaceId, reason: "operator_takeover" });
  }
  if (row.turn !== null) h.respond.mockResolvedValue(turnFor(row, conversationId));
  h.advance(60_000);
  await h.drain();
  return { h, conversationId };
};

/**
 * The Engagement Outcome Table's `operator_only` and `draft` rows (spec.md), structurally: each row's
 * review runs against a stub `respond`, and the decision, the held reply an operator sees, the
 * attention it leaves, and the customer-visible history are checked. No model runs, so this gates
 * every PR; nothing here may ever reach the customer.
 */
describe("Email engagement outcome table (operator_only and draft)", () => {
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
      expect(h.heldRows.of(conversationId)).toEqual([]);
    }

    // Not one row publishes: no send is queued and no send intent exists.
    expect(h.outbox).toEqual([]);

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

  it("covers every operator_only and draft row of the spec's table", () => {
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
    ]);
  });
});
