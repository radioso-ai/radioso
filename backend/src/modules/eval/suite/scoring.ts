import { evaluateAssertion, isLlmJudgeAssertion } from "../domain/outcomes.js";
import type { EvalLlmJudgePort } from "../services/evalJudge.js";
import type {
  AssertionVerdictStatus,
  EvalAssertion,
  EvalRunObservedOutput,
  EvalRunStatus,
} from "../domain/types.js";
import {
  evaluateTraceAssertion,
  isTraceAssertion,
  type SuiteTraceAssertion,
} from "./traceAssertions.js";

/**
 * A suite assertion is either a shipped product assertion (retrieval/citation/answer/
 * llm_judge — scored by the eval domain) or a suite-only trace assertion. Keeping both
 * behind one union lets a single case mix a deterministic route check with a semantic
 * judge check.
 */
export type SuiteAssertion = EvalAssertion | SuiteTraceAssertion;

export interface SuiteAssertionVerdict {
  assertion: SuiteAssertion;
  status: AssertionVerdictStatus;
  reason: string | null;
}

export interface SuiteScore {
  status: EvalRunStatus;
  reason: string | null;
  verdicts: SuiteAssertionVerdict[];
}

export interface SuiteScoreContext {
  workspaceId: string;
  question: string;
  runId: string;
  accountId?: string | null;
  /**
   * Grader for `llm_judge` assertions. Optional so the deterministic layer runs with no
   * provider credentials; when absent, judge assertions resolve to `error` rather than
   * silently passing.
   */
  judge?: EvalLlmJudgePort;
}

/**
 * Mirrors {@link import("../domain/outcomes.js").combineVerdicts} for the widened suite
 * verdict type: error dominates fail dominates pass, and an empty set is `recorded`.
 */
const combine = (verdicts: SuiteAssertionVerdict[]): SuiteScore => {
  if (verdicts.length === 0) {
    return { status: "recorded", reason: null, verdicts };
  }
  const errored = verdicts.find((verdict) => verdict.status === "error");
  if (errored) {
    return { status: "error", reason: errored.reason, verdicts };
  }
  const failed = verdicts.find((verdict) => verdict.status === "fail");
  if (failed) {
    return { status: "fail", reason: failed.reason, verdicts };
  }
  return {
    status: "pass",
    reason: verdicts.length === 1 ? verdicts[0]!.reason : `All ${verdicts.length} assertions passed.`,
    verdicts,
  };
};

export const scoreObservedOutput = async (
  assertions: SuiteAssertion[],
  output: EvalRunObservedOutput,
  context: SuiteScoreContext,
): Promise<SuiteScore> => {
  if (output.error) {
    return {
      status: "error",
      reason: output.error.message,
      verdicts: assertions.map((assertion) => ({
        assertion,
        status: "error" as const,
        reason: output.error!.message,
      })),
    };
  }

  if (assertions.length === 0) {
    return { status: "recorded", reason: null, verdicts: [] };
  }

  const verdicts: SuiteAssertionVerdict[] = [];
  for (let index = 0; index < assertions.length; index += 1) {
    const assertion = assertions[index]!;
    if (isTraceAssertion(assertion)) {
      verdicts.push(evaluateTraceAssertion(assertion, output));
      continue;
    }
    if (isLlmJudgeAssertion(assertion)) {
      if (!context.judge) {
        verdicts.push({
          assertion,
          status: "error",
          reason:
            "llm_judge assertion requires a configured judge — run the suite with provider credentials.",
        });
        continue;
      }
      if (typeof output.answer !== "string") {
        verdicts.push({
          assertion,
          status: "error",
          reason: "llm_judge requires an answer; run the case in full_assistant mode.",
        });
        continue;
      }
      const verdict = await context.judge.judge({
        workspaceId: context.workspaceId,
        accountId: context.accountId ?? null,
        runId: context.runId,
        assertionIndex: index,
        assertion,
        observedAnswer: output.answer,
        question: context.question,
      });
      verdicts.push(verdict);
      continue;
    }
    verdicts.push(evaluateAssertion(assertion, output));
  }

  return combine(verdicts);
};
