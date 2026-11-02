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
