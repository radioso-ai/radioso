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
