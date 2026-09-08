import type { AgenticRetrievalToolFactory } from "../../retrieval/public.js";
import type { DirectiveBindingSkillState } from "./directiveBindingResolution.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import type { TurnSkill } from "./turnOutcome.js";

export interface AgentSkillTurnRuntime {
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
