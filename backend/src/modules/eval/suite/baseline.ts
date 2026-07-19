import type { EvalRunStatus } from "../domain/types.js";

/**
 * The committed regression baseline. Maps each case id to the status it last held on
 * `main`. A run "regresses" only relative to this file, so day-to-day judge flakiness in
 * cases that were already failing does not fail the build — only a case that used to
 * pass and now does not.
 */
export interface BaselineFile {
  generatedAt?: string;
  cases: Record<string, EvalRunStatus>;
}

export interface CaseOutcome {
  caseId: string;
  name: string;
  status: EvalRunStatus;
}

export interface BaselineDiff {
  /** Was `pass`, now anything else — the only class that should fail CI. */
  regressions: Array<{ caseId: string; name: string; from: EvalRunStatus; to: EvalRunStatus }>;
  /** Was failing/erroring, now `pass`. */
  fixes: Array<{ caseId: string; name: string; from: EvalRunStatus; to: EvalRunStatus }>;
  /** Not present in the baseline — informational, never a regression. */
  newCases: CaseOutcome[];
  /** In the baseline but absent from this run — informational. */
  removed: string[];
  /** Present in both with an unchanged status. */
  unchanged: CaseOutcome[];
}

const isRegression = (from: EvalRunStatus, to: EvalRunStatus): boolean =>
  from === "pass" && to !== "pass";

const isFix = (from: EvalRunStatus, to: EvalRunStatus): boolean =>
  from !== "pass" && to === "pass";

export const diffAgainstBaseline = (
  current: CaseOutcome[],
  baseline: BaselineFile,
): BaselineDiff => {
  const diff: BaselineDiff = {
    regressions: [],
    fixes: [],
    newCases: [],
    removed: [],
    unchanged: [],
  };

  const seen = new Set<string>();
  for (const outcome of current) {
    seen.add(outcome.caseId);
    const previous = baseline.cases[outcome.caseId];
    if (previous === undefined) {
      diff.newCases.push(outcome);
      continue;
    }
    if (isRegression(previous, outcome.status)) {
      diff.regressions.push({ caseId: outcome.caseId, name: outcome.name, from: previous, to: outcome.status });
    } else if (isFix(previous, outcome.status)) {
      diff.fixes.push({ caseId: outcome.caseId, name: outcome.name, from: previous, to: outcome.status });
    } else {
      diff.unchanged.push(outcome);
    }
  }

  for (const caseId of Object.keys(baseline.cases)) {
    if (!seen.has(caseId)) {
      diff.removed.push(caseId);
    }
  }

  return diff;
};

/**
 * True once the baseline holds at least one recorded case. An uninitialized baseline
 * cannot gate — every case reads as "new" (informational) — so the runner treats a
 * run-mode invocation against an uninitialized baseline as a hard failure.
 */
export const isBaselineInitialized = (baseline: BaselineFile): boolean =>
  Object.keys(baseline.cases).length > 0;

export const buildBaselineFile = (current: CaseOutcome[], generatedAt: string): BaselineFile => {
  const cases: Record<string, EvalRunStatus> = {};
  for (const outcome of [...current].sort((left, right) => left.caseId.localeCompare(right.caseId))) {
    cases[outcome.caseId] = outcome.status;
  }
  return { generatedAt, cases };
};
