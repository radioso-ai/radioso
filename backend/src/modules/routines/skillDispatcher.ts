import type {
  ConversationRoutineSkillDispatcher,
  RoutineSkillResult,
  StagedContext,
} from "@radioso/conversation-contract";
import {
  noopSkillEmitPort,
  type SkillDefinition,
  type SkillDispatchResult,
  type SkillExecutorRegistry,
} from "../skills/public.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import { traceOperation } from "../../shared/observability/tracing/operations.js";
import { resolveSkillArguments } from "./skillArgumentResolver.js";

export type RoutineCapabilityGate = (capability: string) => Promise<{ allowed: boolean; reason?: string }>;

export interface RoutineSkillExecutorDispatcherOptions {
  capabilityGate?: RoutineCapabilityGate;
  metricsRegistry?: MetricsRegistry | null;
  workspaceId?: string;
  accountId?: string;
  throwIfCancelled?: () => void;
}

const allowAllRoutineCapabilityGate: RoutineCapabilityGate = async () => ({ allowed: true });
const routineDispatchFailureReasons = new Set([
  "unknown_skill",
  "no_execution",
  "no_executor",
  "capability_denied",
  "executor_error",
  "deferred",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const contextVariableNameFor = (staged: StagedContext): string | null => {
  const metadataName = isRecord(staged.metadata) && typeof staged.metadata.variableName === "string"
    ? staged.metadata.variableName
    : null;
  const fallbackName = typeof staged.id === "string" ? staged.id : null;
  const name = metadataName ?? fallbackName;
  return name && name.trim().length > 0 ? name : null;
};

const contextVariableValueFor = (name: string, data: unknown): unknown => {
  if (name === "page_context") {
    return data;
  }
  if (isRecord(data) && data.kind === "variable" && "value" in data) {
    return data.value;
  }
  return data;
};

export const contextValuesFromStagedContext = (
  stagedContext: readonly StagedContext[],
): Record<string, unknown> => {
  const contextValues: Record<string, unknown> = {};
  for (const staged of stagedContext) {
    if (staged.kind !== "context_variable") {
      continue;
    }
    const name = contextVariableNameFor(staged);
    if (!name) {
      continue;
    }
    contextValues[name] = contextVariableValueFor(name, staged.data);
  }
  return contextValues;
};

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

  constructor(skills: readonly SkillDefinition[], private readonly delegate: RoutineSkillResolver | null = null) {
    this.byName = new Map(skills.map((skill) => [skill.name, skill]));
  }

  resolve(skillName: string): SkillDefinition | null {
    return this.byName.get(skillName) ?? this.delegate?.resolve(skillName) ?? null;
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
  private readonly capabilityGate: RoutineCapabilityGate;
  private readonly metricsRegistry: MetricsRegistry | null;
  private readonly workspaceId?: string;
  private readonly accountId?: string;
  private readonly throwIfCancelled?: () => void;

  constructor(
    private readonly resolver: RoutineSkillResolver,
    private readonly executorRegistry: SkillExecutorRegistry,
    options: RoutineSkillExecutorDispatcherOptions = {},
  ) {
    this.capabilityGate = options.capabilityGate ?? allowAllRoutineCapabilityGate;
    this.metricsRegistry = options.metricsRegistry ?? null;
    this.workspaceId = options.workspaceId;
    this.accountId = options.accountId;
    this.throwIfCancelled = options.throwIfCancelled;
  }

  async dispatch(
    input: Parameters<ConversationRoutineSkillDispatcher["dispatch"]>[0],
  ): Promise<RoutineSkillResult> {
    const { skillName, state, turn } = input;

    return traceOperation({
      name: "routine.skill.dispatch",
      attributes: routineDispatchTraceAttributes(skillName, state),
      run: async () => {
        const result = await this.dispatchInner(input);
        this.recordDispatchMetric(result);
        return result;
      },
      resultAttributes: routineDispatchResultAttributes,
    });
  }

  private async dispatchInner(
    input: Parameters<ConversationRoutineSkillDispatcher["dispatch"]>[0],
  ): Promise<RoutineSkillResult> {
    const { skillName, state, turn, inputBindings } = input;
    const stepId = state.path.at(-1);
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
    const deniedCapability = await this.firstDeniedCapability(skill);
    if (deniedCapability) {
      return unavailable(skillName, "capability_denied");
    }

    let result: SkillDispatchResult;
    const collected = inputBindings && Object.keys(inputBindings).length > 0
      ? resolveSkillArguments(inputBindings, state.variables ?? {}, contextValuesFromStagedContext(turn.stagedContext))
      : state.variables ?? {};
    this.throwIfCancelled?.();
    try {
      result = await executor.dispatch({
        skill,
        // Typed steps resolve authored input bindings first. During the FR-019
        // compatibility window, untyped/legacy steps still pass captured variables
        // through so external-skill slotBinding routing keeps working.
        collected,
        context: {
          turn,
          agentId: turn.agent.id,
          sessionId: turn.sessionId,
          // In the chat subsystem the routine state machine is keyed by the
          // conversation id, which TurnContext carries as `sessionId`. Surface it
          // under the name the action outbox + contact-delivery resolver expect so a
          // notify skill can scope its enqueue (recipients + dedup) to the conversation.
          conversationId: turn.sessionId,
          routineId: state.routineId,
          ...(stepId ? { stepId } : {}),
          ...(this.workspaceId ? { workspaceId: this.workspaceId } : {}),
          ...(this.accountId ? { accountId: this.accountId } : {}),
        },
        emit: noopSkillEmitPort,
      });
    } catch {
      return unavailable(skillName, "executor_error");
    }

    if (result.disposition !== "settled") {
      // No v1 executor defers; the async-weave (reconcile a deferred result in a
      // later turn) isn't wired for routines, so degrade rather than wedge.
      return unavailable(skillName, "deferred");
    }

    return {
      status: result.outcome.status,
      outputs: result.outcome.outputs,
      answer: result.outcome.answer,
      ...(result.outcome.metadata ? { metadata: result.outcome.metadata } : {}),
    };
  }

  private async firstDeniedCapability(skill: SkillDefinition): Promise<string | null> {
    for (const capability of skill.requiredCapabilities ?? []) {
      try {
        const decision = await this.capabilityGate(capability);
        if (!decision.allowed) {
          return "capability_denied";
        }
      } catch {
        return "capability_denied";
      }
    }
    return null;
  }

  private recordDispatchMetric(result: RoutineSkillResult): void {
    this.metricsRegistry?.incrementCounter("routine_skill_dispatch_total", {
      help: "Routine skill dispatch outcomes.",
      labels: routineDispatchMetricLabels(result),
    });
  }
}

// A recoverable failure: the runner branches on `status` and can read `outputs`
// (skill name + reason) for an outcome guard or operator triage.
function unavailable(skillName: string, reason: string): RoutineSkillResult {
  return { status: "failed", outputs: { skill: skillName, reason } };
}

const routineDispatchTraceAttributes = (
  skillName: string,
  state: Parameters<ConversationRoutineSkillDispatcher["dispatch"]>[0]["state"],
): Record<string, string> => {
  const stepId = state.path.at(-1);
  return {
    "routine.id": state.routineId,
    ...(stepId ? { "routine.step_id": stepId } : {}),
    "skill.name": skillName,
  };
};

const routineDispatchResultAttributes = (result: RoutineSkillResult): Record<string, string> => {
  const reason = typeof result.outputs?.reason === "string" ? result.outputs.reason : undefined;
  return {
    "outcome.status": result.status,
    "outcome.reason": reason ?? result.status,
  };
};

const routineDispatchMetricLabels = (result: RoutineSkillResult): Record<string, string> => {
  if (result.status !== "failed") {
    return {
      outcome: "settled",
      reason: "none",
    };
  }
  const reason = typeof result.outputs?.reason === "string" ? result.outputs.reason : undefined;
  return {
    outcome: "failed",
    reason: reason && routineDispatchFailureReasons.has(reason) ? reason : "skill_failed",
  };
};
