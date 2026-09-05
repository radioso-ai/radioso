import type { EvalRunStatus } from "../domain/types.js";
import type { BaselineDiff, CaseOutcome } from "./baseline.js";
import type { SuiteAssertionVerdict } from "./scoring.js";
import { stringifyUnknown } from "../../../shared/text/stringifyUnknown.js";

export interface SuiteRunSummary {
  total: number;
  pass: number;
  fail: number;
  error: number;
  recorded: number;
  /** Fraction of *scored* (non-`recorded`) cases that passed, in [0, 1]. */
  passRate: number;
}

export interface CaseReport extends CaseOutcome {
  reason: string | null;
  verdicts: SuiteAssertionVerdict[];
  /** Set by the sampled runner: how many times the case ran, and how many passed. */
  samples?: number;
  passCount?: number;
  /** The samples disagreed — the reduced status was not unanimous. */
  flaky?: boolean;
}

export const summarizeRun = (outcomes: CaseOutcome[]): SuiteRunSummary => {
  const summary: SuiteRunSummary = { total: outcomes.length, pass: 0, fail: 0, error: 0, recorded: 0, passRate: 0 };
  for (const outcome of outcomes) {
    summary[outcome.status] += 1;
  }
  const scored = summary.pass + summary.fail + summary.error;
  summary.passRate = scored === 0 ? 1 : summary.pass / scored;
  return summary;
};

const STATUS_GLYPH: Record<EvalRunStatus, string> = {
  pass: "PASS",
  fail: "FAIL",
  error: "ERR ",
  recorded: "REC ",
};

const describeAssertion = (verdict: SuiteAssertionVerdict): string => {
  const assertion = verdict.assertion as { type: string } & Record<string, unknown>;
  const detail =
    assertion.documentId ??
    assertion.skillName ??
    assertion.routineId ??
    assertion.route ??
    assertion.verdict ??
    assertion.pattern ??
    assertion.stepId ??
    "";
  return detail ? `${assertion.type}(${stringifyUnknown(detail)})` : assertion.type;
};

/**
 * A plain-text report suitable for CI logs. Shows the headline pass rate, the
 * baseline diff (regressions first — that is what the exit code keys on), then a
 * per-case breakdown with the failing assertion reasons so a red run is actionable
 * without re-running anything by hand.
 */
export const formatReport = (
  cases: CaseReport[],
  diff: BaselineDiff,
  summary: SuiteRunSummary,
): string => {
  const lines: string[] = [];
  const pct = (summary.passRate * 100).toFixed(0);
  lines.push(`Conversation-quality suite: ${summary.pass}/${summary.pass + summary.fail + summary.error} scored cases passing (${pct}%).`);
  lines.push(
    `  pass=${summary.pass} fail=${summary.fail} error=${summary.error} recorded=${summary.recorded} total=${summary.total}`,
  );
  lines.push("");

  if (diff.regressions.length > 0) {
    lines.push(`REGRESSIONS (${diff.regressions.length}) — these fail the run:`);
    for (const regression of diff.regressions) {
      lines.push(`  ✗ ${regression.caseId} "${regression.name}": ${regression.from} → ${regression.to}`);
    }
    lines.push("");
  }
  if (diff.fixes.length > 0) {
    lines.push(`Fixes (${diff.fixes.length}):`);
    for (const fix of diff.fixes) {
      lines.push(`  ✓ ${fix.caseId} "${fix.name}": ${fix.from} → ${fix.to}`);
    }
    lines.push("");
  }
  if (diff.newCases.length > 0) {
    lines.push(`New (not in baseline): ${diff.newCases.map((entry) => entry.caseId).join(", ")}`);
  }
  if (diff.removed.length > 0) {
    lines.push(`Removed (in baseline, not run): ${diff.removed.join(", ")}`);
  }
  lines.push("");

  const flakyCount = cases.filter((report) => report.flaky).length;
  if (flakyCount > 0) {
    lines.push(`Flaky (samples disagreed): ${cases.filter((report) => report.flaky).map((report) => report.caseId).join(", ")}`);
    lines.push("");
  }

  lines.push("Per-case results:");
  for (const report of cases) {
    const sampleTag =
      report.samples && report.samples > 1
        ? ` (${report.passCount ?? 0}/${report.samples}${report.flaky ? ", flaky" : ""})`
        : "";
    lines.push(`  [${STATUS_GLYPH[report.status]}] ${report.caseId}${sampleTag} — ${report.name}`);
    if (report.status !== "pass") {
      for (const verdict of report.verdicts) {
        if (verdict.status !== "pass") {
          lines.push(`        · ${verdict.status}: ${describeAssertion(verdict)} — ${verdict.reason ?? ""}`);
        }
      }
    }
  }

  return lines.join("\n");
};
