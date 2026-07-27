# Implementation Quickstart

## Order

1. Implement Phase 2 foundations with failing tests first.
2. Run the provider/current-model, transition/persistence, and
   vector/search/conformance slices in parallel after their shared contracts settle.
3. Serialize edits to settings presentation, composition, generated schema/OpenAPI,
   and docs.
4. Do not enable activation routes until benchmark evidence supplies the exact cutoff
   and qualifies the selected accelerated strategies.

## Focused Checks

```bash
cd backend
pnpm run test:unit
pnpm run test:integration
pnpm run test:contract
pnpm run build
```

```bash
cd frontend
pnpm test
pnpm run test:e2e -- provider-settings.spec.ts
pnpm run build
```

Run the two versioned performance fixtures with a recorded environment manifest:

```bash
pnpm exec vitest run tests/performance/embedding-index-benchmark.test.ts
pnpm exec vitest run tests/performance/vector-projection-benchmark.test.ts
```

Before PR handoff:

```bash
pnpm run ci:local -- origin/main
```

## Benchmark Record

`embedding-index-v1` must record seed, PostgreSQL/pgvector version, CPU/RAM/storage,
dimensions 768/1536/3072/>4000, 100k/1m corpora, filter selectivity, candidate depths
10/25/50/100, warm-up, five runs, p50/p95, exact baseline and deterministic recall.

`vector-projection-v1` must record fixed DB/backend fixtures, worker concurrency,
event rate, warm-up, duration, acknowledgment lag, throughput, retry and recovery.

## Scope Check

Before merging, verify no custom model/dimension/profile/backend control or public
rollback/rebuild endpoint appears in frontend, HTTP, SDK or MCP diffs, and no
production external vector adapter was added.
