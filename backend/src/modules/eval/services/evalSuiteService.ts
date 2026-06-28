import { summarizeSuite, type EvalSuiteSummary } from "../domain/suite.js";
import type { EvalCase, EvalRun, EvalRunMode, EvalRunStatus } from "../domain/types.js";
import type { EvalRunInput, EvalRunOutcome } from "./evalRunService.js";

/** Narrow port: the suite only needs to enumerate a workspace's cases. */
export interface EvalSuiteCaseSource {
  listCases(workspaceId: string): Promise<EvalCase[]>;
}

/** Narrow port: the suite delegates each case to the single-case run path. */
export interface EvalSuiteRunner {
  execute(input: EvalRunInput): Promise<EvalRunOutcome>;
}

export interface EvalSuiteReplayLoggerPort {
  info(fields: Record<string, unknown>, message: string): void;
}

/** "skipped" — case had no expectations, so it was not run (nothing to score). */
export type EvalSuiteCaseStatus = EvalRunStatus | "skipped";

export interface EvalSuiteCaseResult {
  caseId: string;
  name: string;
  status: EvalSuiteCaseStatus;
  run: EvalRun | null;
  /** Set only when the run could not be attempted/completed (e.g. snapshot gone). */
  error: string | null;
}

export interface EvalSuiteRunInput {
  workspaceId: string;
  accountId?: string | null;
  mode?: EvalRunMode;
}

export interface EvalSuiteRunResult {
  results: EvalSuiteCaseResult[];
  summary: EvalSuiteSummary;
}

/**
 * Runs every eval case in a workspace and reports an aggregate pass rate. This
 * is composition over the existing single-case run path — it owns no scoring
 * logic of its own, only the iteration and the rollup.
 */
export class EvalSuiteService {
  constructor(
    private readonly cases: EvalSuiteCaseSource,
    private readonly runner: EvalSuiteRunner,
    private readonly logger?: EvalSuiteReplayLoggerPort,
  ) {}

  async runAll(input: EvalSuiteRunInput): Promise<EvalSuiteRunResult> {
    const startedAtMs = Date.now();
    const mode = input.mode ?? "full_assistant";
    const cases = await this.cases.listCases(input.workspaceId);

    const results: EvalSuiteCaseResult[] = [];
    // Post-run case states feed the summary so the headline rate reflects this
    // run's outcomes, not the statuses we started with.
    const finalStates: Array<Pick<EvalCase, "assertions" | "status">> = [];

    // Sequential by design: each full_assistant case run makes an LLM call, so
    // fanning out would risk provider rate limits and unbounded concurrent load.
    // Revisit with bounded concurrency if suites grow large.
    for (const evalCase of cases) {
      if (evalCase.assertions.length === 0) {
        // Nothing to score — running would only burn an LLM round-trip.
        results.push({ caseId: evalCase.id, name: evalCase.name, status: "skipped", run: null, error: null });
        finalStates.push(evalCase);
        continue;
      }

      try {
        const outcome = await this.runner.execute({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          snapshotId: evalCase.snapshotId,
          caseId: evalCase.id,
          mode,
        });
        results.push({
          caseId: evalCase.id,
          name: evalCase.name,
          status: outcome.run.status,
          run: outcome.run,
          error: null,
        });
        finalStates.push(outcome.case ?? evalCase);
      } catch (error) {
        // One case failing to run must not abort the rest of the suite.
        const message = error instanceof Error ? error.message : "Unknown run error";
        results.push({ caseId: evalCase.id, name: evalCase.name, status: "error", run: null, error: message });
        finalStates.push(evalCase);
      }
    }

    const summary = summarizeSuite(finalStates);

    this.logger?.info(
      {
        workspaceId: input.workspaceId,
        accountId: input.accountId ?? null,
        mode,
        total: summary.total,
        scored: summary.scored,
        passing: summary.passing,
        failing: summary.failing,
        error: summary.error,
        skipped: results.filter((r) => r.status === "skipped").length,
        latencyMs: Date.now() - startedAtMs,
      },
      "Eval suite run completed",
    );

    return { results, summary };
  }
}
