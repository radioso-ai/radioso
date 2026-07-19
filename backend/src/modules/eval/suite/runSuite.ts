import type { EvalLlmJudgePort } from "../services/evalJudge.js";
import type { EvalRunObservedOutput } from "../domain/types.js";
import type { CaseOutcome } from "./baseline.js";
import type { ConversationQualityCase } from "./caseSchema.js";
import type { CaseReport } from "./report.js";
import type { ConversationQualityRunnerPort } from "./runnerPort.js";
import { scoreObservedOutput } from "./scoring.js";

export interface RunSuiteOptions {
  workspaceId: string;
  /** Grader for `llm_judge` assertions; omit to run the deterministic layer only. */
  judge?: EvalLlmJudgePort;
  runIdPrefix?: string;
}

export interface SuiteRunResult {
  reports: CaseReport[];
  outcomes: CaseOutcome[];
}

/**
 * Drives every case through the runner and scores it. Cases run sequentially — like the
 * product suite runner — so a live run does not fan out concurrent provider calls and
 * trip rate limits. A runner that throws degrades that single case to an `error` result
 * rather than aborting the whole suite.
 */
export const runConversationQualitySuite = async (
  cases: ConversationQualityCase[],
  runner: ConversationQualityRunnerPort,
  options: RunSuiteOptions,
): Promise<SuiteRunResult> => {
  const reports: CaseReport[] = [];

  for (const evalCase of cases) {
    let output: EvalRunObservedOutput;
    try {
      output = await runner.run(evalCase);
    } catch (err) {
      output = {
        retrievedChunks: [],
        error: { message: err instanceof Error ? err.message : "Runner threw a non-Error value." },
      };
    }

    const score = await scoreObservedOutput(evalCase.assertions, output, {
      workspaceId: options.workspaceId,
      question: evalCase.query,
      runId: `${options.runIdPrefix ?? "cq"}:${evalCase.id}`,
      judge: options.judge,
    });

    reports.push({
      caseId: evalCase.id,
      name: evalCase.name,
      status: score.status,
      reason: score.reason,
      verdicts: score.verdicts,
    });
  }

  const outcomes: CaseOutcome[] = reports.map(({ caseId, name, status }) => ({ caseId, name, status }));
  return { reports, outcomes };
};
