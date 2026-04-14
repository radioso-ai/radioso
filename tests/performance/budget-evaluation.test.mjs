import test from "node:test";
import assert from "node:assert/strict";

import {
  compareResults,
  evaluateBudgets,
  summarizeResultForComparison,
} from "../../scripts/performance/lib/budgets.mjs";

test("evaluateBudgets fails when a hard threshold is exceeded", () => {
  const verdict = evaluateBudgets({
    budgets: [
      { metric: "latency.p95", type: "max", threshold: 250, unit: "ms", severity: "fail" },
      { metric: "errorRate", type: "max", threshold: 0.01, unit: "ratio", severity: "fail" },
    ],
    result: {
      latencyMs: { p50: 100, p95: 310, p99: 400 },
      throughputRps: 25,
      errorRate: 0,
      queueSummary: null,
    },
  });

  assert.equal(verdict.overallVerdict, "fail");
  assert.equal(verdict.metricVerdicts[0].verdict, "fail");
});

test("evaluateBudgets returns inconclusive when required metrics are missing", () => {
  const verdict = evaluateBudgets({
    budgets: [{ metric: "queue.oldestQueuedAgeMsPeak", type: "max", threshold: 5000, unit: "ms", severity: "fail" }],
    result: {
      latencyMs: { p50: 100, p95: 140, p99: 180 },
      throughputRps: 55,
      errorRate: 0,
      queueSummary: null,
    },
  });

  assert.equal(verdict.overallVerdict, "inconclusive");
  assert.match(verdict.reasons[0], /missing/i);
});

test("compareResults reports regressions, improvements, and within-tolerance changes", () => {
  const comparison = compareResults({
    baseline: summarizeResultForComparison({
      latencyMs: { p50: 100, p95: 250, p99: 420 },
      throughputRps: 20,
      errorRate: 0.01,
      queueSummary: {
        queuedJobCountPeak: 8,
        processingJobCountPeak: 1,
        oldestQueuedAgeMsPeak: 4000,
        drainTimeMs: 9000,
      },
    }),
    candidate: summarizeResultForComparison({
      latencyMs: { p50: 95, p95: 260, p99: 410 },
      throughputRps: 24,
      errorRate: 0.01,
      queueSummary: {
        queuedJobCountPeak: 9,
        processingJobCountPeak: 1,
        oldestQueuedAgeMsPeak: 7000,
        drainTimeMs: 9500,
      },
    }),
    budgets: [
      { metric: "latency.p95", type: "tolerance_band", threshold: 0.1, unit: "ratio", severity: "fail" },
      { metric: "throughputRps", type: "min", threshold: 18, unit: "rps", severity: "fail" },
      { metric: "queue.oldestQueuedAgeMsPeak", type: "max", threshold: 6000, unit: "ms", severity: "fail" },
    ],
  });

  assert.equal(comparison.overallVerdict, "regression");
  assert.ok(comparison.improvements.includes("throughputRps"));
  assert.ok(comparison.regressions.includes("queue.oldestQueuedAgeMsPeak"));
  assert.ok(
    comparison.metricDiffs.some(
      (metric) => metric.metricName === "latency.p95" && metric.verdict === "within_tolerance",
    ),
  );
});
