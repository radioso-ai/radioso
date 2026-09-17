/** Whether a turn may perform live customer-facing effects. */
export type TurnExecutionMode = "live" | "safe_test";

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
 * side effects by mistake), while a `safe_test` turn defaults to suppressed
 * and only allows effects when a caller explicitly opts in.
 */
export const resolveSkillEffectPolicy = (
  executionMode: TurnExecutionMode | undefined,
  requested?: SkillEffectPolicy,
): SkillEffectPolicy => (executionMode === "safe_test" ? (requested ?? "suppressed") : "allowed");
