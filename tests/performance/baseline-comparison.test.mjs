import test from "node:test";
import assert from "node:assert/strict";

import { buildBaselineComparisonReport, loadResultArtifact } from "../../scripts/performance/lib/budgets.mjs";

test("loadResultArtifact reads and parses a result artifact", async () => {
  const report = await loadResultArtifact(
    new URL("../../specs/037-performance-benchmarking/contracts/benchmark-artifacts.md", import.meta.url),
    {
      readFile: async () =>
        JSON.stringify({
          summary: {
            latencyMs: { p50: 100, p95: 200, p99: 300 },
            throughputRps: 10,
            errorRate: 0,
            queueSummary: null,
          },
        }),
    },
  );

  assert.equal(report.summary.latencyMs.p95, 200);
});

test("buildBaselineComparisonReport returns an inconclusive verdict when the baseline is incompatible", () => {
  const comparison = buildBaselineComparisonReport({
    baselineArtifact: {
      profileId: "api-smoke",
      environmentClass: "local",
      summary: {
        latencyMs: { p50: 100, p95: 200, p99: 250 },
        throughputRps: 12,
        errorRate: 0,
        queueSummary: null,
      },
    },
    candidateArtifact: {
      profileId: "mixed-smoke",
      environmentClass: "local",
      summary: {
        latencyMs: { p50: 100, p95: 200, p99: 250 },
        throughputRps: 12,
        errorRate: 0,
        queueSummary: null,
      },
    },
    budgets: [],
  });

  assert.equal(comparison.overallVerdict, "inconclusive");
  assert.match(comparison.inconclusiveReasons[0], /profile/i);
});
