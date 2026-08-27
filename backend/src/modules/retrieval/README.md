# Retrieval Module

Retrieval owns the grounded search and answer pipeline. Start here when a
feature changes query interpretation, candidate retrieval, metadata scoring,
reranking, context selection, diagnostics, or retrieval answer assembly.

For the broader repository map, see
[`docs/architecture/code-map.md`](../../../../docs/architecture/code-map.md).

## Boundaries

Retrieval knows about search candidates, chunks, query plans, ranking signals,
retrieval settings, and the prompt context needed for grounded answers.

Retrieval should not own assistant persona, chat session lifecycle, HTTP request
shape, document processing, user-facing assistant copy, embedding provider
selection, model catalogs, dimensions, normalization, provider tasks, or
general-purpose embedding generation.

Retrieval consumes `QueryEmbeddingPort`: it supplies workspace/query context and
receives vectors paired with an opaque `EmbeddingSpaceRef`. Embedding Profiles
owns the translation from that context to a model, provider, dimension, and
generation request. Document and clustering callers use their own ports; do not
reuse the query port for those purposes.

Vector indexing is a retrieval-owned adapter boundary. PostgreSQL remains the
canonical vector store, while `VectorCandidateSearchPort` returns ranked chunk
references and `ChunkCandidateHydratorPort` hydrates those references from
canonical storage. pgvector is the default vector adapter; an external backend
such as Pinecone should implement the same capability, writer, candidate-search,
and administration ports rather than returning hydrated document rows directly.
Application composition owns the production adapter instance and binds
`VectorIndexReconciler` to worker lifecycle, bounded task recovery, and the
embedding-transition caught-up callback. Retrieval itself does not know settings
or profile activation rules. Pgvector exact search reads canonical
`chunk_embeddings`, so its caught-up correctness state is `exact_fallback`;
accelerated route qualification remains a separate performance gate.

Vector filters use the backend-neutral `VectorChunkFilter` shape. Metadata
filters are containment filters over JSON-compatible metadata values; adapters
may push them down for performance, but hydration remains the final enforcement
point for workspace, ready document state, source scope, metadata scope, and
embedding model.

Lexical retrieval remains live when query embedding or active-space vector
search is unavailable. Candidate retrieval returns lexical contexts with a
bounded semantic availability and failure code; diagnostics and telemetry may
report those codes but must not include provider errors, queries, or vectors.

## Public Surfaces

- `public.ts`: general retrieval-owned contracts and helpers for production code
  outside this module.
- `composition.ts`: construction helpers used by application composition.
- `llmAdapters.ts`: LLM-provider wiring used by composition and provider setup.
- `domain/`: retrieval domain types and pure domain services.

Production code outside this module should prefer these entry points over direct
imports from `services/` or `infra/`.

## Read First

- `services/retrievalPipelineService.ts`: high-level pipeline orchestration.
- `services/retrievalPipelineStages.ts`: stage construction and ordering.
- `services/retrievalSearchService.ts`: candidate search coordination.
- `services/retrievalAnswerService.ts`: retrieval answer assembly.
- `domain/vectorAdapter.ts`: backend-neutral capability, writer,
  candidate-search, and administration ports.
- `domain/vectorIndex.ts`: the model-keyed port the `chunks.embedding` search leg
  implements, kept until issue #1063 retires that leg.
- `domain/vectorFilter.ts`: backend-neutral source and metadata filter contract
  shared by vector search, lexical search, and hydration.
- `domain/vectorSearch.ts`: hydrated retrieval candidate types shared by lexical,
  temporal, and candidate-preparation adapters.
- `domain/retrievalSourceFilter.ts`: shared source scoping values used by
  retrieval contracts and filter compilers.
- `infra/pgVectorAdapter.ts`, `infra/chunkCandidateHydrator.ts`, and
  `infra/lexicalSearch.ts`: concrete search and hydration adapters.
- `infra/vectorSearch.ts`: the `chunks.embedding` search leg, merged into canonical
  results for the widths those columns hold.
- `infra/hnswIterativeScan.ts`: shared transaction wrapper that enables
  `hnsw.iterative_scan` for a filtered vector query, with a probe-once fallback for
  servers whose pgvector predates the setting.
- `services/vectorIndexReconciler.ts`: backend-neutral durable projection drain,
  checkpoint advancement, and bounded retry loop.

## Common Change Paths

- Query rewrite: `queryRewrite*`, `rewritePolicyService.ts`,
  `domain/lexicalQueryPlan.ts`. Turn routing is supplied to the conversation
  engine by chat's interpretation adapter; retrieval rewrite should only reshape
  retrieval queries. Trigger analysis is a separate retrieval-only stage so it can
  run alongside candidate retrieval after interpretation.
- Candidate ranking or filtering: `candidate*`, `metadataRuleScoringService.ts`,
  `attributeMatchScoringService.ts`, `rerankService.ts`.
- Context and prompt shape: `contextSelectionStage.ts`,
  `promptAssemblyStage.ts`, `promptBuilder.ts`.
- Diagnostics: `retrievalActivityTraceAssembler.ts`,
  `retrievalPipelineActivityTraceBuilder.ts`,
  `retrievalDiagnosticsStage.ts`.

## Candidate Score Model

Semantic and lexical scores keep their source-specific meanings until candidate
preparation:

- `semanticScore` is cosine similarity from vector search.
- `lexicalScore` is relative to the best lexical result for one query and is only
  suitable for lexical-local comparisons.
- `lexicalRankScore` is the absolute PostgreSQL `ts_rank_cd` value used for
  lexical quality gates.
- `fusedScore` is the normalized `[0, 1]` candidate score used for merged ordering
  and rerank fallback. The backward-compatible candidate `similarity` field mirrors
  this value.

Candidate preparation uses reciprocal source ranks and a bounded, explicit
secondary-source boost. Metadata and temporal boosts remain bounded in the same
range. The semantic similarity threshold still applies inside vector search before
semantic and lexical candidates are merged.

## Tests

Focused starting points:

- `cd backend && pnpm test -- tests/unit/retrieval-pipeline-stages.test.ts`
- `cd backend && pnpm test -- tests/unit/retrieval-shape-resolver.test.ts`
- `cd backend && pnpm test -- tests/unit/hybrid-retrieval-search.test.ts`
- `cd backend && pnpm run test:integration` for end-to-end retrieval behavior.
- `cd backend && pnpm test -- tests/unit/retrieval/vectorIndexReconciler.test.ts`
  for projection drain and checkpoint callback behavior.

Use `pnpm run test:contract` when changing retrieval API response contracts.
