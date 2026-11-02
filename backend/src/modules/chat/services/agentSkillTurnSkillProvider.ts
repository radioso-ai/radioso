import type { SuppressedSkillEffectsSource } from "../../../shared/domain/suppressedSkillEffect.js";
import type { AgenticRetrievalToolFactory } from "../../retrieval/public.js";
import type { DirectiveBindingSkillState } from "./directiveBindingResolution.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import type { TurnSkill } from "./turnOutcome.js";

/**
 * The outcome kind an agent-selectable skill's turn settles with. Chat renders a completed
 * one with answer text through the skill-result renderer (`skillResultTurnRenderer.ts`);
 * the provider tags every outcome it builds with it.
 */
export const AGENT_SKILL_OUTCOME_KIND = "agent_skill";

/**
 * Whether a skill's answer carries renderable text. Shared by the agent-skill turn provider
 * (an empty-answer dispatch fails the turn rather than settling) and the skill-result renderer
 * (which claims only a completed outcome this predicate accepts), so "has an answer" is one
 * definition, not two that could drift apart.
 */
export const hasAnswerText = (answer: string | undefined): boolean =>
  typeof answer === "string" && answer.trim().length > 0;

/**
 * One turn's agent-selectable skills. `suppressedEffects`, when the runtime reports it,
 * lists the skill runs the turn's skill-effect policy stopped; absent reports none.
 */
export interface AgentSkillTurnRuntime extends Partial<SuppressedSkillEffectsSource> {
  turnSkills: TurnSkill[];
  agenticRetrievalToolFactories(session: PreparedSession): AgenticRetrievalToolFactory[];
  skillStates: ReadonlyMap<string, DirectiveBindingSkillState>;
}

export interface AgentSkillTurnSkillProvider {
  forSession(
    session: PreparedSession,
    coordination?: { throwIfCancelled?: () => void },
  ): Promise<AgentSkillTurnRuntime>;
}
