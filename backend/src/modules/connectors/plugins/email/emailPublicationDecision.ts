import type { ConnectorTurnFacts, ConnectorTurnResult } from "@radioso/connector-api";

import type { EngagementMode } from "../../../emailChannel/public.js";

/** Why a drafted reply waits for a teammate instead of going out. */
export type HoldReason = "sending_not_verified" | "draft_mode" | "send_budget" | "outcome_not_publishable" | "authority_changed";

export interface PublicationDecisionInput {
  /** The lower-autonomy mode of the accepted and the current policy (research B16), capped to the deployment's modes. */
  effectiveMode: EngagementMode;
  turn: ConnectorTurnResult;
  /** The thread's automatic sends since the last operator-authorized one, and the mailbox's limit (FR-022). */
  sendBudget: { used: number; limit: number };
  /** The ownership and policy the review ran under. */
  bound: { ownershipVersion: number; policyVersion: number };
  /** The ownership and policy now. */
  current: { ownershipVersion: number; policyVersion: number };
  /** Whether the mailbox's sending domain is verified. */
  sendingReady: boolean;
}

export type PublicationDecision =
  | { kind: "publish" }
  | { kind: "hold"; reason: HoldReason }
  /** No draft to publish or hold. `handoffReason` hands the conversation to a person; null leaves it as it is. */
  | { kind: "no_draft"; handoffReason: string | null };

/** The hand-off a draftless review asks for when the engine named none (research B3). */
const REVIEW_UNAVAILABLE = "review_unavailable";

const hold = (reason: HoldReason): PublicationDecision => ({ kind: "hold", reason });

/** Grounded, fully answered, no hand-off asked for and no effect suppressed; anything unknown fails closed. */
const isPublishable = (facts: ConnectorTurnFacts): boolean =>
  facts.grounding === "grounded"
  && facts.coverage === "answered"
  && !facts.handoff.requested
  && facts.suppressedEffects.length === 0;

/**
 * What happens to a review turn's result (FR-020, ports §6e). The first rule that fires wins:
 *
 * 1. a human-owned conversation: nothing;
 * 2. no draft: hand off with the engine's reason, or `review_unavailable`;
 * 3. ownership or policy moved since the review read them: hold (`authority_changed`);
 * 4. sending not verified: hold, before the mode (FR-004);
 * 5. a mailbox that is not `auto`: hold (`draft_mode`);
 * 6. the thread's send budget spent: hold;
 * 7. a result that is not grounded, fully answered, free of a hand-off and of suppressed effects: hold;
 * 8. otherwise publish.
 *
 * Decided on the turn's typed facts alone; the draft's text is never read.
 */
export const decidePublication = (input: PublicationDecisionInput): PublicationDecision => {
  const { turn } = input;
  if (turn.kind === "human_owned") return { kind: "no_draft", handoffReason: null };
  if (turn.kind === "no_draft") {
    return { kind: "no_draft", handoffReason: turn.facts.handoff.requested ? turn.facts.handoff.reason : REVIEW_UNAVAILABLE };
  }
  if (input.bound.ownershipVersion !== input.current.ownershipVersion || input.bound.policyVersion !== input.current.policyVersion) {
    return hold("authority_changed");
  }
  if (!input.sendingReady) return hold("sending_not_verified");
  if (input.effectiveMode !== "auto") return hold("draft_mode");
  if (input.sendBudget.used >= input.sendBudget.limit) return hold("send_budget");
  if (!isPublishable(turn.facts)) return hold("outcome_not_publishable");
  return { kind: "publish" };
};
