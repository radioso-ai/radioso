import { randomUUID } from "node:crypto";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { TurnExecutionMode } from "../../../shared/domain/turnExecutionMode.js";
import {
  applyAgentRevisionSnapshot,
  materializeAgentFromConfig,
  type AgentRevision,
  type InternalAgentConfig,
} from "../../agents/public.js";
import type { WorkbenchReplayResult } from "../../chat/contracts/index.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import type { ModelCallUsageAttribution } from "../../../shared/domain/modelCallUsageContext.js";
import type { ResolvedVariableInput } from "../../context-variables/public.js";
import { combineVerdicts, evaluateAssertion, isLlmJudgeAssertion } from "../domain/outcomes.js";
import type {
  AssertionVerdict,
  EvalCase,
  EvalCaseStatus,
  EvalRun,
  EvalRunMode,
  EvalRunStatus,
  EvalRunObservedOutput,
  EvalRunOverrides,
  EvalRunResolvedConfig,
  EvalSnapshot,
} from "../domain/types.js";
import { NoopUsageLimitPolicy, type UsageLimitPolicy, type UsageLimitReservation } from "../../../shared/domain/usageLimitPolicy.js";
import type { EvalRepositoryPort } from "./evalRepository.js";
import type { EvalLlmJudgePort } from "./evalJudge.js";
import { buildReplayInputs, type EvalRetrievalRunnerPort } from "./evalRunner.js";

export interface EvalWorkbenchReplayRunnerPort {
  run(input: {
    workspaceId: string;
    accountId?: string | null;
    sourceAgentId: string;
    /** An immutable candidate is only accepted for a private safe-test replay. */
    candidateRevision?: AgentRevision;
    preResolvedHostVariables?: readonly ResolvedVariableInput[];
    /** Whether the replayed turn's skills act for real. Stated by the caller; never defaulted. */
    executionMode: TurnExecutionMode;
    baselineAgentConfig: NonNullable<EvalSnapshot["originalAgentConfig"]>;
    agentConfigOverride?: NonNullable<EvalRunOverrides["agentConfigOverride"]>;
    query: string;
    history: MessageRecord[];
    routineStartState?: NonNullable<EvalRunOverrides["routineStartState"]>;
    retrievalSettingsOverride?: EvalRunOverrides["retrievalSettingsOverride"];
    usageAttribution?: ModelCallUsageAttribution;
    /** Frozen rolling summary from the snapshot, threaded so the replayed turn
     * sees the same pre-window context a live turn would. */
    conversationSummary?: string;
  }): Promise<WorkbenchReplayResult>;
}

/** Live, explicitly non-versioned settings/credentials still apply to a candidate replay. */
interface EvalRevisionLiveAgentConfigReaderPort {
  find(input: { workspaceId: string; agentId: string }): Promise<NonNullable<EvalSnapshot["originalAgentConfig"]> | null>;
}

/**
 * The revision-run aggregate owns persistence and retries.  This narrow result is deliberately
 * not an `eval_runs` record: trying a candidate must not replace a case's ordinary evidence.
 */
interface FrozenRevisionEvalCaseInput {
  workspaceId: string;
  agentId: string;
  accountId?: string | null;
  revision: AgentRevision;
  snapshot: EvalSnapshot;
  assertions: EvalCase["assertions"];
  mode: EvalRunMode;
  testValues: readonly ResolvedVariableInput[];
  executionPolicy: "safe_test";
  correlationId: string;
}

export interface FrozenRevisionEvalCaseResult {
  status: EvalRunStatus;
  outcomeReason: string | null;
  assertionVerdicts: AssertionVerdict[];
  observedOutput: EvalRunObservedOutput;
  resolvedConfig: EvalRunResolvedConfig;
}

export interface EvalRunInput {
  workspaceId: string;
  accountId?: string | null;
  snapshotId: string;
  caseId?: string | null;
  mode: EvalRunMode;
  overrides?: EvalRunOverrides;
  /**
   * False scores the case's assertions without recording the outcome against it: the run is
   * stored detached and the case keeps its verdict and last-run pointer. A caller measuring a
   * configuration it has not adopted replays this way, so trying a change never moves the
   * library's pass rate. Defaults to attaching.
   */
  attachToCase?: boolean;
  /**
   * A one-run authorization issued only after an interactive operator confirms a live case.
   * Persisted live mode alone is deliberately insufficient: API clients and Ray replays omit
   * this flag, so they remain safe even when they target a case configured to measure effects.
   */
  allowLiveEffects?: boolean;
}

export interface EvalRunOutcome {
  run: EvalRun;
  case: EvalCase | null;
}

interface EvalReplayLoggerPort {
  info(fields: Record<string, unknown>, message: string): void;
}

const caseStatusFromRun = (runStatus: EvalRun["status"]): EvalCaseStatus | null => {
  switch (runStatus) {
    case "pass":
      return "passing";
    case "fail":
      return "failing";
    case "error":
      return "error";
    case "recorded":
      return null;
  }
};

const toObservedGrounding = (
  summary: EvalRunObservedOutput["groundingSummary"],
): Pick<EvalRunObservedOutput, "groundingSummary" | "groundingVerdict" | "groundingDiagnostics"> | Record<string, never> => {
  if (!summary) {
    return {};
  }
  const { verdict, ...groundingDiagnostics } = summary;
  return {
    groundingSummary: summary,
    groundingVerdict: verdict,
    groundingDiagnostics,
  };
};

const resolveSnapshotReplayAgent = (snapshot: EvalSnapshot) => {
  if (snapshot.originalAgentConfig) {
    if (!snapshot.sourceAgentId) {
      throw badRequest("Snapshot is missing source agent identity");
    }
    return materializeAgentFromConfig(snapshot.originalAgentConfig, {
      agentId: snapshot.sourceAgentId,
      workspaceId: snapshot.workspaceId,
    });
  }

  return snapshot.originalAgent;
};

const overrideKeyNames = (
  override: NonNullable<EvalRunOverrides["agentConfigOverride"]> | undefined,
): string[] =>
  override ? Object.keys(override).sort() : [];

const resolveReplayRetrievalSettingsOverride = (
  original: EvalSnapshot["originalRetrievalSettings"],
  override: EvalRunOverrides["retrievalSettingsOverride"],
): EvalRunOverrides["retrievalSettingsOverride"] => {
  if (!original) {
    return override;
  }
  return {
    ...original,
    ...(override ?? {}),
  };
};

/** Overrides that only the conversation-engine replay path can honor. */
const requiresWorkbenchReplay = (overrides: EvalRunOverrides): boolean =>
  Boolean(overrides.agentConfigOverride || overrides.routineStartState);

const workbenchAgentConfigOverride = (
  overrides: EvalRunOverrides,
): Partial<InternalAgentConfig> | undefined => {
  const legacy: Partial<InternalAgentConfig> = {
    ...(overrides.modelOverride
      ? { chatModelOverride: overrides.modelOverride }
      : {}),
    ...(overrides.assistantInstructionsOverride?.customInstruction !== undefined
      ? { customInstruction: overrides.assistantInstructionsOverride.customInstruction }
      : {}),
  };
  const merged = { ...legacy, ...(overrides.agentConfigOverride ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
};

export class EvalRunService {
  constructor(
    private readonly repository: EvalRepositoryPort,
    private readonly retrievalRunner: EvalRetrievalRunnerPort,
    private readonly judge: EvalLlmJudgePort,
    private readonly workbenchReplayRunner?: EvalWorkbenchReplayRunnerPort,
    private readonly logger?: EvalReplayLoggerPort,
    private readonly usageLimitPolicy: UsageLimitPolicy = new NoopUsageLimitPolicy(),
    private readonly revisionLiveAgentConfig?: EvalRevisionLiveAgentConfigReaderPort,
  ) {}

  /**
   * One eval run costs one answer, in either mode.
   *
   * A `full_assistant` run replays a real turn — model calls, retrieval, routines — and until this
   * reservation existed it did so against no meter at all, on every surface that drives it: the
   * runs route, Ray's `replay_eval_case`, and `run_eval_suite`, which loops this method per case.
   * Metering here rather than at any one of those callers is what makes the charge match the cost:
   * the caller decides how many runs to ask for, this method knows what a run actually spends.
   *
   * A run whose replay errored still commits. The provider was already called; only a run rejected
   * before it starts — an unknown snapshot, a case from another snapshot — releases.
   */
  async execute(input: EvalRunInput): Promise<EvalRunOutcome> {
    return this.metered(input, (reserve) => this.executeReserved(input, reserve));
  }

  /** Runs a frozen revision/case pair without writing `eval_runs` or case last-run state. */
  async executeFrozenRevisionCase(input: FrozenRevisionEvalCaseInput): Promise<FrozenRevisionEvalCaseResult> {
    return this.metered(input, (reserve) => this.executeFrozenRevisionCaseReserved(input, reserve));
  }

  private async executeFrozenRevisionCaseReserved(input: FrozenRevisionEvalCaseInput, reserve: () => Promise<void>): Promise<FrozenRevisionEvalCaseResult> {
    if (input.executionPolicy !== "safe_test") {
      throw badRequest("Revision evaluations require safe_test execution policy");
    }
    const replay = buildReplayInputs(input.snapshot);
    if (!replay) throw badRequest("Frozen eval snapshot has no user message to replay");

    const startedAtMs = Date.now();
    let observed: EvalRunObservedOutput;
    const resolvedConfig: EvalRunResolvedConfig = { executionMode: "safe_test" };
    try {
      await reserve();
      const baselineAgentConfig = await this.revisionLiveAgentConfig?.find({ workspaceId: input.workspaceId, agentId: input.agentId });
      if (!baselineAgentConfig) throw badRequest("Live agent configuration is unavailable for revision evaluation");
      const candidateAgent = applyAgentRevisionSnapshot(
        materializeAgentFromConfig(baselineAgentConfig, {
          agentId: input.agentId,
          workspaceId: input.workspaceId,
        }),
        input.revision,
      );
      if (input.mode === "retrieval_only") {
        // Retrieval has no generation, workbench, routine, or host-variable execution path.
        // Its scope is the frozen candidate's released agent behavior projected over current
        // unversioned runtime config (credentials/settings), just as the trusted replay does.
        const result = await this.retrievalRunner.retrieve({
          workspaceId: input.workspaceId,
          query: replay.query,
          history: replay.history,
          context: { agent: candidateAgent },
          retrievalSettingsOverride: resolveReplayRetrievalSettingsOverride(
            input.snapshot.originalRetrievalSettings,
            undefined,
          ),
        });
        observed = { retrievedChunks: result.chunks, activityTrace: result.activityTrace };
        resolvedConfig.retrievalSettings = result.resolvedSettings;
      } else {
        if (!this.workbenchReplayRunner) throw badRequest("Workbench replay runner is not configured");
        const result = await this.workbenchReplayRunner.run({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          sourceAgentId: input.agentId,
          candidateRevision: input.revision,
          baselineAgentConfig,
          executionMode: "safe_test",
          query: replay.query,
          history: replay.history,
          // `originalRoutineState` is the post-turn/current state. A replay starts at the
          // preceding user turn, so historical replay deliberately never feeds it as pre-turn
          // state; no pre-turn routine/clarification/directive-firing snapshot exists.
          preResolvedHostVariables: input.testValues,
          usageAttribution: { surface: "eval", requestId: input.correlationId },
          conversationSummary: replay.conversationSummary,
        });
        observed = {
          retrievedChunks: result.resolvedConfig.retrievedChunks,
          answer: result.answer,
          citations: result.citations,
          answerSegments: result.answerSegments,
          suggestions: result.suggestions,
          ...toObservedGrounding(result.groundingSummary),
          turnTrace: result.turnTrace,
        };
        resolvedConfig.composedInstructions = result.resolvedConfig.composedInstructions;
        resolvedConfig.modelProvider = result.resolvedConfig.modelProvider;
        resolvedConfig.modelId = result.resolvedConfig.modelId;
        resolvedConfig.retrievalSettings = result.resolvedConfig.retrievalSettings;
        if (result.resolvedConfig.conversationSummary) resolvedConfig.conversationSummary = result.resolvedConfig.conversationSummary;
      }
    } catch {
      // Provider errors are intentionally reduced before durable operator evidence/logging.
      observed = { retrievedChunks: [], error: { message: "revision_eval_runner_failed", code: "runner_failed" } };
    }
    const verdicts = observed.error
      ? input.assertions.map((assertion) => ({ assertion, status: "error" as const, reason: observed.error!.code ?? "runner_failed" }))
      : await Promise.all(input.assertions.map(async (assertion, assertionIndex) => {
        if (isLlmJudgeAssertion(assertion)) {
          if (typeof observed.answer !== "string") return { assertion, status: "error" as const, reason: "llm_judge_requires_answer" };
          const verdict = await this.judge.judge({ workspaceId: input.workspaceId, accountId: input.accountId, runId: input.correlationId, assertionIndex, assertion, observedAnswer: observed.answer, question: replay.query });
          // Provider and parser details are not durable revision-eval evidence. The status still
          // makes this retryable while retaining the assertion that could not be judged.
          return verdict.status === "error" ? { ...verdict, reason: "judge_failed" } : verdict;
        }
        return evaluateAssertion(assertion, observed);
      }));
    const aggregate = combineVerdicts(verdicts);
    // Empty assertion sets ordinarily produce `recorded`; a failed provider is never a
    // successful recording, however. Keep its sanitized evidence and make the attempt retryable.
    const status = observed.error ? "error" as const : aggregate.status;
    const outcomeReason = observed.error?.code ?? aggregate.reason;
    this.logger?.info({ workspaceId: input.workspaceId, revisionId: input.revision.id, correlationId: input.correlationId, status, executionMode: "safe_test", latencyMs: Date.now() - startedAtMs }, "Revision eval case completed");
    return { status, outcomeReason, assertionVerdicts: aggregate.verdicts, observedOutput: observed, resolvedConfig };
  }

  /**
   * Charges exactly one answer for the work `run` performs.
   *
   * Both public entry points wrap themselves in this, and the work itself lives in private methods
   * that never reserve. That split is the point: a public method delegating to another public
   * method would charge twice for one replay, and a reservation living on only one of them would
   * leave the other free — which is what the workbench-override routes were doing, since they call
   * {@link executeWorkbenchReplay} rather than {@link execute}.
   */
  private async metered<T>(
    input: Pick<EvalRunInput, "accountId" | "workspaceId">,
    run: (reserve: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    let reservation: UsageLimitReservation | null = null;
    // Taken by the run itself, immediately before it dispatches, rather than up front. Reserving
    // earlier made an unknown snapshot or a mismatched case answer 429 instead of the documented
    // 404 or 400 whenever the workspace allowance happened to be gone — a request's validity is
    // not a function of how much quota is left.
    const reserve = async (): Promise<void> => {
      reservation = await this.usageLimitPolicy.reserveAnswer({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        surface: "eval_replay",
      });
    };
    try {
      const outcome = await run(reserve);
      await (reservation as UsageLimitReservation | null)?.commit();
      return outcome;
    } catch (error) {
      // Once reserved, the run has been dispatched, so the question a failure has to answer is
      // not "did the call succeed" but "did the provider already run". Recording the result and
      // judging it both happen after the replay and both can throw; releasing there would hand
      // back budget that was genuinely consumed. A failure before the reservation never took any.
      await (reservation as UsageLimitReservation | null)?.commit();
      throw error;
    }
  }

  private async executeReserved(input: EvalRunInput, reserve: () => Promise<void>): Promise<EvalRunOutcome> {
    const snapshot = await this.repository.findSnapshot(input.workspaceId, input.snapshotId);
    if (!snapshot) {
      throw notFound("Snapshot not found");
    }

    const evalCase = input.caseId
      ? await this.repository.findCase(input.workspaceId, input.caseId)
      : null;
    if (input.caseId && !evalCase) {
      throw notFound("Eval case not found");
    }
    if (evalCase && evalCase.snapshotId !== snapshot.id) {
      throw badRequest("Case snapshot does not match provided snapshot");
    }

    const overrides = input.overrides ?? {};
    if (
      input.mode === "full_assistant"
      && this.workbenchReplayRunner
      && snapshot.originalAgentConfig
      && snapshot.sourceAgentId
    ) {
      return this.runWorkbenchReplay(input, reserve);
    }
    if (requiresWorkbenchReplay(overrides)) {
      // The retrieval fallback ignores both of these, so continuing would answer from the
      // captured configuration and report it as the override's result.
      throw badRequest(
        "agentConfigOverride and routineStartState require full_assistant mode and a full agent config snapshot",
      );
    }

    const replay = buildReplayInputs(snapshot);
    if (!replay) {
      throw badRequest("Snapshot has no user message to replay");
    }

    // Generate the run id up front so usage events recorded inside the
    // runner/judge can reference the same id that ends up on eval_runs.
    const runId = randomUUID();
    const resolvedConfig: EvalRunResolvedConfig = {};
    let observed: EvalRunObservedOutput;

    // Replay context (agent + per-run instruction override) is sourced from
    // the snapshot's frozen agent and the operator's runtime override. Both
    // retrieval_only and full_assistant runs need it: sourceScope and
    // suggested-question behavior shape retrieval too, not just generation.
    const replayContext = {
      agent: resolveSnapshotReplayAgent(snapshot),
      customInstructionOverride: overrides.assistantInstructionsOverride?.customInstruction,
    };
    const retrievalSettingsOverride = resolveReplayRetrievalSettingsOverride(
      snapshot.originalRetrievalSettings,
      overrides.retrievalSettingsOverride,
    );

    await reserve();
    try {
      if (input.mode === "full_assistant") {
        const result = await this.retrievalRunner.answer({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          runId,
          query: replay.query,
          history: replay.history,
          context: replayContext,
          conversationSummary: replay.conversationSummary,
          modelOverride: overrides.modelOverride,
          retrievalSettingsOverride,
        });
        observed = {
          retrievedChunks: result.chunks,
          answer: result.answer,
          citations: result.citations,
          answerSegments: result.answerSegments,
          ...toObservedGrounding(result.groundingSummary),
          activityTrace: result.activityTrace,
        };
        resolvedConfig.retrievalSettings = result.resolvedSettings;
        resolvedConfig.composedInstructions = result.composedInstructions;
        if (replay.conversationSummary) {
          resolvedConfig.conversationSummary = replay.conversationSummary;
        }
        if (result.resolvedModel) {
          resolvedConfig.modelProvider = result.resolvedModel.provider;
          resolvedConfig.modelId = result.resolvedModel.model;
        }
      } else {
        const result = await this.retrievalRunner.retrieve({
          workspaceId: input.workspaceId,
          query: replay.query,
          history: replay.history,
          context: replayContext,
          conversationSummary: replay.conversationSummary,
          retrievalSettingsOverride,
        });
        observed = {
          retrievedChunks: result.chunks,
          activityTrace: result.activityTrace,
        };
        resolvedConfig.retrievalSettings = result.resolvedSettings;
      }
    } catch (error) {
      observed = {
        retrievedChunks: [],
        error: {
          message: error instanceof Error ? error.message : "Unknown run error",
        },
      };
    }

    const assertions = evalCase?.assertions ?? [];
    let verdicts: AssertionVerdict[];

    if (observed.error) {
      // Output errored — every assertion gets the same error verdict; no
      // judge calls (would waste an LLM round-trip on a failed run).
      verdicts = assertions.map((assertion) => ({
        assertion,
        status: "error" as const,
        reason: observed.error!.message,
      }));
    } else {
      verdicts = await Promise.all(
        assertions.map(async (assertion, assertionIndex) => {
          if (isLlmJudgeAssertion(assertion)) {
            if (typeof observed.answer !== "string") {
              return {
                assertion,
                status: "error" as const,
                reason: "llm_judge requires an answer in the run output. Run the case in full_assistant mode.",
              };
            }
            return this.judge.judge({
              workspaceId: input.workspaceId,
              accountId: input.accountId,
              runId,
              assertionIndex,
              assertion,
              observedAnswer: observed.answer,
              question: replay.query,
            });
          }
          return evaluateAssertion(assertion, observed);
        }),
      );
    }

    const aggregate = combineVerdicts(verdicts);

    const attachableCase = evalCase && input.attachToCase !== false
      ? await this.repository.findCase(input.workspaceId, evalCase.id)
      : null;
    const run = await this.repository.createRun({
      id: runId,
      workspaceId: input.workspaceId,
      snapshotId: snapshot.id,
      caseId: attachableCase?.id ?? null,
      mode: input.mode,
      overrides,
      resolvedConfig,
      observedOutput: observed,
      assertionVerdicts: aggregate.verdicts,
      status: aggregate.status,
      outcomeReason: aggregate.reason,
      completedAt: new Date(),
    });

    let updatedCase: EvalCase | null = run.caseId ? attachableCase : null;
    if (run.caseId) {
      const nextStatus = caseStatusFromRun(aggregate.status);
      if (nextStatus !== null) {
        updatedCase = await this.repository.updateCaseLastRun(
          input.workspaceId,
          run.caseId,
          run.id,
          nextStatus,
        );
      }
    }

    return { run: updatedCase ? run : { ...run, caseId: null }, case: updatedCase };
  }

  async executeWorkbenchReplay(input: EvalRunInput): Promise<EvalRunOutcome> {
    return this.metered(input, (reserve) => this.runWorkbenchReplay(input, reserve));
  }

  private async runWorkbenchReplay(input: EvalRunInput, reserve: () => Promise<void>): Promise<EvalRunOutcome> {
    const startedAtMs = Date.now();
    if (!this.workbenchReplayRunner) {
      throw badRequest("Workbench replay runner is not configured");
    }
    if (input.mode !== "full_assistant") {
      throw badRequest("Workbench replay requires full_assistant mode");
    }

    const snapshot = await this.repository.findSnapshot(input.workspaceId, input.snapshotId);
    if (!snapshot) {
      throw notFound("Snapshot not found");
    }
    if (!snapshot.originalAgentConfig || !snapshot.sourceAgentId) {
      throw badRequest("Workbench replay requires a full agent config snapshot");
    }

    const evalCase = input.caseId
      ? await this.repository.findCase(input.workspaceId, input.caseId)
      : null;
    if (input.caseId && !evalCase) {
      throw notFound("Eval case not found");
    }
    if (evalCase && evalCase.snapshotId !== snapshot.id) {
      throw badRequest("Case snapshot does not match provided snapshot");
    }

    const replay = buildReplayInputs(snapshot);
    if (!replay) {
      throw badRequest("Snapshot has no user message to replay");
    }

    const runId = randomUUID();
    const overrides = input.overrides ?? {};
    // Live effects require two independent, intentional choices: the case has been configured
    // to measure them and this particular interactive replay was confirmed. One-off snapshots,
    // API-triggered runs, and Ray replays do not carry the per-run confirmation and stay safe.
    const executionMode: TurnExecutionMode =
      evalCase?.executionMode === "live" && input.allowLiveEffects === true ? "live" : "safe_test";
    const agentConfigOverride = workbenchAgentConfigOverride(overrides);
    const retrievalSettingsOverride = resolveReplayRetrievalSettingsOverride(
      snapshot.originalRetrievalSettings,
      overrides.retrievalSettingsOverride,
    );
    const resolvedConfig: EvalRunResolvedConfig = { executionMode };
    let observed: EvalRunObservedOutput;

    await reserve();
    try {
      const result = await this.workbenchReplayRunner.run({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        sourceAgentId: snapshot.sourceAgentId,
        baselineAgentConfig: snapshot.originalAgentConfig,
        executionMode,
        agentConfigOverride,
        query: replay.query,
        history: replay.history,
        // Only an explicit override seeds the routine. We deliberately do NOT default
        // from snapshot.originalRoutineState: that is the conversation's *current*
        // (post-turn) routine position, but a replay regenerates an already-completed
        // assistant turn from the preceding user message, so seeding it would start the
        // routine one or more steps ahead. There is no per-turn pre-turn state source.
        routineStartState: overrides.routineStartState,
        retrievalSettingsOverride,
        usageAttribution: { surface: "eval", requestId: runId },
        // Frozen rolling summary — hermetically threaded, never regenerated.
        conversationSummary: replay.conversationSummary,
      });
      observed = {
        retrievedChunks: result.resolvedConfig.retrievedChunks,
        answer: result.answer,
        citations: result.citations,
        answerSegments: result.answerSegments,
        suggestions: result.suggestions,
        ...toObservedGrounding(result.groundingSummary),
        turnTrace: result.turnTrace,
      };
      resolvedConfig.composedInstructions = result.resolvedConfig.composedInstructions;
      resolvedConfig.modelProvider = result.resolvedConfig.modelProvider;
      resolvedConfig.modelId = result.resolvedConfig.modelId;
      resolvedConfig.retrievalSettings = result.resolvedConfig.retrievalSettings;
      if (result.resolvedConfig.conversationSummary) {
        resolvedConfig.conversationSummary = result.resolvedConfig.conversationSummary;
      }
    } catch (error) {
      observed = {
        retrievedChunks: [],
        error: {
          message: error instanceof Error ? error.message : "Unknown run error",
        },
      };
    }

    const assertions = evalCase?.assertions ?? [];
    const verdicts = observed.error
      ? assertions.map((assertion) => ({
          assertion,
          status: "error" as const,
          reason: observed.error!.message,
        }))
      : await Promise.all(
          assertions.map(async (assertion, assertionIndex) => {
            if (isLlmJudgeAssertion(assertion)) {
              if (typeof observed.answer !== "string") {
                return {
                  assertion,
                  status: "error" as const,
                  reason: "llm_judge requires an answer in the run output. Run the case in full_assistant mode.",
                };
              }
              return this.judge.judge({
                workspaceId: input.workspaceId,
                accountId: input.accountId,
                runId,
                assertionIndex,
                assertion,
                observedAnswer: observed.answer,
                question: replay.query,
              });
            }
            return evaluateAssertion(assertion, observed);
          }),
        );
    const aggregate = combineVerdicts(verdicts);

    const attachableCase = evalCase && input.attachToCase !== false
      ? await this.repository.findCase(input.workspaceId, evalCase.id)
      : null;
    const run = await this.repository.createRun({
      id: runId,
      workspaceId: input.workspaceId,
      snapshotId: snapshot.id,
      caseId: attachableCase?.id ?? null,
      mode: input.mode,
      overrides,
      resolvedConfig,
      observedOutput: observed,
      assertionVerdicts: aggregate.verdicts,
      status: aggregate.status,
      outcomeReason: aggregate.reason,
      completedAt: new Date(),
    });

    this.logger?.info(
      {
        workspaceId: input.workspaceId,
        accountId: input.accountId ?? null,
        agentId: snapshot.sourceAgentId,
        snapshotId: snapshot.id,
        runId: run.id,
        status: run.status,
        outcome: aggregate.status,
        executionMode,
        latencyMs: Date.now() - startedAtMs,
        overrideKeys: overrideKeyNames(agentConfigOverride),
      },
      "Workbench replay eval run completed",
    );

    let updatedCase: EvalCase | null = run.caseId ? attachableCase : null;
    if (run.caseId) {
      const nextStatus = caseStatusFromRun(aggregate.status);
      if (nextStatus !== null) {
        updatedCase = await this.repository.updateCaseLastRun(
          input.workspaceId,
          run.caseId,
          run.id,
          nextStatus,
        );
      }
    }

    return { run: updatedCase ? run : { ...run, caseId: null }, case: updatedCase };
  }
}
