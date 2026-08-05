# Implementation Plan: Audience Topic Census

**Spec**: `specs/956-audience-topic-census/spec.md`
**Algorithm**: `specs/956-audience-topic-census/algorithm.md`
**Created**: 2026-08-04
**Status**: Draft

## Summary

Replace Audience Pulse's 80-question sample with a census over every visitor
question in the window. A cheap per-message worker job extracts a normalized
facet; the facet is embedded and stored; each analysis clusters the whole
window with `@radioso/census`, matches the result against the previous
analysis to preserve topic identity, and asks the model only to name clusters.

Three things drive the sequencing. The facet extraction prompt is the
load-bearing risk and is validated by an eval fixture before anything is built
on it. There is no generic job bus in this repo, so per-message work needs its
own job spine. And the package boundary the spec demands is only real if CI
actually runs the package's tests, which today it does not.

## Technical Context

**Language / runtime**: TypeScript on Node.js 24, Postgres 16 with pgvector.

**New package**: `packages/census`. Root-level placement was considered
because the spec says "like `typescript-sdk`", but `pnpm-workspace.yaml` lists
root directories individually while `packages/*` is a glob, and every existing
pure-library workspace lives under `packages/`. The intended meaning —
`tsc` build, `vitest`, `src`/`tests` split, own `package.json` — is satisfied
under `packages/`. `packages/conversation-engine` is the closer template than
`typescript-sdk`: single `tsconfig.json`, `rootDir: "src"`, explicit
`vitest.config.ts`, and no DOM/browser typing split.

**Boundary enforcement**: two mechanisms, and the weaker one alone is not
enough.

`scripts/validate-architecture-boundaries.mjs` matches import specifiers by
regex over source text. It already scans `packages/`, so a
`validateCensusImport(record)` function plus its call site catches direct
imports.

`packages/conversation-kit/tests/entryPoints.test.ts` is the stronger
mechanism: it runs each `exports` entry in a fresh Node process under a
`node:module` loader hook and asserts the *actually resolved, transitive*
module graph against a declared budget. For census the budget is
`ALLOWED_EXTERNALS = { ".": [] }` — zero non-builtin modules, transitively.
That is what makes an `openai` import impossible rather than discouraged, and
it catches transitive arrivals that source-text matching misses.

**The gap that makes both decorative**: `scripts/local-ci-checks.sh` and
`.github/workflows/ci.yml` do not enumerate workspaces. Both hardcode seven
buckets (`backend frontend docs typescript_sdk mcp_server crawler ee`) and
match changed paths with a `case` statement. Most `packages/*` have no CI job
at all — they are only built as a prerequisite of backend tests, and their own
`vitest run` never executes in CI. Adding a `census` bucket to both files is
therefore not polish; without it the zero-dependency guarantee is unenforced.
`crawler` is the model to copy.

**Cheap model tier**: the repo already has one. `LlmCapabilityResolver`
resolves `"chat" | "rewrite" | "rerank" | "embeddings"`, and `"rewrite"` is
the cheap classifier tier used by the turn router
(`backend/src/shared/infra/llm/providerRegistry.ts`). Facet extraction uses
`"rewrite"`. `ContextualStructuredInferenceFactory`
(`shared/infra/llm/contextualGateways.ts:82`) is hardcoded to `"chat"`, so
this needs a sibling factory following `ContextualQueryRewriteGateway` rather
than reuse.

**Job spine**: `DocumentProcessingJobKind` is `"vectorize" | "enrich" |
"embedding_profile"`, keyed by document and revision. Facet extraction is
message-scoped and does not fit. It needs its own job table, repository,
dispatcher pair (AMQP plus Cloud Tasks, mirroring
`modules/documents/infra/amqpDocumentJobQueue.ts` and
`cloudTasksDocumentJobDispatcher.ts`), and a poll loop registered in
`backend/src/runtime/startWorkerRuntime.ts`. Application-level retry follows
`DocumentProcessingWorker.handleFailure` — three attempts, backoff
`[1s, 5s, 15s]`, permanent-versus-transient classification.

**Embeddings**: facets go through `ClusteringEmbeddingPort.embedForClustering`
(`modules/embeddingProfiles/contracts/embeddingConsumers.ts:85`), so the
dimension follows the workspace embedding profile and varies across
workspaces. Storage therefore uses the typeless `chunk_embeddings` shape — a
`vector` column plus a `dimensions` integer and a
`vector_dims(embedding) = dimensions` check — rather than a fixed `vector(N)`.

No vector index is needed anywhere in this feature. Clustering loads every
facet in the window and runs in memory; identity matching compares centroids
that are already loaded. There is no nearest-neighbour query against either
store, so an HNSW index would cost write throughput and buy nothing. This also
sidesteps the 2,000-dimension `vector` HNSW ceiling entirely. Facets store the
embedding profile identity so a profile change is detectable and re-embeddable
from retained text.

**Prompts**: drop a file under `backend/prompts/` and call
`loadPromptTemplate("<name>.md")`. No registration step — the
`generate-default-prompts.mjs` manifest applies only to
`backend/prompts/chat/`.

**Persistence**: Kysely only. `backend/scripts/checkNoRawSql.mjs` bans the raw
pg-pool surface outside a 12-file allowlist; the new repositories have no
reason to join it.

**Migrations**: `backend/src/db/migrations/NNN_snake_case.sql`, forward-only,
idempotent, applied in numeric order. Highest present is `136`, so this
feature starts at `137`. After adding a table, `pnpm --dir backend run
db:schema && pnpm --dir backend run db:types` regenerates `schema.sql` and
`schema.ts`; both require Docker and both are commit artifacts with CI drift
checks.

**Prerequisite outside this plan**: FR-016, reweighting the existing sampled
report, ships first as its own change.

## Constitution Check

| Constraint | How this plan satisfies it |
|---|---|
| Spec approved before implementation | Approved 2026-08-04. |
| Node backend, React frontend | Backend modules and worker in Node; the dashboard change is React. |
| PostgreSQL with pgvector | Facet embeddings use a fixed-width `vector(N)` column with a partial HNSW index. |
| GPT-5.2 default provider | Naming uses the default `"chat"` capability; extraction uses the existing `"rewrite"` cheap tier through the same resolver. |
| No hard-coded user-facing strings | Topic titles and descriptions are model-generated. Facets are model-generated. No keyword lists or English regexes anywhere in the pipeline. |
| Backend TDD | Every backend task in `tasks.md` is preceded by its failing test task. |
| Playwright for user-visible frontend behavior | The dashboard coverage and count changes get Playwright coverage; unit tests stay on the API adapter. |
| Secrets in `.env`, update `.env.example` | Facet job queue settings follow the existing document-job env pattern; `.env.example` updated in Phase 1. |
| Least-privilege customer data | Facets are PII-stripped by construction and no raw question text is persisted. |
| Shared dark theme and design tokens | The dashboard change reuses existing Audience Pulse components. |
| Modular boundaries | `@radioso/census` is pure algorithm; `audiencePulse` owns product judgement; `chat` owns history; repositories own persistence. |
| Responsibility-limited files named | See Module Ownership & Seams. |

## Project Structure

### Documentation (this feature)

```
specs/956-audience-topic-census/
├── spec.md
├── algorithm.md
├── plan.md
└── tasks.md
```

### Source Code (repository root)

```
packages/census/                          # NEW — zero runtime dependencies
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                          # public surface
│   ├── kmeans.ts                         # seeded k-means++, deterministic
│   ├── cluster.ts                        # k derivation, hierarchy, radii
│   ├── identity.ts                       # overlap matching, transitions
│   └── types.ts
└── tests/
    ├── kmeans.test.ts
    ├── cluster.test.ts
    ├── identity.test.ts
    └── entryPoints.test.ts               # zero-dependency budget
        support/{traceEntry.mjs,entryGraphHook.mjs}

backend/src/db/migrations/
└── 137_topic_census.sql                  # NEW

backend/src/db/repositories/
├── messageFacetRepository.ts             # NEW
├── topicRepository.ts                    # NEW
└── facetExtractionJobRepository.ts       # NEW

backend/src/modules/audiencePulse/
├── contracts.ts                          # sample policy retires
├── services/
│   ├── audiencePulseService.ts           # census replaces sampling
│   ├── censusService.ts                  # NEW — orchestrates the census
│   └── prompt.ts                         # naming prompt narrows
└── domain/report.ts                      # exact counts and shares

backend/src/modules/facets/               # NEW module
├── contracts.ts
├── services/facetExtractionService.ts
├── infra/{amqpFacetJobQueue.ts,cloudTasksFacetJobDispatcher.ts}
└── composition.ts

backend/prompts/
├── facet-extraction.md                   # NEW
└── audience-pulse.md                     # narrowed to naming

backend/tests/{unit,integration,contract}/{audiencePulse,facets}/
tests/unit/eval-suite/                    # facet quality fixture

frontend/components/dashboard/audience-pulse-view.tsx
frontend/lib/api-audience-pulse.ts

scripts/{validate-architecture-boundaries.mjs,local-ci-checks.sh}
.github/workflows/ci.yml
```

### Data

Four tables in migration `137`.

**`message_facets`** — one row per eligible visitor message. Columns:
`message_id` (PK, FK), `workspace_id`, `facet_text`, `embedding vector(N)`,
`prompt_version`, `embedding_profile_id`, `created_at`. Partial HNSW index on
`embedding WHERE embedding IS NOT NULL`; index on
`(workspace_id, prompt_version)` for staleness sweeps. No raw question text.

**`topics`** — persistent, workspace-scoped. `id` (PK), `workspace_id`,
`centroid vector(N)`, `radius`, `title`, `description`, `created_run_id`,
`last_seen_run_id`, `dissolved_at`. Dissolved topics are retained so a
returning topic is recognizable.

**`topic_memberships`** — `run_id`, `topic_id`, `message_id`, `distance`.
Composite PK on `(run_id, message_id)`, which enforces that a question belongs
to at most one topic per run.

**`topic_transitions`** — `run_id`, `topic_id`, `kind`
(`survived|split|merged|emerged|dissolved`), `parent_topic_ids`.

**`facet_extraction_jobs`** — `id`, `message_id`, `workspace_id`, `status`,
`attempt_count`, `claimed_at`, `scheduled_at`, `last_error`. Mirrors the shape
of `document_processing_jobs`.

## Module Ownership & Seams

**`packages/census` knows**: vectors, ids, cluster arithmetic, identity
matching. **Must not know**: visitors, grounding, workspaces, reports,
Postgres, any provider. Its input is `(id, text, vector)` triples plus an
embedding function and a naming function. Enforced by the entry-point budget
test, not by review.

**`backend/src/modules/facets` knows**: how to turn a message into a stored
facet, and how to run that asynchronously. **Must not know**: clustering,
topics, or what a facet is used for.

**`backend/src/modules/audiencePulse` knows**: which questions are eligible,
what a topic means to an operator, how a report reads. It owns the product
judgement the package deliberately excludes.

**Must stay responsibility-limited**:
`backend/src/modules/chat/audiencePulseHistorySource.ts` stays a history
reader. Its sampling code retires rather than growing clustering awareness.
`audiencePulseService.ts` stays orchestration; the census steps live in
`censusService.ts`.

**Anti-goals**: no clustering in the pulse service, no Radioso types in the
package, no raw question text in the facet store, no model call that partitions
the population, and no raising of the sample cap as a substitute.

## Complexity Tracking

| Area | Why it is not simpler |
|---|---|
| A new job spine | No generic job bus exists; `DocumentProcessingJobKind` is document-and-revision keyed. A message-scoped job needs its own table, dispatchers, and loop. This is the largest single cost in the plan and is the price of per-message async work in this repo. |
| Four tables | Facets, topics, memberships, and transitions are genuinely distinct lifetimes: facets outlive runs, topics outlive runs and are mutable, memberships are per-run, transitions are per-run history. Collapsing any pair would mix them. |
| A separate package | Requested explicitly, and it is what makes the boundary mechanically checkable. The cost is CI wiring in two files. |
| Identity matching | Bipartite matching over containment ratios is more than nearest-centroid, and it is what makes topics trackable rather than renamed every run. |

Deliberately *not* built: mini-batch k-means, incremental assignment,
re-clustering triggers, UMAP, density-based clustering, and topic hierarchy
beyond a single agglomeration to the top level. At order 1,000 questions per
month a full re-cluster is affordable; `algorithm.md` records the threshold
(roughly 100,000 per window) where that stops being true.
