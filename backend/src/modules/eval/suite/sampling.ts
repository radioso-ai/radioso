import type { EvalLlmJudgePort } from "../services/evalJudge.js";
import type { EvalRunObservedOutput, EvalRunStatus } from "../domain/types.js";
import type { CaseOutcome } from "./baseline.js";
import type { ConversationQualityCase } from "./caseSchema.js";
import type { CaseReport } from "./report.js";
import type { ConversationQualityRunnerPort } from "./runnerPort.js";
import { scoreObservedOutput, type SuiteAssertionVerdict } from "./scoring.js";

export interface RunSampledOptions {
  workspaceId: string;
  /** Grader for `llm_judge` assertions; omit to run the deterministic layer only. */
  judge?: EvalLlmJudgePort;
  /** Number of times to run each case (K). Clamped to >= 1. */
  samples: number;
  /**
   * A case's reduced status is `pass` iff its per-sample pass rate is >= this threshold.
   * Default 1.0 (unanimous) makes the baseline conservative: only a case that passes
   * every sample is recorded as `pass`, so a flaky case can never sit in the baseline as
   * `pass` and later false-regress. Lower it to tolerate known variance.
   */
  passThreshold: number;
  runIdPrefix?: string;
}

interface SampleScore {
  status: EvalRunStatus;
  reason: string | null;
  verdicts: SuiteAssertionVerdict[];
}

export interface SampleReduction {
  status: EvalRunStatus;
  passCount: number;
  /** Fraction of *scored* (non-`recorded`) samples that passed, in [0, 1]. */
  passRate: number;
  flaky: boolean;
  reason: string | null;
  verdicts: SuiteAssertionVerdict[];
  statusCounts: Record<EvalRunStatus, number>;
}

/**
 * Collapses K per-sample scores into one stable verdict. A case with no assertions is
 * `recorded`. Otherwise it is `pass` when its pass rate clears the threshold; below
 * threshold it is `fail`, unless every non-pass sample errored (no real failures), which
 * surfaces as `error`. `flaky` means the samples disagreed — the signal that tells you a
 * `pass`/`fail` was not unanimous.
 */
export const reduceSamples = (samples: SampleScore[], passThreshold: number): SampleReduction => {
  const statusCounts: Record<EvalRunStatus, number> = { pass: 0, fail: 0, error: 0, recorded: 0 };
  for (const sample of samples) {
    statusCounts[sample.status] += 1;
  }

  const total = samples.length;
  if (total === 0 || statusCounts.recorded === total) {
    return { status: "recorded", passCount: 0, passRate: 1, flaky: false, reason: null, verdicts: [], statusCounts };
  }

  const scored = total - statusCounts.recorded;
  const passCount = statusCounts.pass;
  const passRate = passCount / scored;

  let status: EvalRunStatus;
  if (passRate >= passThreshold) {
    status = "pass";
  } else if (statusCounts.fail === 0 && statusCounts.pass === 0) {
    status = "error";
  } else {
    status = "fail";
  }

  const flaky = passCount > 0 && passCount < scored;
  // Prefer a failing/erroring sample for the report so the reason is actionable.
  const representative =
    samples.find((sample) => sample.status === "fail") ??
    samples.find((sample) => sample.status === "error") ??
    samples.find((sample) => sample.status === "pass") ??
    samples[0]!;

  return {
    status,
    passCount,
    passRate,
    flaky,
    reason: representative.reason,
    verdicts: representative.verdicts,
    statusCounts,
  };
};

export interface SampledSuiteResult {
  reports: CaseReport[];
  outcomes: CaseOutcome[];
}

/**
 * Runs every case K times and records the reduced (threshold-gated) status. This is the
 * gate-worthy path: sampling both when recording the baseline and when checking against
 * it means only reliably-passing cases are baseline-`pass`, so LLM run-to-run variance
 * stops producing false regressions. Runs are sequential to avoid tripping provider rate
 * limits; a throwing runner degrades that single sample to an `error`.
 */
export const runConversationQualitySuiteSampled = async (
  cases: ConversationQualityCase[],
  runner: ConversationQualityRunnerPort,
  options: RunSampledOptions,
): Promise<SampledSuiteResult> => {
  const samples = Math.max(1, Math.floor(options.samples));
  const reports: CaseReport[] = [];

  for (const evalCase of cases) {
    const sampleScores: SampleScore[] = [];
    for (let index = 0; index < samples; index += 1) {
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
        runId: `${options.runIdPrefix ?? "cq"}:${evalCase.id}:${index}`,
        judge: options.judge,
      });
      sampleScores.push(score);
    }

    const reduced = reduceSamples(sampleScores, options.passThreshold);
    reports.push({
      caseId: evalCase.id,
      name: evalCase.name,
      status: reduced.status,
      reason: reduced.reason,
      verdicts: reduced.verdicts,
      samples,
      passCount: reduced.passCount,
      flaky: reduced.flaky,
    });
  }

  const outcomes: CaseOutcome[] = reports.map(({ caseId, name, status }) => ({ caseId, name, status }));
  return { reports, outcomes };
};
