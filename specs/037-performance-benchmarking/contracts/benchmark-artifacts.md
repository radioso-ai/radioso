# Benchmark Artifact Contracts

This file defines the design-time artifact shapes for benchmark profiles, run results, and baseline comparisons. These are internal tooling contracts, not HTTP API contracts.

## Benchmark Profile Manifest

```json
{
  "id": "mixed-smoke",
  "name": "Mixed Smoke",
  "family": "mixed",
  "environmentClass": ["local", "ci", "staging"],
  "safetyTier": "safe",
  "durationSeconds": 300,
  "concurrencyPlan": {
    "chatUsers": 10,
    "uploadBursts": 2,
    "searchUsers": 5
  },
  "datasetRef": "default-benchmark-fixtures",
  "collectorSet": ["http-core", "queue-backlog", "db-pool"],
  "budgetSet": ["mixed-smoke-default"]
}
```

## Benchmark Run Result

```json
{
  "runId": "2026-04-14T10-00-00Z-mixed-smoke",
  "profileId": "mixed-smoke",
  "environmentClass": "local",
  "status": "completed",
  "startedAt": "2026-04-14T10:00:00Z",
  "finishedAt": "2026-04-14T10:05:00Z",
  "revision": {
    "branch": "borohhov/message-queue-plan",
    "commit": "abc123"
  },
  "summary": {
    "latencyMs": { "p50": 120, "p95": 280, "p99": 490 },
    "throughputRps": 42.1,
    "errorRate": 0.01,
    "queueSummary": {
      "queuedJobCountPeak": 18,
      "processingJobCountPeak": 1,
      "oldestQueuedAgeMsPeak": 14000,
      "drainTimeMs": 23000
    },
    "dominantBottleneck": "worker",
    "verdict": "pass",
    "failureReasons": []
  }
}
```

## Baseline Comparison Result

```json
{
  "candidateRunId": "2026-04-14T10-00-00Z-mixed-smoke",
  "baselineId": "local-mixed-smoke-2026-04-01",
  "overallVerdict": "within_tolerance",
  "metricDiffs": [
    {
      "metricName": "latency.p95",
      "baseline": 260,
      "candidate": 280,
      "unit": "ms",
      "deltaPct": 7.69,
      "verdict": "within_tolerance"
    },
    {
      "metricName": "queue.oldestQueuedAgeMsPeak",
      "baseline": 9000,
      "candidate": 14000,
      "unit": "ms",
      "deltaPct": 55.56,
      "verdict": "regression"
    }
  ],
  "regressions": ["queue.oldestQueuedAgeMsPeak"],
  "improvements": [],
  "inconclusiveReasons": []
}
```

## Contract Notes

- The profile manifest is the source of truth for workload shape and allowed environments.
- Run results must remain bounded and summary-oriented; raw logs belong in separate artifacts if needed.
- Comparison outputs must distinguish `regression`, `improvement`, `within_tolerance`, and `inconclusive`.
