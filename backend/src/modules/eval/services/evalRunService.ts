import { randomUUID } from "node:crypto";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { materializeAgentFromConfig } from "../../agents/public.js";
import type { WorkbenchReplayResult } from "../../chat/contracts/index.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import { combineVerdicts, evaluateAssertion, isLlmJudgeAssertion } from "../domain/outcomes.js";
import type {
  AssertionVerdict,
  EvalCase,
  EvalCaseStatus,
  EvalRun,
  EvalRunMode,
  EvalRunObservedOutput,
  EvalRunOverrides,
  EvalRunResolvedConfig,
  EvalSnapshot,
} from "../domain/types.js";
import type { EvalRepositoryPort } from "./evalRepository.js";
import type { EvalLlmJudgePort } from "./evalJudge.js";
import { buildReplayInputs, type EvalRetrievalRunnerPort } from "./evalRunner.js";

export interface EvalWorkbenchReplayRunnerPort {
  run(input: {
    workspaceId: string;
    accountId?: string | null;
    sourceAgentId: string;
    baselineAgentConfig: NonNullable<EvalSnapshot["originalAgentConfig"]>;
    agentConfigOverride?: NonNullable<EvalRunOverrides["agentConfigOverride"]>;
    query: string;
    history: MessageRecord[];
    routineStartState?: NonNullable<EvalRunOverrides["routineStartState"]>;
    /** Frozen rolling summary (#866) from the snapshot, threaded so the replayed turn
     * sees the same pre-window context a live turn would. */
    conversationSummary?: string;
  }): Promise<WorkbenchReplayResult>;
}

export interface EvalRunInput {
  workspaceId: string;
  accountId?: string | null;
  snapshotId: string;
  caseId?: string | null;
  mode: EvalRunMode;
  overrides?: EvalRunOverrides;
}

export interface EvalRunOutcome {
  run: EvalRun;
  case: EvalCase | null;
}

export interface EvalReplayLoggerPort {
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

const hasLegacyOnlyFullAssistantOverride = (overrides: EvalRunOverrides): boolean =>
  Boolean(
    overrides.modelOverride
      || overrides.assistantInstructionsOverride
      || overrides.retrievalSettingsOverride,
  );

export class EvalRunService {
  constructor(
    private readonly repository: EvalRepositoryPort,
    private readonly retrievalRunner: EvalRetrievalRunnerPort,
    private readonly judge: EvalLlmJudgePort,
    private readonly workbenchReplayRunner?: EvalWorkbenchReplayRunnerPort,
    private readonly logger?: EvalReplayLoggerPort,
  ) {}

  async execute(input: EvalRunInput): Promise<EvalRunOutcome> {
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
      && !hasLegacyOnlyFullAssistantOverride(overrides)
    ) {
      return this.executeWorkbenchReplay(input);
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

    const attachableCase = evalCase
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
    const resolvedConfig: EvalRunResolvedConfig = {};
    let observed: EvalRunObservedOutput;

    try {
      const result = await this.workbenchReplayRunner.run({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        sourceAgentId: snapshot.sourceAgentId,
        baselineAgentConfig: snapshot.originalAgentConfig,
        agentConfigOverride: overrides.agentConfigOverride,
        query: replay.query,
        history: replay.history,
        // Only an explicit override seeds the routine. We deliberately do NOT default
        // from snapshot.originalRoutineState: that is the conversation's *current*
        // (post-turn) routine position, but a replay regenerates an already-completed
        // assistant turn from the preceding user message, so seeding it would start the
        // routine one or more steps ahead. There is no per-turn pre-turn state source.
        routineStartState: overrides.routineStartState,
        // Frozen rolling summary (#866) — hermetically threaded, never regenerated.
        conversationSummary: replay.conversationSummary,
      });
      observed = {
        retrievedChunks: result.resolvedConfig.retrievedChunks,
        answer: result.answer,
        citations: result.citations,
        answerSegments: result.answerSegments,
        ...toObservedGrounding(result.groundingSummary),
        turnTrace: result.turnTrace,
      };
      resolvedConfig.composedInstructions = result.resolvedConfig.composedInstructions;
      resolvedConfig.modelProvider = result.resolvedConfig.modelProvider;
      resolvedConfig.modelId = result.resolvedConfig.modelId;
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

    const attachableCase = evalCase
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
        latencyMs: Date.now() - startedAtMs,
        overrideKeys: overrideKeyNames(overrides.agentConfigOverride),
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
