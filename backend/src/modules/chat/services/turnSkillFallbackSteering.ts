import type { SteeringRule } from "../../../shared/domain/steeringRule.js";
import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";

/**
 * Listed ahead of every authored directive, whose priorities stop at 100: a directive that
 * says to use the tool cannot be followed this turn, and the answer prompt resolves a
 * conflict in favor of the rule listed first.
 */
const TURN_SKILL_UNAVAILABLE_PRIORITY = 1000;

/**
 * The answer-steering rule a fallback answer carries: the bound tool was not consulted,
 * so the reply must not claim its results. A turn-scoped skill rule rather than an
 * authored directive, so it carries no rule id and the answer never attests to it.
 */
export const turnSkillUnavailableRule = (skillName: string): SteeringRule => ({
  action: renderPromptTemplate("chat/turn-skill-unavailable.md", { skill_name: skillName }),
  priority: TURN_SKILL_UNAVAILABLE_PRIORITY,
  source: "skill",
  lifespan: "response",
});
