import type {
  ConversationRoutineSkillDispatcher,
  RoutineSkillResult,
} from "@radioso/conversation-contract";
import {
  noopSkillEmitPort,
  type SkillDefinition,
  type SkillExecutorRegistry,
} from "../skills/public.js";

/**
 * Resolves an authored routine skill reference (its `@name`) to the runtime skill
 * definition that carries the execution descriptor. The built-in resolver is
 * backed by the static skill list; per-agent external (MCP) skills extend this
 * seam without touching the dispatcher or the runner.
 */
export interface RoutineSkillResolver {
  resolve(skillName: string): SkillDefinition | null;
}

/** Resolves routine skill references against a fixed set of skill definitions. */
export class StaticRoutineSkillResolver implements RoutineSkillResolver {
  private readonly byName: Map<string, SkillDefinition>;

  constructor(skills: readonly SkillDefinition[]) {
    this.byName = new Map(skills.map((skill) => [skill.name, skill]));
  }

  resolve(skillName: string): SkillDefinition | null {
    return this.byName.get(skillName) ?? null;
  }
}

/**
 * Bridges a Routine skill (tool) step to the shared skill-executor port: resolve
 * the authored skill by name, dispatch it through the same registry the chat turn
 * uses, and project the {@link SkillOutcome} onto a {@link RoutineSkillResult} the
 * runner branches on. A custom (fine-grained) status survives the projection
 * verbatim — the closed-enum → open-union seam that lets condition-gated branches
 * match service-shaped outcomes.
 *
 * It knows nothing about any concrete skill or transport (MCP, retrieval, …):
 * those live behind the executor registry, so external MCP skills become usable
 * in routines with no change to this bridge.
 */
export class RoutineSkillExecutorDispatcher implements ConversationRoutineSkillDispatcher {
  constructor(
    private readonly resolver: RoutineSkillResolver,
    private readonly executorRegistry: SkillExecutorRegistry,
  ) {}

  async dispatch(
    input: Parameters<ConversationRoutineSkillDispatcher["dispatch"]>[0],
  ): Promise<RoutineSkillResult> {
    const { skillName, state, turn } = input;

    const skill = this.resolver.resolve(skillName);
    if (!skill) {
      throw new Error(`routine_skill_unknown:${skillName}`);
    }
    if (!skill.execution) {
      throw new Error(`routine_skill_no_execution:${skillName}`);
    }
    const executor = this.executorRegistry.resolve(skill.execution);
    if (!executor) {
      throw new Error(`routine_skill_no_executor:${skillName}`);
    }

    const result = await executor.dispatch({
      skill,
      // The routine's captured slots are the exposed params the executor fills
      // from; any bound params (e.g. an MCP channel) are merged inside it.
      collected: state.variables ?? {},
      context: { turn },
      emit: noopSkillEmitPort,
    });

    if (result.disposition !== "settled") {
      // No v1 executor defers; a routine step must branch on an available result.
      throw new Error(`routine_skill_deferred:${skillName}`);
    }

    return {
      status: result.outcome.status,
      outputs: result.outcome.outputs,
      answer: result.outcome.answer,
    };
  }
}
