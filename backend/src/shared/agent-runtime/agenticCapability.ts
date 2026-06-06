import {
  AGENT_BUDGET_DEFAULTS,
  type AgentBudgets,
  type AgentRunInput,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentRuntime,
  type AgentTool,
  type AgentTraceEvent,
  type TerminatedReason,
  type TraceSink,
} from "./types.js";

export interface AgenticCapabilityRunInput {
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly metadata?: Record<string, unknown>;
  readonly usageContext?: AgentRunOptions["usageContext"];
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export interface AgenticCapabilityFallbackInput {
  readonly events: ReadonlyArray<AgentTraceEvent>;
  readonly runResult: AgentRunResult;
}

export interface AgenticCapabilityTraceInput<TSelection, TFinalization> {
  readonly events: ReadonlyArray<AgentTraceEvent>;
  readonly runResult: AgentRunResult;
  readonly selection: TSelection;
  readonly finalization: TFinalization | null;
  readonly traceStartedAtMs: number;
  readonly budgetProfile: AgentBudgets;
}

export interface AgenticCapabilityDefinition<TFinalization, TSelection, TTrace> {
  readonly tools: ReadonlyArray<AgentTool>;
  readonly budgetProfile?: Partial<AgentBudgets>;
  readonly getFinalization: () => TFinalization | null;
  readonly mapFinalizationToSelection: (finalization: TFinalization) => TSelection;
  readonly selectFallback: (input: AgenticCapabilityFallbackInput) => TSelection;
  readonly mapTrace: (input: AgenticCapabilityTraceInput<TSelection, TFinalization>) => TTrace;
}

export interface AgenticCapabilityResult<TFinalization, TSelection, TTrace> {
  readonly selection: TSelection;
  readonly finalization: TFinalization | null;
  readonly trace: TTrace;
  readonly events: ReadonlyArray<AgentTraceEvent>;
  readonly runResult: AgentRunResult;
  readonly terminatedReason: TerminatedReason;
  readonly stepsTaken: number;
  readonly budgetProfile: AgentBudgets;
}

export interface AgenticCapabilityRunnerDeps {
  readonly runtime: AgentRuntime;
}

// `?? default` does not catch NaN (NaN is neither null nor undefined), and a
// NaN budget makes runtime step checks unsafe. Treat any non-positive or
// non-finite override as absent and fall back to the shared default profile.
const positiveOr = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

export const resolveAgenticCapabilityBudgetProfile = (
  overrides?: Partial<AgentBudgets>,
): AgentBudgets => ({
  maxSteps: positiveOr(overrides?.maxSteps, AGENT_BUDGET_DEFAULTS.maxSteps),
  maxToolResultTokens: positiveOr(
    overrides?.maxToolResultTokens,
    AGENT_BUDGET_DEFAULTS.maxToolResultTokens,
  ),
  maxWallTimeMs: positiveOr(overrides?.maxWallTimeMs, AGENT_BUDGET_DEFAULTS.maxWallTimeMs),
});

export class AgenticCapabilityRunner {
  constructor(private readonly deps: AgenticCapabilityRunnerDeps) {}

  async run<TFinalization, TSelection, TTrace>(
    input: AgenticCapabilityRunInput,
    capability: AgenticCapabilityDefinition<TFinalization, TSelection, TTrace>,
  ): Promise<AgenticCapabilityResult<TFinalization, TSelection, TTrace>> {
    const events: AgentTraceEvent[] = [];
    const sink: TraceSink = {
      emit: (event) => {
        events.push(event);
      },
    };

    const budgetProfile = resolveAgenticCapabilityBudgetProfile(capability.budgetProfile);
    const now = input.now ?? (() => Date.now());
    const traceStartedAtMs = now();

    const runInput: AgentRunInput = {
      systemPrompt: input.systemPrompt,
      userMessage: input.userMessage,
      metadata: input.metadata,
    };

    const runResult = await this.deps.runtime.run(runInput, capability.tools, budgetProfile, {
      signal: input.signal,
      traceSink: sink,
      now: input.now,
      usageContext: input.usageContext,
    });

    const finalization = capability.getFinalization();
    const selection =
      finalization === null
        ? capability.selectFallback({ events, runResult })
        : capability.mapFinalizationToSelection(finalization);

    const trace = capability.mapTrace({
      events,
      runResult,
      selection,
      finalization,
      traceStartedAtMs,
      budgetProfile,
    });

    return {
      selection,
      finalization,
      trace,
      events,
      runResult,
      terminatedReason: runResult.terminatedReason,
      stepsTaken: runResult.stepsTaken,
      budgetProfile,
    };
  }
}
