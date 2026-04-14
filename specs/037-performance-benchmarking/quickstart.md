# Quickstart: Performance Benchmarking

## Goal

Run repeatable benchmark profiles against Radioso, save bounded results, and compare new runs against an accepted baseline without editing app code.

## Preconditions

- The local or target environment is running the Radioso stack you want to test.
- The benchmark dataset or fixture set required by the selected profile is available.
- The selected profile is allowed in the chosen environment class.
- Any required provider credentials or mock-mode configuration are already set.

## Local smoke workflow

1. Start the local stack using the normal development flow.
2. Run a safe benchmark profile such as `api-smoke`, `chat-smoke`, or `ingestion-smoke`.
3. Verify that the run writes a bounded result artifact under `.context/performance-runs/`.
4. Review the printed report for latency, throughput, error rate, and backlog signals.

Expected outcome:
- The benchmark completes in a short bounded window.
- The result includes a profile name, environment class, core metrics, and a pass, fail, or inconclusive verdict.

## Save a baseline

1. Run a benchmark profile in a stable environment class.
2. Review the result and confirm it is suitable as a comparison anchor.
3. Save or mark that run as the accepted baseline for that profile and environment class.

Expected outcome:
- Later runs of the same profile in the same environment class can compare against the saved baseline.

## Compare a change against the baseline

1. Run the same profile after a code or configuration change.
2. Invoke the comparison flow against the accepted baseline.
3. Review the per-metric comparison verdicts.

Expected outcome:
- The comparison identifies improvements, regressions, within-tolerance changes, or an inconclusive result.

## Stress and soak workflows

1. Choose a stress or soak profile that is explicitly allowed in the target environment class.
2. Confirm the required guardrails before execution.
3. Run the profile and let it complete or stop it according to the profile’s completion rule.
4. Review saturation point, backlog growth, error behavior, and recovery signals.

Expected outcome:
- The result shows where the system began to violate budgets or lose stability, not only a single average latency number.

## Failure handling

- If required prerequisites are missing, the benchmark should fail with a bounded setup error instead of partial output.
- If a run cannot support a trustworthy comparison, it should be marked `inconclusive` with the reason recorded.
- If a restricted profile is selected in the wrong environment class, the benchmark should refuse to start.
