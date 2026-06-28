import type { EvalCase } from "./types.js";

/**
 * Aggregate over a workspace's eval cases. Powers the headline pass rate
 * ("X of Y cases passing") on the suite list and the summary returned by a
 * suite run.
 *
 * Only cases that carry at least one expectation are "scored" — a case with no
 * expectations cannot pass or fail, so it is counted as `unscored` and excluded
 * from the rate. `scored` partitions exactly into passing/failing/error/pending.
 */
export interface EvalSuiteSummary {
  total: number;
  scored: number;
  passing: number;
  failing: number;
  error: number;
  pending: number;
  unscored: number;
}

export const summarizeSuite = (
  cases: ReadonlyArray<Pick<EvalCase, "assertions" | "status">>,
): EvalSuiteSummary => {
  const summary: EvalSuiteSummary = {
    total: cases.length,
    scored: 0,
    passing: 0,
    failing: 0,
    error: 0,
    pending: 0,
    unscored: 0,
  };

  for (const evalCase of cases) {
    if (evalCase.assertions.length === 0) {
      summary.unscored += 1;
      continue;
    }
    summary.scored += 1;
    switch (evalCase.status) {
      case "passing":
        summary.passing += 1;
        break;
      case "failing":
        summary.failing += 1;
        break;
      case "error":
        summary.error += 1;
        break;
      case "pending":
        summary.pending += 1;
        break;
    }
  }

  return summary;
};
