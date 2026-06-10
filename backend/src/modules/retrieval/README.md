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
- `domain/vectorSearch.ts`: backend-neutral vector search contract consumed by
  retrieval services.
- `domain/retrievalSourceFilter.ts`: shared source scoping values used by
  retrieval contracts and filter compilers.
- `infra/vectorSearch.ts` and `infra/lexicalSearch.ts`: concrete search
  adapters.

## Common Change Paths

- Query rewrite: `queryRewrite*`, `rewritePolicyService.ts`,
  `domain/lexicalQueryPlan.ts`. Turn routing belongs to the chat module's
  `TurnRouter`; retrieval rewrite should only reshape retrieval queries.
- Candidate ranking or filtering: `candidate*`, `metadataRuleScoringService.ts`,
  `attributeMatchScoringService.ts`, `rerankService.ts`.
- Context and prompt shape: `contextSelectionStage.ts`,
  `promptAssemblyStage.ts`, `promptBuilder.ts`.
- Diagnostics: `retrievalActivityTraceAssembler.ts`,
  `retrievalPipelineActivityTraceBuilder.ts`,
  `retrievalDiagnosticsStage.ts`.

## Tests

Focused starting points:

- `cd backend && pnpm test -- tests/unit/retrieval-pipeline-stages.test.ts`
- `cd backend && pnpm test -- tests/unit/retrieval-shape-resolver.test.ts`
- `cd backend && pnpm test -- tests/unit/hybrid-retrieval-search.test.ts`
- `cd backend && pnpm run test:integration` for end-to-end retrieval behavior.

Use `pnpm run test:contract` when changing retrieval API response contracts.
