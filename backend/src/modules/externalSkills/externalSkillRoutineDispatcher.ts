import { noopSkillEmitPort, type SkillExecutorRegistry } from "@radioso/conversation-defaults";
import type {
  ConversationRoutineSkillDispatcher,
  RoutineSkillResult,
  RoutineState,
  TurnContext,
} from "@radioso/conversation-contract";

import { EXTERNAL_SKILLS_ADAPTER } from "./executor/mcpSkillExecutor.js";

/**
 * Host-side dispatcher the routine runner calls for a `skill` step. Routes the
 * step to the external-skills executor via the skill-executor registry and
 * projects its settled `SkillOutcome` onto `RoutineSkillResult` — status copied
 * VERBATIM, so custom outcomes (P3, e.g. `slot_conflict`) survive for routine
 * branching. The conversation engine stays MCP-free; this seam lives in the host.
 *
 * Every routine skill name routes to the external-skills executor. If the name is
 * not an authored, enabled definition for the agent, the executor returns a
 * settled failed outcome (`skill_not_found`), so the routine takes its failure
 * path rather than crashing.
 */
export class ExternalSkillRoutineDispatcher implements ConversationRoutineSkillDispatcher {
  constructor(private readonly executorRegistry: SkillExecutorRegistry) {}

  async dispatch(input: {
    skillName: string;
    state: RoutineState;
    turn: TurnContext;
  }): Promise<RoutineSkillResult> {
    const execution = { kind: "internal", adapter: EXTERNAL_SKILLS_ADAPTER } as const;
    const executor = this.executorRegistry.resolve(execution);
    if (!executor) {
      return { status: "failed" };
    }

    const result = await executor.dispatch({
      skill: { name: input.skillName },
      collected: input.state.variables ?? {},
      context: { agentId: input.turn.agent.id },
      emit: noopSkillEmitPort,
    });

    if (result.disposition !== "settled") {
      return { status: "failed" };
    }

    return {
      status: result.outcome.status,
      ...(result.outcome.outputs ? { outputs: result.outcome.outputs } : {}),
      ...(result.outcome.answer ? { answer: result.outcome.answer } : {}),
    };
  }
}
