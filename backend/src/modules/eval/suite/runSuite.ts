import type { EvalLlmJudgePort } from "../services/evalJudge.js";
import type { CaseOutcome } from "./baseline.js";
import { conversationQualityCaseTurnText, type ConversationQualityCase } from "./caseSchema.js";
import type { CaseReport } from "./report.js";
import { observeCase, type ConversationQualityRunnerPort } from "./runnerPort.js";
import { scoreObservedOutput } from "./scoring.js";

interface RunSuiteOptions {
  workspaceId: string;
  /** Grader for `llm_judge` assertions; omit to run the deterministic layer only. */
  judge?: EvalLlmJudgePort;
  runIdPrefix?: string;
}

interface SuiteRunResult {
  reports: CaseReport[];
  outcomes: CaseOutcome[];
}

/**
 * Drives every case through the runner and scores it. Cases run sequentially — like the
 * product suite runner — so a live run does not fan out concurrent provider calls and
 * trip rate limits. A runner that throws degrades that single case to an `error` result
 * rather than aborting the whole suite. A `review` case runs through the runner's review
 * port (see {@link observeCase}).
 */
export const runConversationQualitySuite = async (
  cases: ConversationQualityCase[],
  runner: ConversationQualityRunnerPort,
  options: RunSuiteOptions,
): Promise<SuiteRunResult> => {
  const reports: CaseReport[] = [];

  for (const evalCase of cases) {
    const output = await observeCase(runner, evalCase);
    const score = await scoreObservedOutput(evalCase.assertions, output, {
      workspaceId: options.workspaceId,
      question: conversationQualityCaseTurnText(evalCase),
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
