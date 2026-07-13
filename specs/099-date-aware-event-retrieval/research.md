# Research: Date-Aware Event Retrieval

## Decision: One-call document enrichment contract

Use a single structured model call per enriched document that returns
classification plus shape-specific facts. The output is validated by Zod in
`backend/src/modules/documents/domain/enrichment/` before any metadata is
applied.

**Rationale**: The approved spec requires exactly one LLM call per document.
Keeping the schema in the documents domain lets processing consume a stable
contract while strategies remain pure and testable.

**Alternatives considered**:
- Classify first, then extract per shape: rejected because it violates the
  one-call requirement.
- Put extraction logic in `documentProcessingService.ts`: rejected because the
  service is an orchestrator and would absorb domain rules.

## Decision: `dateFrom`/`dateTo` are the only ingestion-to-retrieval contract

Event facts are applied to chunk metadata and article dates to document metadata
using the existing `dateFrom`/`dateTo` keys. Retrieval never imports ingestion
enrichment contracts.

**Rationale**: `searchTextRenderer.ts`, metadata-rule date handling, and
existing rerank guidance already understand these keys. This keeps retrieval
metadata-driven and multilingual.

**Alternatives considered**:
- New event-specific retrieval metadata shape: rejected because it would couple
  retrieval to ingestion internals.

## Decision: Per-chunk metadata and search text are foundational

The current processing path renders one document-level metadata search text and
copies document metadata to every chunk. This feature must produce final
metadata per chunk, then render search text per chunk before embedding and
persistence.

**Rationale**: Event dates may attach only to chunks overlapping the event text.
Embedding/search text must reflect the final chunk metadata, not only document
metadata.

**Alternatives considered**:
- Store temporal facts only at document level: rejected because it cannot answer
  the spec case where several events or dates appear in one document.

## Decision: Reprocess options live on job rows, not queue messages

Add nullable processing job options to `document_processing_jobs`. Dispatchers
continue to send the existing job-id message shape.

**Rationale**: The durable job table is authoritative for worker state, retries,
leases, and recovery. Options survive rescheduling of the same job without
changing AMQP or Cloud Tasks contracts.

**Alternatives considered**:
- Add options to `documentJobQueueMessageSchema`: rejected by the approved spec
  and would require wider queue contract changes.

## Decision: Temporal retrieval uses an indexed Postgres port

Add generated date columns on chunks derived from chunk metadata and query them
through a retrieval-owned temporal candidate port.

**Rationale**: JSONB containment cannot express date range comparisons and
ordering. Generated columns and indexes provide a stable lookup path while
keeping chunk storage canonical in Postgres.

**Alternatives considered**:
- Scan JSONB metadata in application code: rejected for correctness and scale.
- Encode dates into lexical search only: rejected because it cannot reliably
  exclude past events or sort future events.

## Decision: Temporal query mode comes from query interpretation

Extend structured rewrite output with a language-neutral mode such as
`temporalQueryMode: "listing" | "topic_refinement" | "none"` for date-shaped
event lookups.

**Rationale**: The repo forbids English keyword lists for product meaning.
Existing query rewrite already returns structured query shape and is the right
place for model-owned interpretation.

**Alternatives considered**:
- Detect "next/upcoming/sort" in code: rejected because Radioso is multilingual
  and the constitution forbids English product regexes.

## Decision: Settings are flat fields on `retrieval.answer`

Add `temporalStructuredLookupEnabled`, `temporalBoostUpcomingEnabled`, and
`temporalDeterministicSortEnabled` to retrieval defaults, per-agent override
schema, frontend serialization, and the retrieval skill manifest contract.

**Rationale**: This matches the existing agent-override-over-system-default
pattern and keeps retrieval behavior per agent, not workspace-level.

**Alternatives considered**:
- Nested `temporal` object: rejected because the approved spec requires flat
  fields consistent with existing settings shape.

## Decision: Workbench eval uses deterministic enriched fixtures

Seed fixture corpus and expected evidence/order independently of live provider
output. Live LLM output can vary, but retrieval evidence and staged order must
be deterministic.

**Rationale**: The feature success criteria are about retrieved evidence and
ordering. Tests mock LLM/clock; evals verify quality without coupling fixtures
to provider text.

**Alternatives considered**:
- Assert exact final answer prose: rejected because assistant copy is LLM-owned
  and multilingual.
