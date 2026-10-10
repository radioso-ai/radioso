import type { TurnExecutionMode } from "./turnExecutionMode.js";

/**
 * Where a turn's skill-effect policy stopped a skill: a directive-bound turn
 * skill dispatch, or a directive-staged agentic retrieval tool invocation.
 */
export type SkillEffectSuppressionSite = "turn" | "staged_tool";

/** One skill run that the turn's skill-effect policy suppressed instead of executing. */
export interface SuppressedSkillEffect {
  readonly skillName: string;
  readonly site: SkillEffectSuppressionSite;
}

/** Read port over the skill effects suppressed during a single turn, in the order they occurred. */
export interface SuppressedSkillEffectsSource {
  suppressedEffects(): readonly SuppressedSkillEffect[];
}

/**
 * The reason a suppressed skill run settles with. It is persisted on the run's outcome
 * and read by traces and the dashboard, so each mode keeps its own stable value.
 */
export type SkillEffectSuppressionReason = "suppressed_for_safe_test" | "suppressed_for_review";

/** A `live` turn never suppresses, so every mode but `review` reports the safe-test reason. */
export const skillEffectSuppressionReason = (
  executionMode: TurnExecutionMode | undefined,
): SkillEffectSuppressionReason => (executionMode === "review" ? "suppressed_for_review" : "suppressed_for_safe_test");
