import type { SuppressedSkillEffectsSource } from "../../../shared/domain/suppressedSkillEffect.js";
import type { AgenticRetrievalToolFactory } from "../../retrieval/public.js";
import type { SkillOutcome } from "../../skills/public.js";
import { skillResultCardsFor } from "./replyBlocks/skillResultCardsGate.js";
import { hasToolRecords } from "./replyBlocks/toolRecords.js";
import type { DirectiveBindingSkillState } from "./directiveBindingResolution.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import type { TurnSkill } from "./turnOutcome.js";

/**
 * The outcome kind an agent-selectable skill's turn settles with. Chat renders a completed
 * one with answer text through the skill-result renderer (`skillResultTurnRenderer.ts`);
 * the provider tags every outcome it builds with it.
 */
export const AGENT_SKILL_OUTCOME_KIND = "agent_skill";

/** Whether a skill's answer carries text. */
export const hasAnswerText = (answer: string | undefined): boolean =>
  typeof answer === "string" && answer.trim().length > 0;

/**
 * Whether a skill's result gives this turn's reply something to be written from: text, or, where
 * the reply may show cards, at least one record (#1763). Without cards a records-only result fails
 * as `empty_answer`, as it always did, so a channel without cards never gets a reply written from
 * raw records. Read by the agent-skill turn provider, which settles a dispatch this rejects as
 * failed; the skill-result renderer then only meets results this accepted.
 */
export const hasRenderableResult = (
  outcome: Pick<SkillOutcome, "answer" | "outputs">,
  session: Pick<PreparedSession, "replyBlocks" | "agent">,
): boolean => hasAnswerText(outcome.answer) || (skillResultCardsFor(session) !== null && hasToolRecords(outcome.outputs));

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
