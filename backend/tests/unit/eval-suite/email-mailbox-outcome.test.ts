import type { ConnectorTurnResult } from "@radioso/connector-api";
import { describe, expect, it } from "vitest";

import { emailOutcomeTable, type EmailOutcomeRow } from "../../fixtures/conversation-quality/emailOutcomeTable.js";
import {
  classifyEmailOutcome,
  EmailOutcomeUnsettled,
  heldReplySummaryOf,
  ownershipSummaryOf,
  type EmailBusinessOutcome,
  type EmailOutcomeEvidence,
  type SentEmailSummary,
} from "../../support/emailMailboxOutcome.js";
import { createEmailReviewHarness, REVIEW_PUBLISHABLE_FACTS } from "../../support/inMemoryEmailReview.js";

// The mailbox behaviour harness reports a business outcome per inbound email: sent, drafted,
// silent or handed off. These checks pin its mapping to the real review runner: each row of the
// spec's Engagement Outcome Table runs through the runner with a stub `respond`, the harness's
// evidence is built from the records the runner left, and the mapping must name the outcome the
// row's own expectation implies. No model runs.

const DRAFT_TEXT = "Standard shipping within the EU costs 4.90 EUR.";

const turnFor = (row: EmailOutcomeRow, conversationId: string): ConnectorTurnResult => {
  const turn = row.turn;
  if (turn === null) throw new Error(`Row ${row.id} runs no turn`);
  if (turn.kind === "human_owned") return { kind: "human_owned", conversationId, ownershipVersion: 1 };
  const facts = { ...REVIEW_PUBLISHABLE_FACTS, ...turn.facts };
  return turn.kind === "draft"
    ? { kind: "draft", conversationId, ownershipVersion: 0, facts, draft: { text: DRAFT_TEXT, presentation: {} } }
    : { kind: "no_draft", conversationId, ownershipVersion: 0, facts };
};

/** One row's thread reviewed once by the real runner, and the evidence the harness would read from it. */
const reviewedEvidence = async (row: EmailOutcomeRow): Promise<EmailOutcomeEvidence> => {
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
  h.replyTriage.mockResolvedValue(row.replyNeeded ?? "yes");
  h.replyCompleteness.mockResolvedValue({ completeness: row.completeness ?? "complete", unansweredAsks: null });
  h.advance(60_000);
  await h.drain();

  const [latest] = h.heldRows.of(conversationId).slice(-1);
  return {
    delivery: { disposition: "run_review_turn", reason: "accepted", conversationId, settled: true },
    reviewPending: false,
    heldReply: latest ? heldReplySummaryOf(latest) : null,
    send: null,
    ownership: ownershipSummaryOf(await h.ownership.load(conversationId)),
    attentionOpen: h.heldRows.of(conversationId).some((record) => heldReplySummaryOf(record).attentionOpen),
    openDeliveryFailure: false,
    setAside: h.notes.find((note) => note.conversationId === conversationId)?.code ?? null,
  };
};

/** What the row's own expectation means for the business: the harness must report exactly this. */
const businessOutcomeOf = (row: EmailOutcomeRow): Pick<EmailBusinessOutcome, "kind" | "reason" | "attentionKind"> => {
  const { expected } = row;
  if (expected.setAside) return { kind: "silent", reason: expected.setAside, attentionKind: "none" };
  if (expected.heldReply) return { kind: "drafted", reason: expected.heldReply.holdReason, attentionKind: "approval" };
  if (expected.attention.kind === "human_owned") return { kind: "handed_off", reason: expected.attention.reason, attentionKind: "handoff" };
  if (row.ownership === "human_owned") return { kind: "handed_off", reason: "operator_takeover", attentionKind: "handoff" };
  throw new Error(`Row ${row.id} expects neither a held reply nor a hand-off`);
};

const sentEmail = (overrides: Partial<SentEmailSummary> = {}): SentEmailSummary => ({
  to: "pat@example.org",
  subject: "Re: Shipping",
  text: DRAFT_TEXT,
  autoSubmitted: "auto-generated",
  messageId: "<intent-1@fernhill.test>",
  inReplyTo: "<customer-1@example.org>",
  ...overrides,
});

const settledEvidence = (overrides: Partial<EmailOutcomeEvidence>): EmailOutcomeEvidence => ({
  delivery: { disposition: "run_review_turn", reason: "accepted", conversationId: "conversation-1", settled: true },
  reviewPending: false,
  heldReply: null,
  send: null,
  ownership: { state: "ai_owned", reason: null },
  attentionOpen: false,
  openDeliveryFailure: false,
  setAside: null,
  ...overrides,
});

describe("email mailbox harness: business outcome of an inbound email", () => {
  const rowsThatSettleInReview = emailOutcomeTable.filter((row) => !row.expected.queuedAuto);

  it.each(rowsThatSettleInReview.map((row) => [row.id, row] as const))("%s", async (_id, row) => {
    const outcome = classifyEmailOutcome(await reviewedEvidence(row));

    expect(outcome).toMatchObject(businessOutcomeOf(row));
    expect(outcome.sentEmail).toBeUndefined();
    if (outcome.kind === "drafted") {
      expect(outcome.heldReply).toMatchObject({ state: "pending", draftText: DRAFT_TEXT, attentionOpen: true });
    }
  });

  it("does not report a queued automatic reply until its send settles", async () => {
    const publishing = emailOutcomeTable.find((row) => row.expected.queuedAuto);
    if (!publishing) throw new Error("The outcome table has no publishing row");
    const evidence = await reviewedEvidence(publishing);

    expect(evidence.heldReply?.state).toBe("queued_auto");
    expect(() => classifyEmailOutcome(evidence)).toThrow(EmailOutcomeUnsettled);
  });

  it("reports an automatic reply the provider accepted as sent, with its Auto-Submitted header", () => {
    const outcome = classifyEmailOutcome(settledEvidence({
      heldReply: {
        id: "held-1",
        state: "released",
        holdReason: "queued_auto",
        releaseKind: "auto",
        edited: false,
        supersededReason: null,
        labels: { outcome: "answered", grounding: "grounded", coverage: "answered", handoffReason: null, suppressedEffects: [] },
        draftText: DRAFT_TEXT,
        attentionOpen: false,
      },
      send: { state: "accepted", trigger: "auto_reply", authorKind: "agent", haltReason: null, email: sentEmail() },
    }));

    expect(outcome).toMatchObject({ kind: "sent", reason: "auto", attentionKind: "none" });
    expect(outcome.sentEmail).toMatchObject({ autoSubmitted: "auto-generated", text: DRAFT_TEXT });
  });

  it("names who released a held draft that went out", () => {
    const released = (edited: boolean): EmailOutcomeEvidence["heldReply"] => ({
      id: "held-1",
      state: edited ? "edited" : "released",
      holdReason: "draft_mode",
      releaseKind: "operator",
      edited,
      supersededReason: null,
      labels: { outcome: "answered", grounding: "grounded", coverage: "answered", handoffReason: null, suppressedEffects: [] },
      draftText: DRAFT_TEXT,
      attentionOpen: false,
    });
    const send = { state: "accepted", trigger: "held_release", authorKind: "agent", haltReason: null, email: sentEmail() };

    expect(classifyEmailOutcome(settledEvidence({ heldReply: released(false), send })).reason).toBe("operator_released");
    expect(classifyEmailOutcome(settledEvidence({ heldReply: released(true), send: { ...send, authorKind: "operator" } })).reason)
      .toBe("operator_edited");
  });

  it("reports mail set aside before any turn as silent, with the disposition's reason", () => {
    const dropped = classifyEmailOutcome(settledEvidence({
      delivery: { disposition: "drop", reason: "automated_sender", conversationId: null, settled: true },
    }));
    const operatorOnly = classifyEmailOutcome(settledEvidence({
      delivery: { disposition: "ingest_only", reason: "operator_only_mailbox", conversationId: "conversation-1", settled: true },
      ownership: { state: "human_owned", reason: "operator_only_mailbox" },
    }));

    expect(dropped).toMatchObject({ kind: "silent", reason: "automated_sender", conversationId: null, attentionKind: "none" });
    expect(operatorOnly).toMatchObject({
      kind: "silent",
      reason: "operator_only_mailbox",
      ownership: { state: "human_owned", reason: "operator_only_mailbox" },
      attentionKind: "handoff",
    });
  });

  it("reports reviewed mail the channel set aside without a turn as silent, with the note's reason", () => {
    expect(classifyEmailOutcome(settledEvidence({ setAside: "no_reply_needed" })))
      .toMatchObject({ kind: "silent", reason: "no_reply_needed", ownership: { state: "ai_owned" }, attentionKind: "none" });
    expect(classifyEmailOutcome(settledEvidence({}))).toMatchObject({ kind: "silent", reason: "no_reply" });
  });

  it("refuses to report before the delivery or its review has settled", () => {
    expect(() => classifyEmailOutcome(settledEvidence({ delivery: null }))).toThrow(EmailOutcomeUnsettled);
    expect(() => classifyEmailOutcome(settledEvidence({
      delivery: { disposition: "run_review_turn", reason: "accepted", conversationId: "conversation-1", settled: false },
    }))).toThrow(EmailOutcomeUnsettled);
    expect(() => classifyEmailOutcome(settledEvidence({ reviewPending: true }))).toThrow(EmailOutcomeUnsettled);
    expect(() => classifyEmailOutcome(settledEvidence({
      send: { state: "queued", trigger: "auto_reply", authorKind: "agent", haltReason: null, email: null },
    }))).toThrow(EmailOutcomeUnsettled);
  });

  it("shows an open delivery failure as the attention when nothing else needs a person", () => {
    const outcome = classifyEmailOutcome(settledEvidence({
      send: { state: "bounced", trigger: "auto_reply", authorKind: "agent", haltReason: null, email: sentEmail() },
      openDeliveryFailure: true,
    }));

    expect(outcome).toMatchObject({ kind: "sent", attentionKind: "delivery_failed" });
  });
});
