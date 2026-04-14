import test from "node:test";
import assert from "node:assert/strict";

import { runBenchmarkProfile } from "../../scripts/performance/lib/runner.mjs";

test("runBenchmarkProfile returns a bounded result for a synthetic workload", async () => {
  const result = await runBenchmarkProfile({
    profile: {
      id: "synthetic-safe",
      name: "Synthetic",
      family: "api",
      safetyTier: "safe",
      allowedEnvironmentClasses: ["local"],
      durationSeconds: 1,
      concurrency: 2,
      workloads: [{ kind: "synthetic", responseTimeMs: 5, failEvery: 0 }],
      requiredCollectors: [],
      budgets: [{ metric: "latency.p95", type: "max", threshold: 100, unit: "ms", severity: "fail" }],
    },
    environmentClass: "local",
    collectors: [],
  });

  assert.equal(result.status, "completed");
  assert.equal(typeof result.summary.latencyMs.p95, "number");
  assert.equal(typeof result.summary.throughputRps, "number");
  assert.equal(result.summary.errorRate, 0);
});
