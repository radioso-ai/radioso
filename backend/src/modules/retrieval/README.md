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

All Kysely pgvector casts, text reads, and distance expressions use
`shared/infra/kysely/pgVectorSql.ts`. The raw-SQL lint checks pgvector syntax in
Kysely templates and permits it only in that helper and the retrieval pgvector
adapter files, plus the canonical vector storage adapters that write and hydrate
projection records.

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
- `domain/vectorFilter.ts`: backend-neutral source and metadata filter contract
  shared by vector search, lexical search, and hydration.
- `domain/vectorSearch.ts`: hydrated retrieval candidate types shared by lexical,
  temporal, and candidate-preparation adapters.
- `domain/retrievalSourceFilter.ts`: shared source scoping values used by
  retrieval contracts and filter compilers.
- `domain/agentRetrievalScope.ts`: the single derivation of how one agent
  retrieves — source scope, answering behavior, and skill settings — plus the
  port composition adapts to load an agent. Every surface that runs retrieval
  on an agent's behalf reads scope from here, and
  `services/scopedRetrievalRun.ts` applies it so a named agent that cannot be
  resolved fails the run instead of silently measuring workspace defaults.
- `infra/pgVectorAdapter.ts`, `infra/chunkCandidateHydrator.ts`, and
  `infra/lexicalSearch.ts`: concrete search and hydration adapters.
  `domain/lexicalSomeTermsMatch.ts` is the pure half of lexical search: the
  terms, adjacent-word joins, term weights, and candidate scores the adapter's
  some-terms pass runs on (see Lexical Matching below).
- `infra/hnswIterativeScan.ts`: shared transaction wrapper that enables
  high-recall strict-order HNSW scanning for a filtered vector query, with a
  probe-once fallback for servers whose pgvector predates the setting.
- `services/vectorIndexReconciler.ts`: backend-neutral durable projection drain,
  checkpoint advancement, and bounded retry loop.

## Common Change Paths

- Query rewrite: `queryRewrite*`, `rewritePolicyService.ts`,
  `domain/lexicalQueryPlan.ts`, `domain/referentialSubjectAnchor.ts` (adds a
  referential turn's resolved subject to the retrieval queries). Turn routing is supplied to the conversation
  engine by chat's interpretation adapter; retrieval rewrite should only reshape
  retrieval queries. Trigger analysis is a separate retrieval-only stage so it can
  run alongside candidate retrieval after interpretation.
- Candidate ranking or filtering: `candidate*`, `metadataRuleScoringService.ts`,
  `rerankService.ts`.
- Context and prompt shape: `contextSelectionStage.ts`,
  `promptAssemblyStage.ts`, `promptBuilder.ts`. `domain/answerCandidatePool.ts`
  holds the one answer-candidate pool size formula (raised by `rerankTopK`,
  floored by the answer's passage target, `finalContextTopK` or
  `temporal.dateRangeListingContextTopK` for a range answer, and capped by
  `RETRIEVAL_BEHAVIOR.rerank.candidateLimit`) and `answerDocumentKey`, the
  document a passage counts against; `promptContextSelectorService.ts`
  then caps the final prompt at `finalContextTopK` passages (a range answer's
  quotas allow up to `temporal.dateRangeListingContextTopK`),
  `promptContextMaxPerDocument` per document, each at most
  `promptContextMaxCharsPerContext` characters. `vectorTopK` sets fetch depth
  before candidate preparation filters, boosts, and merges; the pool size
  bounds what reaches the answer.
- Date questions: the rewrite returns `temporalQueryMode` and an optional
  `requestedDateRange` (`domain/temporal/requestedDateRange.ts` validates it and
  places dated items against it). `candidateRetrievalStage.ts` runs the
  structured lookup through `domain/temporal/temporalCandidateRetrieval.ts`:
  any question with a requested range gets the range, ranked by similarity to
  the question's embedding (an exact sort in `infra/temporalCandidateRepository.ts`),
  and a listing question without one gets upcoming events from today.
  `candidatePreparationStage.ts` holds range candidates to the document scope
  and metadata rules and keeps them apart from the ranked list;
  `services/temporal/rangeAnswerComposer.ts` is the one place that composes a
  range answer's pool and the selector's quotas (the reserve outside the range,
  `temporal.dateRangeReservedOutsidePassages`, then the range, then a fill to
  `finalContextTopK`); it places each candidate once by its own chunk dates and
  returns one group per chunk (`range`, `reserved`, `outside`), and
  `PromptContextSelectorService.selectInStages` applies the quotas. `services/temporal/` boosts and orders by the same range. Integration coverage lives in
  `tests/integration/retrieval-temporal-candidates.integration.test.ts`.
- Diagnostics: `retrievalActivityTraceAssembler.ts`,
  `retrievalPipelineActivityTraceBuilder.ts`,
  `retrievalDiagnosticsStage.ts`.

## Candidate Score Model

Semantic and lexical scores keep their source-specific meanings until candidate
preparation:

- `semanticScore` is cosine similarity from vector search.
- `lexicalScore` is `ts_rank_cd / maxRank` within one lexical query call, so the top
  hit for a query is always `1.0`. It supports lexical-local comparisons.
- `lexicalRankScore` is the absolute PostgreSQL `ts_rank_cd` value.
- `fusedScore` is the normalized `[0, 1]` candidate score used for merged ordering
  and rerank fallback. The backward-compatible candidate `similarity` field mirrors
  this value.

Candidate preparation uses reciprocal source ranks and a bounded, explicit
secondary-source boost. Metadata and temporal boosts remain bounded in the same
range. The semantic similarity threshold still applies inside vector search before
semantic and lexical candidates are merged.

### Two lexical gates

`candidateScoring.ts` holds two lexical gates that answer different questions, so
they read different scores and disagree by design.

- **Fusion gate** — `fuseCandidateRanks` compares candidates against each other, so
  it reads the query-relative `lexicalScore` against
  `RETRIEVAL_BEHAVIOR.hybrid.lexicalFusionMinimumRelativeScore` (`0.2`). A candidate
  below the threshold contributes no lexical RRF term.
- **Evidence gate** — `hasUsefulCandidateEvidence` asks whether a turn found real
  lexical signal, which is an absolute question, so it reads `lexicalRankScore`
  against `RETRIEVAL_BEHAVIOR.hybrid.lexicalMinimumUsefulRankScore` (`0.05`). It
  feeds the trigger-backoff count in `candidatePreparationStage.ts` and a trace
  diagnostic in `retrievalActivityTraceAssembler.ts`; it never filters candidates.

A rare-term query scores every match far below the absolute floor. Its top hits
still fuse and rank against their peers, and they still register as thin evidence.

`lexicalScore` is normalized per lexical query call, and
`CandidatePreparationService.addSource` takes `Math.max` across branches, so a
multi-subquery turn lifts each branch's best hit to `1.0`. Each branch contributes
its own best candidate to the pooled set.

## Lexical Matching

`infra/lexicalSearch.ts` first runs the all-terms search: `plainto_tsquery` and
`phraseto_tsquery` per lexical option, every term required. Under `matchMode:
"all_or_some_terms"` (the pipeline's candidate retrieval), when it finds fewer than
`RETRIEVAL_BEHAVIOR.hybrid.lexicalSomeTermsBelowAllTermsMatches` chunks, a some-terms
pass follows and its hits are appended after the all-terms ones. The agentic
`lexical_search` tool asks for `all_terms`, which its prompt promises.

1. `buildSomeTermsLexicalQuery` splits the option into terms (letter and number
   runs, so user text never carries tsquery syntax; at most 32, `truncated` past
   that), adds each pair of adjacent words written as one, and keeps phrases and
   exclusions.
2. One statement counts the chunks in scope (capped at
   `lexicalSomeTermsScopeCountCap + 1`) and lists, for each alternative, the chunks in
   the same scope holding it (up to `lexicalSomeTermsTermMatchCap + 1`; past the cap
   only the count comes back).
3. `planSomeTermsRanking` weighs each term ln(chunks in scope / chunks holding it);
   a term that matches nothing or passes the count cap weighs 0. It keeps the
   `lexicalSomeTermsMaxRankedTerms` rarest weighted terms, picks the alternatives
   that define the ranked set (rarest first, within
   `lexicalSomeTermsRankedChunkBudget`), and sets two floors a chunk must clear: the
   `lexicalSomeTermsMinimumWeightShare` of the ranked weight, and the absolute
   `lexicalSomeTermsMinimumHeldWeight`.
4. `scoreSomeTermsCandidates` scores the chunks those alternatives list from the lists
   alone: the weight of the terms each holds, whether it holds every term by its own
   text, and the alternatives it is ranked against. It keeps the chunks that clear
   both floors.
5. A second statement drops candidates that left the scope or hold an excluded term,
   and ranks the rest by covered weight, then `ts_rank_cd` against the AND of the
   alternatives each chunk holds, the scale of an all-terms rank. When the query
   excludes words, it parses each candidate's text once to check all of them
   together. For the rank, it parses only the chunks heavy enough to make the cut.

The lookup in step 2 goes through the GIN index for every alternative. Each tsquery
reaches it as a value of its row in an `unnest` of the alternatives, so Postgres
plans one lookup for all of them without knowing the word. Planned on a literal
word, a term frequent elsewhere in the partition and rare in the workspace leads
Postgres to the workspace index instead, and it then parses the text of every chunk
in the workspace for that term. `tests/integration/lexical-search.integration.test.ts`
pins the plan on a mid-sized bilingual workspace that shares its partition with
another workspace. Right after a large ingestion, while new chunks sit in the GIN
index's pending list, Postgres can still prefer the workspace index until
autovacuum merges the list.

Both statements run in one transaction under `lexicalSomeTermsTimeoutMs`, applied
as a transaction-local `statement_timeout` sized to what is left of the budget,
which bounds those slow cases. The pass is skipped while the pool has waiting
clients (`connections_busy`). On a timeout or any other error the search keeps its
all-terms hits, logs a count-only warning (plus the SQLSTATE for a failure), and
reports the pass as `timed_out` or `failed`. The port returns
`{ matches, someTermsPass }`: `skipped` with its reason, `ran`, `timed_out`, or
`failed`, with its duration.

Every lexical hit carries `lexicalTermCoverage`: `all_terms` or `some_terms` (a hit
without the field holds every term). A some-terms row is `all_terms` only when the
query was not cut, every term matched something, and the chunk holds each term by
its own text; a chunk found through a join is `some_terms`. A some-terms hit's
`similarity` is the share of term weight it holds. Consumers that read a lexical hit
as "the chunk holds what was asked for" check the coverage:

- `fuseCandidateRanks` lets a some-terms hit contribute only as the secondary
  source, and `compareLexicalEvidence` ranks it after every all-terms hit. It lifts
  a candidate semantic search also found; on its own it ranks below every semantic
  candidate, so it reaches the answer pool only when semantic search returned fewer
  candidates than the pool holds.
- `hasUsefulCandidateEvidence` never counts it as lexical evidence.
- `candidatePreparationStage.ts` treats a filtered set holding only some-terms
  hits as empty for trigger backoff, drops them on a turn where nothing else was
  found (`holdsPrimaryEvidence`), and passes them over for a `lexicalBias:
  "preferred"` shape.
- The lexical trace stage reports `someTermsPass`, `someTermsPassSkipReason`,
  `someTermsPassDurationMs`, and `someTermsCandidateCount`; the candidate retrieval
  span reports `retrieval.candidates.lexical.some_terms.count`,
  `retrieval.lexical.some_terms_pass.{ran,timed_out,failed,connections_busy}.count`,
  and `retrieval.lexical.some_terms_pass.max_duration_ms`.

## Stage Timings

`candidateRetrievalStage.ts` issues the lexical searches before it awaits the query
embedding, then joins both channels per branch. Semantic and lexical work therefore
overlap, and each is timed around its own promises:
`semanticRetrievalStartedAtMs`, `semanticRetrievalDurationMs`,
`lexicalRetrievalStartedAtMs`, and `lexicalRetrievalDurationMs` ride the stage result
alongside `activeEmbeddingDurationMs`.

Read the two spans as concurrent. They start at different times, and their durations
can sum to more than the retrieval stage that contains them. A channel that issues no
work reports a duration of `0`.

`retrievalDiagnosticsStage.ts` forwards the durations to
`retrievalExecutionTelemetryService.ts` as telemetry metrics, and
`retrievalPipelineActivityTraceBuilder.ts` reads all four values off the stage result
to time the `semantic_*` and `lexical` activity trace stages.

## Tests

Focused starting points:

- `cd backend && pnpm test -- tests/unit/retrieval-pipeline-stages.test.ts`
- `cd backend && pnpm test -- tests/unit/retrieval-shape-resolver.test.ts`
- `cd backend && pnpm test -- tests/unit/hybrid-retrieval-search.test.ts`
- `cd backend && pnpm exec vitest run tests/unit/retrieval/candidateScoring.test.ts`
  for the fusion gate, the evidence gate, and rank fusion arithmetic.
- `cd backend && pnpm exec vitest run tests/unit/retrieval/retrievalPipelineActivityTraceBuilder.test.ts`
  and `tests/unit/candidate-retrieval-branches.test.ts` for measured stage timings.
- `cd backend && pnpm run test:integration` for end-to-end retrieval behavior.
- `cd backend && pnpm test -- tests/unit/retrieval/vectorIndexReconciler.test.ts`
  for projection drain and checkpoint callback behavior.

Use `pnpm run test:contract` when changing retrieval API response contracts.
