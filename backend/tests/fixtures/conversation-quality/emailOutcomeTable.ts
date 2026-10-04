import type { ConnectorTurnFacts } from "@radioso/connector-api";

/**
 * The spec's Engagement Outcome Table (specs/1403-email-channel/spec.md) for the modes S3 runs,
 * `operator_only` and `draft`, as structural rows: the typed turn result a review would return,
 * and what must follow from it. No model runs; `email-outcome-table.test.ts` drives the review
 * runner with a stub `respond` per row. The `auto` rows join in S6 (T225).
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
  mode: "operator_only" | "draft";
  /** Who owns the conversation when its review falls due. */
  ownership: "ai_owned" | "human_owned";
  /** The review's result; null when no turn may run. */
  turn: OutcomeTurn | null;
  expected: {
    /** Whether the runner asks the host for a review. The host runs no turn on a person's conversation. */
    reviewAsked: boolean;
    /** The publication decision as counted; null when no turn ran or a person owns the conversation. */
    decision: { decision: "hold" | "no_reply"; reason: string } | null;
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

const held = (facts: Partial<ConnectorTurnFacts>): NonNullable<EmailOutcomeRow["expected"]["heldReply"]> => {
  const all = { ...GROUNDED_COMPLETE, ...facts };
  return {
    // A draft mailbox never publishes: the mode decides before the outcome does (ports §6e).
    holdReason: "draft_mode",
    facts: {
      outcome: all.outcome,
      grounding: all.grounding,
      coverage: all.coverage,
      handoff: all.handoff.requested ? { requested: true, reason: all.handoff.reason } : { requested: false, reason: null },
    },
    dependsOnSuppressedAction: all.suppressedEffects.length > 0,
  };
};

const draftRow = (id: string, facts: Partial<ConnectorTurnFacts>): EmailOutcomeRow => ({
  id,
  mode: "draft",
  ownership: "ai_owned",
  turn: { kind: "draft", facts },
  expected: {
    reviewAsked: true,
    decision: { decision: "hold", reason: "draft_mode" },
    heldReply: held(facts),
    attention: { kind: "approval" },
  },
});

export const emailOutcomeTable: readonly EmailOutcomeRow[] = [
  {
    id: "operator_only-accepted",
    mode: "operator_only",
    ownership: "ai_owned",
    turn: null,
    expected: { reviewAsked: false, decision: null, heldReply: null, attention: { kind: "human_owned", reason: "operator_only_mailbox" } },
  },
  draftRow("draft-grounded-complete", {}),
  draftRow("draft-partial", { coverage: "partial" }),
  draftRow("draft-no-context", { outcome: "no_context", grounding: "ungrounded", coverage: "unanswered" }),
  draftRow("draft-out-of-scope", { outcome: "out_of_scope", grounding: "not_applicable", coverage: "not_assessed" }),
  draftRow("draft-handoff-with-text", { handoff: { requested: true, reason: "billing_dispute" } }),
  draftRow("draft-suppressed-effect", { suppressedEffects: [{ skillName: "issue_refund" }] }),
  {
    id: "draft-no-text-engine-reason",
    mode: "draft",
    ownership: "ai_owned",
    turn: { kind: "no_draft", facts: { outcome: "unavailable", grounding: "unknown", coverage: "not_assessed", handoff: { requested: true, reason: "customer_requested_human" } } },
    expected: {
      reviewAsked: true,
      decision: { decision: "no_reply", reason: "customer_requested_human" },
      heldReply: null,
      attention: { kind: "human_owned", reason: "customer_requested_human" },
    },
  },
  {
    id: "draft-unavailable",
    mode: "draft",
    ownership: "ai_owned",
    turn: { kind: "no_draft", facts: { outcome: "unavailable", grounding: "unknown", coverage: "unavailable" } },
    expected: {
      reviewAsked: true,
      decision: { decision: "no_reply", reason: "review_unavailable" },
      heldReply: null,
      attention: { kind: "human_owned", reason: "review_unavailable" },
    },
  },
  {
    id: "draft-human-owned-conversation",
    mode: "draft",
    ownership: "human_owned",
    turn: { kind: "human_owned" },
    expected: { reviewAsked: true, decision: null, heldReply: null, attention: { kind: "unchanged" } },
  },
];
