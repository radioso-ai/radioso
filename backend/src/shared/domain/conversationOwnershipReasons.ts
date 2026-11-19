/**
 * Why a conversation's ownership changed, as the codes the handoff module stores and the workspace
 * event log publishes on `handoff.requested`. Listed here, below every module, because chat, the
 * email channel and the event log all name them.
 */
export const CONVERSATION_OWNERSHIP_REASONS = [
  "routine_handoff",
  "routine_stuck",
  /** A visitor declined a routine's consent, and its decline choice hands off (#1544). */
  "routine_consent_declined",
  "retrieval_miss",
  "operator_takeover",
  /** The conversation arrived at a mailbox that only operators answer. */
  "operator_only_mailbox",
  /** The channel's budget for generated replies ran out. */
  "generation_budget",
  /** A reviewed turn could not produce a reply to review. */
  "review_unavailable",
  /**
   * A channel's policy change (an upgrade, another agent) superseded the draft the customer was
   * waiting on and runs no review for that message again. Its own reason rather than
   * `review_unavailable`, because no review failed: the operator changed the rules under it.
   */
  "policy_changed",
] as const;

export type ConversationOwnershipReasonCode = typeof CONVERSATION_OWNERSHIP_REASONS[number];

export const isConversationOwnershipReasonCode = (value: string): value is ConversationOwnershipReasonCode =>
  (CONVERSATION_OWNERSHIP_REASONS as readonly string[]).includes(value);
