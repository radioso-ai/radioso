import type { ConnectorTurnFacts } from "@radioso/connector-api";

/**
 * The spec's Engagement Outcome Table (specs/1403-email-channel/spec.md), every mode, as structural
 * rows: the typed turn result a review would return, and what must follow from it. No model runs;
 * `email-outcome-table.test.ts` drives the review runner with a stub `respond`, a stub reply triage
 * and a stub completeness check per row. On an `auto` mailbox only the grounded, complete,
 * hand-off-free row with budget room that the completeness check finds complete publishes; mail the
 * triage finds needs no reply is set aside without a turn; every other row holds or hands off and
 * queues no send (SC-005).
 */

type OutcomeTurn =
  | { kind: "draft"; facts: Partial<ConnectorTurnFacts> }
  | { kind: "no_draft"; facts: Partial<ConnectorTurnFacts> }
  | { kind: "human_owned" };

/** What an operator is left with: a held reply to decide, a conversation handed to them, or nothing new. */
type OutcomeAttention =
  | { kind: "approval" }
  | { kind: "human_owned"; reason: string }
  | { kind: "unchanged" };

export interface EmailOutcomeRow {
  id: string;
  mode: "operator_only" | "draft" | "auto";
  /** Who owns the conversation when its review falls due. */
  ownership: "ai_owned" | "human_owned";
  /** Whether the thread's automatic-send budget is spent when its review falls due. */
  sendBudget: "room" | "exhausted";
  /** The review's result; null when no turn may run. */
  turn: OutcomeTurn | null;
  /** The reply triage's verdict on the mail before the turn; `yes` when left out. */
  replyNeeded?: "yes" | "no" | "unsure" | "unavailable";
  /** The completeness check's verdict, when the decision asks for one; `complete` when left out. */
  completeness?: "complete" | "partial" | "not_answered" | "unavailable";
  expected: {
    /** Whether the runner asks the host for a review. The host runs no turn on a person's conversation. */
    reviewAsked: boolean;
    /** Whether the completeness check runs: only on a draft every other gate would publish. */
    completenessChecked?: boolean;
    /** The thread note when the review set the mail aside without a turn. */
    setAside?: "no_reply_needed";
    /** The publication decision as counted; null when no turn ran or a person owns the conversation. */
    decision: { decision: "publish" | "hold" | "no_reply"; reason: string } | null;
    /** Whether the reply is queued to send automatically: a `queued_auto` held reply and one `email.send`. */
    queuedAuto: boolean;
    /** The held reply the operator sees, with the turn's outcome labels; null when none is held. */
    heldReply: {
      holdReason: string;
      facts: { outcome: string; grounding: string; coverage: string; handoff: { requested: boolean; reason: string | null } };
      dependsOnSuppressedAction: boolean;
    } | null;
    attention: OutcomeAttention;
  };
}

const GROUNDED_COMPLETE: ConnectorTurnFacts = {
  outcome: "answered",
  grounding: "grounded",
  coverage: "answered",
  handoff: { requested: false },
  suppressedEffects: [],
  citationCount: 2,
};

const held = (
  facts: Partial<ConnectorTurnFacts>,
  holdReason: string,
  shown: Partial<ConnectorTurnFacts> = {},
): NonNullable<EmailOutcomeRow["expected"]["heldReply"]> => {
  const all = { ...GROUNDED_COMPLETE, ...facts, ...shown };
  return {
    holdReason,
    facts: {
      outcome: all.outcome,
      grounding: all.grounding,
      coverage: all.coverage,
      handoff: all.handoff.requested ? { requested: true, reason: all.handoff.reason } : { requested: false, reason: null },
    },
    dependsOnSuppressedAction: all.suppressedEffects.length > 0,
  };
};

// A draft mailbox never publishes: the mode decides before the outcome does (ports §6e).
const draftRow = (id: string, facts: Partial<ConnectorTurnFacts>): EmailOutcomeRow => heldRow(id, "draft", "room", facts, "draft_mode");

const heldRow = (
  id: string,
  mode: "draft" | "auto",
  sendBudget: EmailOutcomeRow["sendBudget"],
  facts: Partial<ConnectorTurnFacts>,
  holdReason: string,
): EmailOutcomeRow => ({
  id,
  mode,
  ownership: "ai_owned",
  sendBudget,
  turn: { kind: "draft", facts },
  expected: {
    reviewAsked: true,
    decision: { decision: "hold", reason: holdReason },
    queuedAuto: false,
    heldReply: held(facts, holdReason),
    attention: { kind: "approval" },
  },
});

/** Mail the reply triage finds needs no reply: no turn, no held reply, no attention, a thread note. */
const noReplyNeededRow = (mode: "draft" | "auto"): EmailOutcomeRow => ({
  id: `${mode}-no-reply-needed`,
  mode,
  ownership: "ai_owned",
  sendBudget: "room",
  turn: null,
  replyNeeded: "no",
  expected: {
    reviewAsked: false,
    decision: null,
    queuedAuto: false,
    heldReply: null,
    attention: { kind: "unchanged" },
    setAside: "no_reply_needed",
  },
});

/** A grounded, complete-looking auto draft the completeness check does not find complete: held, its coverage shown as the check found it. */
const incompleteRow = (
  id: string,
  completeness: "partial" | "not_answered" | "unavailable",
  coverage: ConnectorTurnFacts["coverage"],
): EmailOutcomeRow => ({
  id,
  mode: "auto",
  ownership: "ai_owned",
  sendBudget: "room",
  turn: { kind: "draft", facts: {} },
  completeness,
  expected: {
    reviewAsked: true,
    completenessChecked: true,
    decision: { decision: "hold", reason: "incomplete_answer" },
    queuedAuto: false,
    heldReply: held({}, "incomplete_answer", { coverage }),
    attention: { kind: "approval" },
  },
});

/** The draftless and human-owned rows, the same in every mode that runs a review. */
const handOffRows = (mode: "draft" | "auto"): EmailOutcomeRow[] => [
  {
    id: `${mode}-no-text-engine-reason`,
    mode,
    ownership: "ai_owned",
    sendBudget: "room",
    turn: { kind: "no_draft", facts: { outcome: "unavailable", grounding: "unknown", coverage: "not_assessed", handoff: { requested: true, reason: "customer_requested_human" } } },
    expected: {
      reviewAsked: true,
      decision: { decision: "no_reply", reason: "customer_requested_human" },
      queuedAuto: false,
      heldReply: null,
      attention: { kind: "human_owned", reason: "customer_requested_human" },
    },
  },
  {
    id: `${mode}-unavailable`,
    mode,
    ownership: "ai_owned",
    sendBudget: "room",
    turn: { kind: "no_draft", facts: { outcome: "unavailable", grounding: "unknown", coverage: "unavailable" } },
    expected: {
      reviewAsked: true,
      decision: { decision: "no_reply", reason: "review_unavailable" },
      queuedAuto: false,
      heldReply: null,
      attention: { kind: "human_owned", reason: "review_unavailable" },
    },
  },
  {
    id: `${mode}-human-owned-conversation`,
    mode,
    ownership: "human_owned",
    sendBudget: "room",
    // The review leaves a person's conversation alone before it asks for a turn or spends budget;
    // the host would answer `human_owned` only to a takeover that raced the review.
    turn: { kind: "human_owned" },
    expected: { reviewAsked: false, decision: null, queuedAuto: false, heldReply: null, attention: { kind: "unchanged" } },
  },
];

export const emailOutcomeTable: readonly EmailOutcomeRow[] = [
  {
    id: "operator_only-accepted",
    mode: "operator_only",
    ownership: "ai_owned",
    sendBudget: "room",
    turn: null,
    expected: { reviewAsked: false, decision: null, queuedAuto: false, heldReply: null, attention: { kind: "human_owned", reason: "operator_only_mailbox" } },
  },
  draftRow("draft-grounded-complete", {}),
  draftRow("draft-partial", { coverage: "partial" }),
  draftRow("draft-no-context", { outcome: "no_context", grounding: "ungrounded", coverage: "unanswered" }),
  draftRow("draft-out-of-scope", { outcome: "out_of_scope", grounding: "not_applicable", coverage: "not_assessed" }),
  draftRow("draft-handoff-with-text", { handoff: { requested: true, reason: "billing_dispute" } }),
  draftRow("draft-suppressed-effect", { suppressedEffects: [{ skillName: "issue_refund" }] }),
  ...handOffRows("draft"),
  noReplyNeededRow("draft"),
  {
    id: "auto-grounded-complete",
    mode: "auto",
    ownership: "ai_owned",
    sendBudget: "room",
    turn: { kind: "draft", facts: {} },
    expected: {
      reviewAsked: true,
      completenessChecked: true,
      decision: { decision: "publish", reason: "none" },
      queuedAuto: true,
      heldReply: null,
      attention: { kind: "unchanged" },
    },
  },
  {
    id: "auto-reply-triage-unsure",
    mode: "auto",
    ownership: "ai_owned",
    sendBudget: "room",
    turn: { kind: "draft", facts: {} },
    replyNeeded: "unsure",
    expected: {
      reviewAsked: true,
      completenessChecked: true,
      decision: { decision: "publish", reason: "none" },
      queuedAuto: true,
      heldReply: null,
      attention: { kind: "unchanged" },
    },
  },
  incompleteRow("auto-incomplete-partial", "partial", "partial"),
  incompleteRow("auto-incomplete-not-answered", "not_answered", "unanswered"),
  incompleteRow("auto-completeness-unavailable", "unavailable", "unavailable"),
  heldRow("auto-budget-exhausted-grounded-complete", "auto", "exhausted", {}, "send_budget"),
  heldRow("auto-budget-exhausted-partial", "auto", "exhausted", { coverage: "partial" }, "send_budget"),
  heldRow("auto-partial", "auto", "room", { coverage: "partial" }, "outcome_not_publishable"),
  heldRow("auto-no-context", "auto", "room", { outcome: "no_context", grounding: "ungrounded", coverage: "unanswered" }, "outcome_not_publishable"),
  heldRow("auto-out-of-scope", "auto", "room", { outcome: "out_of_scope", grounding: "not_applicable", coverage: "not_assessed" }, "outcome_not_publishable"),
  heldRow("auto-handoff-with-text", "auto", "room", { handoff: { requested: true, reason: "billing_dispute" } }, "outcome_not_publishable"),
  heldRow("auto-suppressed-effect", "auto", "room", { suppressedEffects: [{ skillName: "issue_refund" }] }, "outcome_not_publishable"),
  ...handOffRows("auto"),
  noReplyNeededRow("auto"),
];
