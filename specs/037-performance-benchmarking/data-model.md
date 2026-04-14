# Data Model: Performance Benchmarking

## Benchmark Profile

- **Purpose**: Defines one named, repeatable workload shape and the rules for where it can run.
- **Core fields**:
  - `id`: stable profile identifier
  - `name`: human-readable profile name
  - `family`: `api`, `chat`, `ingestion`, `mixed`, `stress`, or `soak`
  - `environmentClass`: allowed environment class such as `local`, `ci`, `staging`, or `pre_release`
  - `safetyTier`: `safe`, `guarded`, or `restricted`
  - `duration` or `completionCondition`: how long the workload runs or when it ends
  - `concurrencyPlan`: bounded shape for concurrency or request fanout
  - `datasetRef`: optional fixture or seed dataset used by the run
  - `collectorSet`: which metrics collectors run during this profile
  - `budgetSet`: which performance budgets apply
- **Validation rules**:
  - Profile IDs must be unique and stable across runs.
  - Restricted profiles must declare an environment class that allows them.
  - Mixed, stress, and soak profiles must declare backlog-aware collectors.

## Benchmark Run

- **Purpose**: Represents one execution of a benchmark profile against one environment.
- **Core fields**:
  - `id`: unique run identifier
  - `profileId`: owning benchmark profile
  - `startedAt`
  - `finishedAt`
  - `status`: `completed`, `failed`, `aborted`, or `inconclusive`
  - `environmentLabel`: human-readable target description
  - `environmentClass`
  - `radiosoRevision`: branch, commit, or version label under test
  - `operatorNotes`: optional context for the run
- **Relationships**:
  - One benchmark profile has many benchmark runs.
  - One benchmark run has one benchmark result summary and many metric samples.

## Metric Sample

- **Purpose**: Captures one measured signal or one aggregated measurement during a run.
- **Core fields**:
  - `runId`
  - `metricName`
  - `scope`: `api`, `chat`, `ingestion`, `queue`, `database`, or `external_dependency`
  - `value`
  - `unit`
  - `timestamp` or aggregation window
  - `source`: `http_load`, `db_snapshot`, `process_probe`, or `external_observation`
- **Validation rules**:
  - Samples must declare source and unit.
  - Queue and backlog metrics must identify the collector source explicitly.

## Benchmark Result

- **Purpose**: Bounded summary of a run suitable for reporting and baseline comparison.
- **Core fields**:
  - `runId`
  - `latency`: `p50`, `p95`, `p99`
  - `throughput`
  - `errorRate`
  - `queueSummary`: queued jobs, processing jobs, oldest queued age, drain time if applicable
  - `dominantBottleneck`: `api`, `db`, `worker`, `external_dependency`, or `unknown`
  - `verdict`: `pass`, `fail`, or `inconclusive`
  - `failureReasons`: bounded list
- **Relationships**:
  - One benchmark run has one benchmark result.
  - One benchmark result is evaluated against one budget set and optionally one baseline result.

## Performance Budget

- **Purpose**: Defines the acceptable envelope for one metric or metric family.
- **Core fields**:
  - `id`
  - `profileId` or `family`
  - `metricName`
  - `comparisonType`: `max`, `min`, `range`, or `tolerance_band`
  - `threshold`
  - `unit`
  - `severity`: `warn` or `fail`
- **Validation rules**:
  - Every committed profile must reference at least one budget.
  - Stress profiles may intentionally allow fail verdicts while still reporting the first saturation point.

## Baseline Result

- **Purpose**: Accepted comparison anchor for one profile in one environment class.
- **Core fields**:
  - `id`
  - `profileId`
  - `environmentClass`
  - `capturedFromRunId`
  - `capturedAt`
  - `summary`: bounded result snapshot
- **Validation rules**:
  - Baselines are only comparable within the same profile and environment class.
  - Baselines must record enough context to explain differences in hardware or provider mode.

## Benchmark Comparison

- **Purpose**: Explains how one run differs from a baseline or another run.
- **Core fields**:
  - `candidateRunId`
  - `baselineId` or `baselineRunId`
  - `metricDiffs`
  - `withinTolerance`
  - `regressions`
  - `improvements`
  - `inconclusiveReasons`
- **Validation rules**:
  - Comparisons must not claim a strict regression if required metrics are missing.
  - Inconclusive verdicts must explain whether noise, missing prerequisites, or external dependency variance caused the ambiguity.
