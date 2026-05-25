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
} from "../domain/types.js";
import type { EvalRepositoryPort } from "./evalRepository.js";
import type { EvalLlmJudgePort } from "./evalJudge.js";
import { buildReplayInputs, type EvalRetrievalRunnerPort } from "./evalRunner.js";

export interface EvalRunInput {
  workspaceId: string;
  snapshotId: string;
  caseId?: string | null;
  mode: EvalRunMode;
  overrides?: EvalRunOverrides;
}

export interface EvalRunOutcome {
  run: EvalRun;
  case: EvalCase | null;
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

export class EvalRunService {
  constructor(
    private readonly repository: EvalRepositoryPort,
    private readonly retrievalRunner: EvalRetrievalRunnerPort,
    private readonly judge: EvalLlmJudgePort,
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

    const replay = buildReplayInputs(snapshot);
    if (!replay) {
      throw badRequest("Snapshot has no user message to replay");
    }

    const overrides = input.overrides ?? {};
    const resolvedConfig: EvalRunResolvedConfig = {};
    let observed: EvalRunObservedOutput;

    try {
      if (input.mode === "full_assistant") {
        const result = await this.retrievalRunner.answer({
          workspaceId: input.workspaceId,
          query: replay.query,
          history: replay.history,
          retrievalSettingsOverride: overrides.retrievalSettingsOverride,
        });
        observed = { retrievedChunks: result.chunks, answer: result.answer };
        resolvedConfig.retrievalSettings = result.resolvedSettings;
        resolvedConfig.composedInstructions = result.composedInstructions;
      } else {
        const result = await this.retrievalRunner.retrieve({
          workspaceId: input.workspaceId,
          query: replay.query,
          history: replay.history,
          retrievalSettingsOverride: overrides.retrievalSettingsOverride,
        });
        observed = { retrievedChunks: result.chunks };
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
        assertions.map(async (assertion) => {
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

    const run = await this.repository.createRun({
      workspaceId: input.workspaceId,
      snapshotId: snapshot.id,
      caseId: evalCase?.id ?? null,
      mode: input.mode,
      overrides,
      resolvedConfig,
      observedOutput: observed,
      assertionVerdicts: aggregate.verdicts,
      status: aggregate.status,
      outcomeReason: aggregate.reason,
      completedAt: new Date(),
    });

    let updatedCase: EvalCase | null = evalCase;
    if (evalCase) {
      const nextStatus = caseStatusFromRun(aggregate.status);
      if (nextStatus !== null) {
        updatedCase = await this.repository.updateCaseLastRun(
          input.workspaceId,
          evalCase.id,
          run.id,
          nextStatus,
        );
      }
    }

    return { run, case: updatedCase };
  }
}
