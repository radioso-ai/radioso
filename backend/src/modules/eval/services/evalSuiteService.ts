import { isUsageLimitExceededError } from "../../../shared/domain/usageLimitPolicy.js";
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
  /** When set, only these cases are run (cost control). Unknown/foreign ids are
   * ignored. When omitted, the whole workspace runs. */
  caseIds?: string[];
  /** Per-run confirmation for the selected live-effect cases. Omitted by non-interactive callers. */
  allowLiveEffects?: boolean;
}

export interface EvalSuiteRunResult {
  results: EvalSuiteCaseResult[];
  summary: EvalSuiteSummary;
}

/**
 * Runs a batch of eval cases (all of them, or a selected subset) and reports the
 * workspace's aggregate pass rate. This is composition over the existing
 * single-case run path — it owns no scoring logic of its own, only the iteration
 * and the rollup.
 *
 * The summary always covers the whole workspace, not just the cases that ran:
 * running a subset moves those cases, and the headline reflects the resulting
 * state of the entire suite.
 */
export class EvalSuiteService {
  constructor(
    private readonly cases: EvalSuiteCaseSource,
    private readonly runner: EvalSuiteRunner,
    private readonly logger?: EvalSuiteReplayLoggerPort,
  ) {}

  async run(input: EvalSuiteRunInput): Promise<EvalSuiteRunResult> {
    const startedAtMs = Date.now();
    const mode = input.mode ?? "full_assistant";
    const allCases = await this.cases.listCases(input.workspaceId);

    const selection = input.caseIds ? new Set(input.caseIds) : null;
    const toRun = selection ? allCases.filter((c) => selection.has(c.id)) : allCases;

    const results: EvalSuiteCaseResult[] = [];
    // Post-run state per case that actually ran. The summary then maps over ALL
    // cases (ran → updated state, not-run → persisted state) so the headline is
    // the whole suite's rate, whatever subset was selected.
    const ranStates = new Map<string, Pick<EvalCase, "assertions" | "status">>();

    // Sequential by design: each full_assistant case run makes an LLM call, so
    // fanning out would risk provider rate limits and unbounded concurrent load.
    // Revisit with bounded concurrency if suites grow large.
    for (const evalCase of toRun) {
      if (evalCase.assertions.length === 0) {
        // Nothing to score — running would only burn an LLM round-trip.
        results.push({ caseId: evalCase.id, name: evalCase.name, status: "skipped", run: null, error: null });
        continue;
      }

      try {
        const outcome = await this.runner.execute({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          snapshotId: evalCase.snapshotId,
          caseId: evalCase.id,
          mode,
          allowLiveEffects: input.allowLiveEffects,
        });
        results.push({
          caseId: evalCase.id,
          name: evalCase.name,
          status: outcome.run.status,
          run: outcome.run,
          error: null,
        });
        ranStates.set(evalCase.id, outcome.case ?? evalCase);
      } catch (error) {
        // Running out of workspace quota is not a property of the case, so it is not isolated to
        // one. Every remaining case would refuse identically, and answering 200 with per-case
        // errors would tell the caller its suite ran when the workspace simply stopped being
        // allowed to spend — while the single-case run paths return the quota refusal. Let it out.
        if (isUsageLimitExceededError(error)) throw error;
        // One case failing to run must not abort the rest of the suite.
        // `execute` can throw before any run is recorded (missing snapshot,
        // lost agent identity, …), leaving the case's persisted status stale.
        // The summary must reflect *this run* — count the case as errored, not
        // its prior (possibly passing) status, so the rate matches the results.
        const message = error instanceof Error ? error.message : "Unknown run error";
        results.push({ caseId: evalCase.id, name: evalCase.name, status: "error", run: null, error: message });
        ranStates.set(evalCase.id, { assertions: evalCase.assertions, status: "error" });
      }
    }

    const summary = summarizeSuite(allCases.map((c) => ranStates.get(c.id) ?? c));

    this.logger?.info(
      {
        workspaceId: input.workspaceId,
        accountId: input.accountId ?? null,
        mode,
        ran: toRun.length,
        selected: selection ? selection.size : null,
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
