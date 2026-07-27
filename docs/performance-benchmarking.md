---
title: "Performance Benchmarking"
description: "Repo-owned benchmark harness with profiles for API smoke tests, ingestion, chat traffic, and baseline comparison."
last_updated: 2026-07-27
---

# Performance Benchmarking

The benchmark harness lives under `scripts/performance/`. It drives repeatable
load against a Radioso instance — health-check pressure, document ingestion, and
public chat traffic — and compares each run against a saved baseline, so a
regression shows up as a number instead of a hunch.

The workloads, budgets, and baseline-comparison rules live in the repository,
while heavy execution can still run from an external runner or staging host.
Reach for a `safe` profile during local or CI smoke checks, a `guarded` profile
when you have credentials and want to exercise ingestion or chat, and a
`restricted` profile only against staging-like environments built to absorb the
pressure.

## Available commands

List profiles:

```bash
node scripts/performance/runProfile.mjs --list
```

Run a safe API smoke profile:

```bash
node scripts/performance/runProfile.mjs \
  --profile api-smoke \
  --environment local
```

Run an authenticated ingestion profile with queue metrics:

```bash
node scripts/performance/runProfile.mjs \
  --profile ingestion-smoke \
  --environment local \
  --email perf@example.com \
  --password changeme123 \
  --provision-account \
  --database-url postgres://postgres:postgres@localhost:5432/radioso
```

Run a public-chat profile:

```bash
node scripts/performance/runProfile.mjs \
  --profile chat-smoke \
  --environment local \
  --email perf@example.com \
  --password changeme123 \
  --provision-account
```

Compare a new run against a saved baseline:

```bash
node scripts/performance/compareBaseline.mjs \
  --baseline .context/performance-runs/baseline.json \
  --candidate .context/performance-runs/candidate.json
```

## Profile families

- `api-smoke`: safe unauthenticated health-check pressure.
- `ingestion-smoke`: guarded authenticated inline document ingestion.
- `chat-smoke`: guarded authenticated setup plus public chat traffic.
- `mixed-smoke`: guarded mixed health, ingestion, and public chat traffic.
- `api-stress`: restricted high-concurrency API pressure for shared environments.
- `mixed-soak`: restricted long-running mixed traffic with backlog awareness.

## Safety tiers

- `safe`: acceptable for routine local or CI smoke checks.
- `guarded`: requires explicit credentials or environment preparation.
- `restricted`: intended for staging-like or pre-release environments and
  requires `--allow-restricted`.

## Artifacts

Benchmark result artifacts are written to `.context/performance-runs/` by
default. These artifacts are machine-local and gitignored; they are meant for
comparison and collaboration inside the current workspace, not for versioned
storage.

## Notes

- Queue and backlog metrics require `--database-url` so the harness can query
  PostgreSQL with `psql`. If that collector is unavailable, backlog-aware
  profiles are marked inconclusive rather than pretending the data exists.
- Authenticated profiles use the normal session cookie plus `X-Workspace-Id`.
- Public chat profiles automatically enable anonymous chat for the benchmark
  workspace when possible and reuse the returned public URL token.
