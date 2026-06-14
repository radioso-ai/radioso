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

    // A routine runs on a resumable state machine, and the runner resolves this
    // BEFORE the turn is persisted — so throwing here would 500 the turn AND leave
    // the routine pinned at this step, re-throwing on every subsequent turn (a
    // permanently wedged conversation). An unresolvable / deferred skill is an
    // author/config error, not a programming bug, so it must degrade to a `failed`
    // result the runner advances off (its outgoing edges / a fallback branch).
    const skill = this.resolver.resolve(skillName);
    if (!skill) {
      return unavailable(skillName, "unknown_skill");
    }
    if (!skill.execution) {
      return unavailable(skillName, "no_execution");
    }
    const executor = this.executorRegistry.resolve(skill.execution);
    if (!executor) {
      return unavailable(skillName, "no_executor");
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
      // No v1 executor defers; the async-weave (reconcile a deferred result in a
      // later turn) isn't wired for routines, so degrade rather than wedge.
      return unavailable(skillName, "deferred");
    }

    return {
      status: result.outcome.status,
      outputs: result.outcome.outputs,
      answer: result.outcome.answer,
    };
  }
}

// A recoverable failure: the runner branches on `status` and can read `outputs`
// (skill name + reason) for an outcome guard or operator triage.
function unavailable(skillName: string, reason: string): RoutineSkillResult {
  return { status: "failed", outputs: { skill: skillName, reason } };
}
