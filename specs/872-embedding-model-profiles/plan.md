# Implementation Plan: Generic Embedding Spaces and Vector Ports

**Branch**: `support-variable-embedding-dims` | **Date**: 2026-07-26 | **Spec**: [spec.md](./spec.md)  
**Input**: Approved specification in `specs/872-embedding-model-profiles/spec.md`

## Summary

Preserve the existing four-model ingestion-settings API and UI while replacing
1536-specific internals with immutable embedding spaces, full-precision
dimension-independent canonical embeddings, safe active/pending transitions, and
mandatory backend-neutral vector ports. PostgreSQL remains the system of record and
pgvector remains the only production vector adapter.

The existing model write starts an internal transition after a fixed-input provider
probe validates the selected catalog descriptor. Active vectors remain searchable
while resumable embedding-only jobs build pending vectors. Promotion is automatic and
generation-fenced after canonical coverage and index readiness are rechecked. No new
public model, dimension, profile, rollback, rebuild, or vector-backend resource is
introduced.

## Technical Context

**Language/Version**: TypeScript on Node.js 24; React 19/Next.js 16  
**Primary Dependencies**: Express, Zod, Kysely, PostgreSQL 16, pgvector, OpenAI SDK,
provider adapters, Pino, OpenTelemetry  
**Testing**: Vitest, Supertest, real-PostgreSQL integration tests, Playwright,
backend-neutral adapter conformance tests, reproducible performance fixtures  
**Storage**: PostgreSQL canonical chunks, immutable spaces/profiles, full-precision
vectors, durable jobs/outbox, transition and readiness state  
**Constraints**: Current four-model enum only; cosine only; observed dimensions
1–16,000 and descriptor/adapter-supported; no provider calls or bulk index DDL in
startup migrations or HTTP handlers; no document revision/status churn for
embedding-only work  
**Performance gates**: `embedding-index-v1` measures 768/1536/3072/>4000 dimensions,
100k/1m corpora, candidate depths 10/25/50/100, fixed selectivity, warm-up and five
measured runs; `vector-projection-v1` fixes DB/backend fixture, concurrency, event
rate, warm-up, and duration. Accelerated search targets p95 ≤1s at 100k and ≤2s at
1m, recall ≥98% unfiltered and ≥95% selective-filter. Benchmark evidence establishes
the exact-search cutoff and supported index routes before activation ships.

## Constitution Check

| Gate | Result | Evidence |
|---|---|---|
| Approved specification | PASS | Specification status is approved; this task creates planning artifacts only. |
| Backend TDD | PASS | Each implementation slice begins with failing unit, integration, contract, or conformance tests. |
| Existing public product contract | PASS | Current settings routes, shapes, permissions, SDK operations, MCP surface, and four-model UI remain compatible. |
| PostgreSQL/pgvector principle | PASS | PostgreSQL remains canonical and pgvector is the only production adapter. |
| Module boundaries | PASS | Settings owns internal lifecycle; providers own descriptors/probes/calls; Documents owns canonical chunks/jobs; Retrieval owns neutral vector ports/search; composition wires adapters. |
| Queue review | PASS | Durable job fields change, but identifier-only AMQP/Cloud Tasks payloads remain compatible and receive retry/idempotency regression tests. |
| Security/observability | PASS | Fixed non-customer probe input; no content, vectors, raw endpoints, credentials, or secret hashes in output. |
| Documentation | PASS | Existing settings behavior, transition semantics, indexing/degradation, queue behavior, and architecture docs are task-scoped updates. |

The Speckit agent-context updater is intentionally not run because this repository
forbids generated technology inventories or recent-change sections in `AGENTS.md`.

## Project Structure and Ownership

```text
backend/src/modules/
├── settings/                 # existing public setting; internal profile/transition lifecycle
├── documents/                # canonical chunks and durable embedding work
├── retrieval/                # neutral vector contracts, search, pgvector adapter
└── embeddingProfiles/        # immutable spaces, validation, lifecycle predicates
backend/src/shared/infra/llm/ # catalog descriptors and provider-specific mapping
backend/src/db/               # additive migrations and repositories
backend/src/app/composition/  # concrete provider and pgvector wiring
backend/tests/                # unit, integration, contract and conformance coverage
frontend/                     # compatibility-only UI behavior and Playwright regression
```

- `embeddingProfiles/domain` knows immutable compatibility identity, validation
  limits, generation fencing, coverage, quarantine, and cleanup predicates. It does
  not know HTTP, provider SDKs, SQL, pgvector, or UI.
- Settings continues to accept and return the current model fields. Its service
  delegates internal transition commands and maps lifecycle state back to the
  existing active/pending/failure/cancel presentation. No internal IDs escape.
- Provider infrastructure exposes an internal typed descriptor catalog for exactly
  the four current identifiers and a provider-neutral probe/embed port with explicit
  binding, purpose, descriptor and dimensions. Provider selection never uses model
  name prefixes.
- Embedding Profiles exposes the shared validated generation service and three
  consumer-specific ports: query embedding for Retrieval, document embedding for
  Documents, and clustering embedding for semantic chunking. These adapters bind
  model, provider, dimensions, and purpose before crossing into their consumers.
- Documents atomically creates active/pending embedding work with canonical chunk
  publication. A separate embedding-only processor never changes document revisions,
  ready status, canonical chunks, or enrichment.
- Retrieval exposes narrow mandatory capability, writer, candidate-search, and
  administration ports. Logical IDs, versioned mutations, portable filters,
  normalized cosine scores, and readiness cross the boundary; SQL, table/index names,
  SDK payloads, and backend controls do not. Retrieval's query-embedding dependency
  accepts workspace/text context only and returns an opaque space plus vector; it
  never exposes provider/model/dimension/purpose options.
- PostgreSQL repositories own transactions, compare-and-swap state, durable
  outbox/checkpoints, and reconciliation queries. The pgvector adapter searches
  canonical vectors directly and may acknowledge projection work in the canonical
  transaction.
- Application composition selects the descriptor/provider resolver and pgvector
  adapter. No lifecycle or product rules live there.

## Data and Rollout

Add ordered migrations after the current migration:

1. Immutable `embedding_spaces` and workspace-scoped internal
   `workspace_embedding_profiles`/`workspace_embedding_transitions`.
2. `chunk_embeddings` containing full-precision vectors per canonical chunk revision
   and embedding space, with dimensions and monotonic canonical version.
3. Pinned target profile/generation fields and a profile-aware uniqueness rule for
   embedding-only durable jobs.
4. Versioned `vector_index_work` and `vector_index_checkpoints` for future
   asynchronous projection and application-owned lag/rebuild state.

Migrations are additive and bounded. Legacy chunk vector columns/indexes and existing
settings fields stay readable/writable during shadow rollout. Background reconciliation
materializes equivalent legacy profiles from stored vectors, shadow-validates counts,
dimensions, candidates and scores, then performs workspace-scoped read cutover. Bulk
copy, provider backfill, and `CREATE INDEX CONCURRENTLY` run only as resumable
background work. Removal of legacy columns is a later feature.

## Provider and Transition Design

- The internal catalog contains only `text-embedding-3-small`,
  `text-embedding-3-large`, `text-embedding-ada-002`, and
  `gemini-embedding-001`.
- A fixed, non-customer probe is bounded to one input, 30 seconds, a 200-byte model
  identifier, dimensions 1–16,000, and a 128 KiB response. Production batches are
  split to descriptor/provider limits (maximum 256 inputs and 8 MiB response per
  request). Results must have the expected count, a single exact dimension, finite
  numeric values, non-zero cosine norm, and declared normalization tolerance.
- Space identity includes provider implementation, an opaque non-secret
  endpoint-scope fingerprint, model, dimensions, cosine semantics, normalization,
  document/query task mapping, vector-affecting options, and model-version signal.
  Credentials and raw endpoints are excluded; credential rotation within the same
  endpoint scope does not create a new space.
- An existing settings write requesting another supported model validates the
  descriptor, records at most one pending internal profile, and schedules resumable
  work. The existing API response supplies active/pending/failure state only.
- Publication, deletion, cancellation, promotion, and cleanup share a
  workspace/profile generation fence. Promotion automatically compare-and-swaps only
  after eligible current chunks have canonical vectors and the adapter checkpoint is
  ready. Cancellation and stale jobs become commit-time no-ops. Prior data is removed
  after a bounded seven-day grace period only when no live reference remains.

## Vector Strategy

- Candidate search is always scoped to the active embedding-space ID and hydrates
  canonical chunks for final authorization/filter enforcement.
- Scores are cosine similarity in `[-1,1]`, higher is better, minimum thresholds are
  inclusive, and ties use chunk ID.
- The pgvector adapter reads canonical `chunk_embeddings`. Benchmark-qualified
  routes may use `vector` HNSW through 2,000 dimensions, `halfvec` candidates through
  4,000 dimensions, or binary-quantized candidates above that; reduced/quantized
  routes oversample and rerank with canonical full-precision vectors. A route is not
  enabled until the committed matrix meets recall/latency gates.
- Exact search is permitted only below the benchmarked safety cutoff. A larger
  workspace without a ready qualifying route cannot activate the pending profile.
- Lexical search remains available during vector outage. Semantic search reports
  degraded/unavailable and never falls back to another profile.

## Durable Work, Rebuild, and Observability

Existing identifier-only queue messages remain unchanged. PostgreSQL durable jobs pin
profile, space, chunk/document revision, purpose, and workspace generation. Canonical
embedding/filter changes atomically create monotonic projection work. Duplicate or
out-of-order operations cannot resurrect tombstoned/superseded records. Application
reconciliation owns retries, acknowledged high-water marks, lag and scoped rebuild;
adapters only prepare/reset spaces, accept versioned mutations, search, and report
health/readiness.

Audit/operator events cover initialization, transition start/cancel/promote/failure,
cleanup and privileged rebuild. Bounded metrics cover backend, route, dimension bucket,
readiness, fallback, retry and outcome. Workspace/profile/job identifiers may appear
only in access-controlled logs/traces; content and secrets never do.

## Implementation Slices

1. **Foundation**: immutable domain, additive persistence, typed current-model catalog,
   generation fence, and neutral vector contracts/conformance harness.
2. **US1 — current models/dimensions**: provider-neutral validation/generation,
   explicit credential/endpoint resolution, canonical dimension-independent storage,
   legacy compatibility, and unchanged settings contract/UI regression.
3. **US2 — zero-downtime transition**: active/pending jobs, dual reconciliation,
   automatic fenced promotion, existing cancellation/failure presentation, cleanup.
4. **US3 — predictable retrieval**: active-space routing, pgvector exact/accelerated
   paths, readiness/degradation, canonical rerank/hydration, benchmark gates.
5. **US4 — stable vector ports**: versioned projection outbox, reconciliation,
   application-owned rebuild, in-memory external-style conformance adapter, composed
   pgvector default.
6. **Rollout/polish**: shadow cutover, observability, pinned pgvector runtime,
   documentation, generated unchanged-contract verification, and full local CI.

## Validation

- Unit tests: descriptors, fingerprints, validation, state machine, fencing, cleanup,
  score/filter semantics, version ordering.
- PostgreSQL integration: additive migrations, legacy materialization, canonical
  vectors across dimensions, atomic job/outbox creation, concurrency, transitions,
  pgvector search/readiness and reranking.
- Contract tests: unchanged ingestion-settings shapes/permissions/four-model enum and
  unchanged queue payload.
- Conformance: identical logical cases against in-memory external-style and pgvector
  adapters, including duplicates/out-of-order writes, metadata/eligibility/expiry
  changes, delete-before-upsert, stale candidates and complete `topK`.
- Playwright: existing four choices, model-change confirmation, active/pending display,
  cancellation and safe failure; no new controls or journeys.
- Performance: committed `embedding-index-v1` and `vector-projection-v1` reports must
  establish supported routes, recall, exact cutoff, throughput, lag, retry and recovery
  before enabling activation gates.

## Complexity Tracking

No constitution exception is required. The focused domain module and four narrow vector
ports are justified because the approved architecture explicitly requires lifecycle
and backend independence. No external production adapter, public profile API, public
rollback/rebuild UI, custom model, requested dimension, or backend selection is added.
