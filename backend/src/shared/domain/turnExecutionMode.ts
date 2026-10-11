/**
 * Whether a turn may perform live customer-facing effects. `review` runs a durable
 * customer turn whose reply comes back to the caller as a draft instead of being sent.
 */
export type TurnExecutionMode = "live" | "safe_test" | "review";

/** The modes a turn that persists its reply runs in; a `review` turn returns a draft instead. */
export type AnswerTurnExecutionMode = Exclude<TurnExecutionMode, "review">;

/**
 * What a turn may do in its execution mode. Every per-mode difference in turn
 * behaviour reads one of these fields rather than comparing modes.
 */
export interface TurnExecutionCapabilities {
  /** Routine activation and the suspended-routine short-circuit. */
  readonly routines: "activate" | "skip";
  /** How the turn completes: by persisting the assistant reply, or by returning it as a draft. */
  readonly completion: "persist_reply" | "return_draft";
  /**
   * What a hand-off the turn requests does: change conversation ownership, be reported
   * to the caller with ownership left as it is, or nothing.
   */
  readonly ownershipHandoff: "apply" | "report" | "skip";
  /** Whether actions the turn emits are enqueued to the action outbox. */
  readonly turnActions: "enqueue" | "drop";
  /** Whether a human-owned turn generates the "a teammate is joining" line. */
  readonly humanOwnedWaitingMessage: "generate" | "skip";
  /**
   * Records a customer turn keeps beyond its reply and trace: product analytics,
   * the rolling conversation summary, and a caller-supplied audit event.
   */
  readonly turnBookkeeping: "record" | "skip";
}

const CAPABILITIES_BY_MODE: Record<TurnExecutionMode, TurnExecutionCapabilities> = {
  live: {
    routines: "activate",
    completion: "persist_reply",
    ownershipHandoff: "apply",
    turnActions: "enqueue",
    humanOwnedWaitingMessage: "generate",
    turnBookkeeping: "record",
  },
  // A safe-test turn keeps conversation-local state (routines, the reply) so follow-up
  // turns stay representative, and drops what a customer or operator would act on.
  safe_test: {
    routines: "activate",
    completion: "persist_reply",
    ownershipHandoff: "skip",
    turnActions: "drop",
    humanOwnedWaitingMessage: "generate",
    turnBookkeeping: "skip",
  },
  // A review turn answers a recorded customer message for a person or a channel policy
  // to publish later. It writes no conversation state the published reply would depend
  // on, and acts on nothing: what it would have done is reported with the draft.
  review: {
    routines: "skip",
    completion: "return_draft",
    ownershipHandoff: "report",
    turnActions: "drop",
    humanOwnedWaitingMessage: "skip",
    turnBookkeeping: "skip",
  },
};

/** Resolves a turn's capabilities. An unset mode is `live`. */
export const turnExecutionCapabilities = (
  executionMode: TurnExecutionMode | undefined,
): TurnExecutionCapabilities => CAPABILITIES_BY_MODE[executionMode ?? "live"];

/** Whether skill steps / agent skills with outward effects may execute this turn. */
export type SkillEffectPolicy = "suppressed" | "allowed";

/**
 * Whether this turn's conversation row is the persisted, addressable one a skill
 * executor can look up later, or an in-memory-only stand-in built for a replay or
 * private test. A skill that declares `requiresDurableConversation` cannot run
 * meaningfully against an `ephemeral` conversation, regardless of skill-effect policy.
 */
export type ConversationDurability = "durable" | "ephemeral";

/**
 * Resolves the effective skill-effect policy for a turn. Orthogonal to
 * {@link TurnExecutionMode}: a `live` turn always allows outward effects
 * regardless of what was requested (a caller cannot suppress production
 * side effects by mistake), a `safe_test` turn defaults to suppressed
 * and only allows effects when a caller explicitly opts in, and a `review`
 * turn is always suppressed, because nobody has approved its reply yet.
 */
export const resolveSkillEffectPolicy = (
  executionMode: TurnExecutionMode | undefined,
  requested?: SkillEffectPolicy,
): SkillEffectPolicy => {
  switch (executionMode ?? "live") {
    case "live":
      return "allowed";
    case "safe_test":
      return requested ?? "suppressed";
    case "review":
      return "suppressed";
  }
};
