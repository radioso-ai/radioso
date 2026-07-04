import type { DirectiveBindingSkillState } from "./directiveBindingResolution.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import type { TurnSkill } from "./turnOutcome.js";

export interface AgentSkillTurnRuntime {
  turnSkills: TurnSkill[];
  skillStates: ReadonlyMap<string, DirectiveBindingSkillState>;
}

export interface AgentSkillTurnSkillProvider {
  forSession(session: PreparedSession): Promise<AgentSkillTurnRuntime>;
}
