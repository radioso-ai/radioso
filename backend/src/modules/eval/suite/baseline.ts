import type { EvalRunStatus } from "../domain/types.js";

/**
 * The committed regression baseline. Maps each case id to the status it last held on
 * `main`. A run "regresses" only relative to this file, so day-to-day judge flakiness in
 * cases that were already failing does not fail the build — only a case that used to
 * pass and now does not.
 */
export interface BaselineFile {
  generatedAt?: string;
  cases: Record<string, BaselineCaseEntry>;
}

/**
 * What a sampled recorder writes: the reduced status plus the evidence it was reduced from.
 *
 * A status alone cannot distinguish a case that fails every time from one that fails two runs in
 * three, so a baseline of statuses hides both a stable failure becoming intermittent and an
 * intermittent one collapsing to never. The rate is the part a later run can compare against.
 */
export interface BaselineCaseRecord {
  status: EvalRunStatus;
  /** Fraction of samples that passed when this entry was recorded, in [0, 1]. */
  passRate?: number;
  samples?: number;
}

/** A bare status is the single-sample form; suites that do not sample still write it. */
export type BaselineCaseEntry = EvalRunStatus | BaselineCaseRecord;

export const baselineCaseStatus = (entry: BaselineCaseEntry): EvalRunStatus =>
  typeof entry === "string" ? entry : entry.status;

export const baselineCaseRate = (entry: BaselineCaseEntry): number | null =>
  typeof entry === "string" || entry.passRate === undefined ? null : entry.passRate;

export const baselineCaseSamples = (entry: BaselineCaseEntry): number | null =>
  typeof entry === "string" || entry.samples === undefined ? null : entry.samples;

export interface CaseOutcome {
  caseId: string;
  name: string;
  status: EvalRunStatus;
  /** Set by a sampled run: the fraction of samples that passed, and how many there were. */
  passRate?: number;
  samples?: number;
}

export interface BaselineDiff {
  /** Was `pass`, now anything else — the only class that should fail CI. */
  regressions: Array<{ caseId: string; name: string; from: EvalRunStatus; to: EvalRunStatus }>;
  /**
   * Held the same status, but passes materially less often than when the baseline was recorded.
   * The half of a drift a status comparison cannot see: a case recorded `fail` at two-in-three that
   * now never passes reads as "unchanged" forever.
   */
  rateRegressions: Array<{ caseId: string; name: string; from: number; to: number }>;
  /**
   * Would have been a regression, except this run sampled less deeply than the baseline did, so it
   * is not evidence of one. Informational, and the reason to re-run at the baseline's depth.
   */
  underSampled: Array<{ caseId: string; name: string; from: EvalRunStatus; to: EvalRunStatus; samples: number; baselineSamples: number }>;
  /** Was failing/erroring, now `pass`. */
  fixes: Array<{ caseId: string; name: string; from: EvalRunStatus; to: EvalRunStatus }>;
  /** Not present in the baseline — informational, never a regression. */
  newCases: CaseOutcome[];
  /** In the baseline but absent from this run — informational. */
  removed: string[];
  /** Present in both with an unchanged status. */
  unchanged: CaseOutcome[];
}

export interface BaselineDiffOptions {
  /**
   * How far a pass rate may fall before it is called a regression. Small sample counts make the
   * rate coarse — one sample of three moves it by a third — so the tolerance has to be wider than
   * the sampling noise it reads through, or the rate check reintroduces the false regressions
   * sampling exists to remove.
   */
  rateDropTolerance?: number;
}

const DEFAULT_RATE_DROP_TOLERANCE = 0.5;

const isRegression = (from: EvalRunStatus, to: EvalRunStatus): boolean =>
  from === "pass" && to !== "pass";

const isFix = (from: EvalRunStatus, to: EvalRunStatus): boolean =>
  from !== "pass" && to === "pass";

export const diffAgainstBaseline = (
  current: CaseOutcome[],
  baseline: BaselineFile,
  options: BaselineDiffOptions = {},
): BaselineDiff => {
  const tolerance = options.rateDropTolerance ?? DEFAULT_RATE_DROP_TOLERANCE;
  const diff: BaselineDiff = {
    regressions: [],
    rateRegressions: [],
    underSampled: [],
    fixes: [],
    newCases: [],
    removed: [],
    unchanged: [],
  };

  const seen = new Set<string>();
  for (const outcome of current) {
    seen.add(outcome.caseId);
    const entry = baseline.cases[outcome.caseId];
    if (entry === undefined) {
      diff.newCases.push(outcome);
      continue;
    }
    const previous = baselineCaseStatus(entry);
    if (isRegression(previous, outcome.status)) {
      // A run that sampled less deeply than the baseline cannot support a regression claim. The
      // bare smoke run is one sample, and a case that passes seven times in eight fails that single
      // sample often enough to report a regression against unchanged code — the same defect
      // sampling exists to remove. Surfaced as under-sampled so it reads as "re-run deeper", not as
      // "unchanged".
      const baselineSamples = baselineCaseSamples(entry);
      if (baselineSamples !== null && outcome.samples !== undefined && outcome.samples < baselineSamples) {
        diff.underSampled.push({
          caseId: outcome.caseId,
          name: outcome.name,
          from: previous,
          to: outcome.status,
          samples: outcome.samples,
          baselineSamples,
        });
        continue;
      }
      diff.regressions.push({ caseId: outcome.caseId, name: outcome.name, from: previous, to: outcome.status });
    } else if (isFix(previous, outcome.status)) {
      diff.fixes.push({ caseId: outcome.caseId, name: outcome.name, from: previous, to: outcome.status });
    } else {
      diff.unchanged.push(outcome);
      const previousRate = baselineCaseRate(entry);
      if (previousRate !== null && outcome.passRate !== undefined && outcome.passRate < previousRate - tolerance) {
        diff.rateRegressions.push({ caseId: outcome.caseId, name: outcome.name, from: previousRate, to: outcome.passRate });
      }
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
  const cases: Record<string, BaselineCaseEntry> = {};
  for (const outcome of [...current].sort((left, right) => left.caseId.localeCompare(right.caseId))) {
    cases[outcome.caseId] = outcome.status;
  }
  return { generatedAt, cases };
};
