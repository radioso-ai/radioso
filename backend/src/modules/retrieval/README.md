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
shape, document processing, or user-facing assistant copy.

Vector indexing is a retrieval-owned adapter boundary. PostgreSQL remains the
canonical chunk store, while `VectorIndexPort` returns ranked chunk references
and `ChunkCandidateHydratorPort` hydrates those references from canonical
storage. pgvector is the default vector-index adapter; external vector backends
should implement the same candidate contract rather than returning hydrated
document rows directly.

Vector filters use the backend-neutral `VectorChunkFilter` shape. Metadata
filters are containment filters over JSON-compatible metadata values; adapters
may push them down for performance, but hydration remains the final enforcement
point for workspace, ready document state, source scope, metadata scope, and
embedding model.

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
- `domain/vectorIndex.ts`: vector-index lifecycle/search contract for adapters
  that return ranked chunk references.
- `domain/vectorFilter.ts`: backend-neutral source and metadata filter contract
  shared by vector search, lexical search, and hydration.
- `domain/vectorSearch.ts`: compatibility-only hydrated vector search contract
  for older callers.
- `domain/retrievalSourceFilter.ts`: shared source scoping values used by
  retrieval contracts and filter compilers.
- `infra/vectorSearch.ts`, `infra/chunkCandidateHydrator.ts`, and
  `infra/lexicalSearch.ts`: concrete search and hydration adapters.

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

Use `pnpm run test:contract` when changing retrieval API response contracts.
