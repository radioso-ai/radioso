# Feature Specification: Date-Aware Event Retrieval via Shape-Aware Ingestion Enrichment

**Feature Branch**: `date-aware-event-retrieval` (Speckit feature number 099)
**Created**: 2026-07-02
**Status**: Draft
**Input**: User description: "People often ask about date-bound events. Dates are plain prose in the text and may not be in the same chunk as the event introduction. Improve retrieval of time-bound materials so that 'What are the next events?' and 'Can you sort events by actuality?' get good results. Ingested docs are not only event-shaped (personal profiles, blog articles, etc.); the ingestion LLM must understand the doc shape and route it to a known strategy. Enrichment must be switchable per source and during document reprocessing. One LLM call per document. All retrieval-side temporal behavior must be selectable in the retrieval skill settings."

## Owner Decisions (binding)

- Exactly **one LLM call per document** for enrichment (shape classification and fact
  extraction in a single structured call).
- Enrichment is **disabled by default** at the workspace level; operators opt in.
- Enrichment is switchable **per source** and **per reprocess request**; a
  **per-source reprocess** action is in scope.
- All retrieval-side temporal behavior is **selectable per agent** in the retrieval
  skill settings (`structuredLookup`, `boostUpcoming`, `deterministicSort`), with
  system defaults **on**.
- **Workbench eval cases** for event queries against an enriched fixture corpus are
  in scope.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Shape-aware ingestion enrichment with temporal extraction (Priority: P1)

A workspace operator whose corpus contains event announcements (alongside profiles,
blog articles, and reference pages) enables "document enrichment" for their website
source and reprocesses it. During processing, each document is classified into a
known shape (event, article, profile, reference, generic) and, for shapes with
temporal meaning, the dates written in prose are extracted, normalized, and attached
to the parts of the document they describe — including when the date sentence sits
far from the event's introduction. Afterward, a visitor asking "When does the summer
workshop take place?" gets a grounded answer with the correct date, even though the
date appeared three paragraphs below the workshop description.

**Why this priority**: Nothing downstream can be time-aware while dates exist only
as prose. Extraction activates already-existing retrieval machinery (date-aware
search text, recency-aware reranking, date-comparison rules) with no further
changes, so this story alone delivers user-visible improvement.

**Independent Test**: Ingest a fixture document whose event date is stated in a
different paragraph than the event name, with enrichment enabled. Verify the
stored chunks covering the event carry the normalized date range, and that a
date question about the event is answered correctly in chat.

**Acceptance Scenarios**:

1. **Given** enrichment is enabled for a source and a document announcing an event
   with its date stated in a separate paragraph, **When** the document is
   processed, **Then** every stored chunk overlapping the event's text carries the
   normalized event date range, and the document records its detected shape.
2. **Given** a processed event document, **When** a user asks when the event takes
   place (in any supported language), **Then** the assistant answers with the
   correct date.
3. **Given** a personal profile or generic document, **When** it is processed with
   enrichment enabled, **Then** it is classified to its shape, no temporal facts
   are fabricated, and processing completes normally.
4. **Given** a blog article with a publication date, **When** it is processed with
   enrichment enabled, **Then** the publication date is attached at document level.
5. **Given** a document whose text states a relative date ("next Friday"), **When**
   it is processed, **Then** the date is resolved against the document's sync or
   creation time and the resolution anchor is recorded.
6. **Given** the enrichment step fails (provider error, malformed output), **When**
   the document is processed, **Then** the document still completes processing
   unenriched, the failure is recorded for the operator, and no user-facing flow
   breaks.

---

### User Story 2 - Enrichment control per workspace, source, and reprocess (Priority: P1)

An operator controls enrichment cost and behavior: a workspace-level default
(disabled on new workspaces), a per-source override (e.g. on for the events
website, off for the uploaded HR handbook), and a per-request override when
reprocessing a single document or a whole workspace. The operator can also
reprocess a single source's documents in one action, so "turn enrichment on for
this source and re-run it" is a two-step task.

**Why this priority**: Enrichment adds one LLM call per document; without opt-in
granularity operators cannot adopt it safely. The per-source reprocess action is
what makes the per-source toggle actionable.

**Independent Test**: Toggle enrichment on for one source of two, reprocess that
source, and verify only its documents gained temporal metadata while the other
source's documents were untouched.

**Acceptance Scenarios**:

1. **Given** a new workspace, **When** documents are ingested, **Then** no
   enrichment runs and processing behavior is unchanged from today.
2. **Given** workspace enrichment is off but a source's override is on, **When**
   that source's documents are processed, **Then** enrichment runs for them and
   not for documents of other sources.
3. **Given** a reprocess request with an explicit enrichment override, **When**
   the document is reprocessed, **Then** the override wins over both the source
   override and the workspace default, for that run only.
4. **Given** a document previously enriched, **When** it is reprocessed with
   enrichment off, **Then** its rebuilt chunks and document metadata carry no
   stale temporal enrichment.
5. **Given** a source with many documents, **When** the operator triggers
   reprocess for that source, **Then** all its eligible documents are requeued and
   the response reports how many were queued, without touching other sources.

---

### User Story 3 - "What are the next events?" returns upcoming events in order (Priority: P2)

A website visitor asks the agent "What are the next events?" (or the equivalent in
another language) without naming any event. The agent returns upcoming events from
the enriched corpus in ascending date order, excluding events that have already
passed, grounded in the source documents. Agent operators can switch each temporal
retrieval behavior on or off per agent in the retrieval skill settings.

**Why this priority**: Depends on Story 1's metadata. This is the headline query
the feature exists for: listing queries have no semantic anchor, so similarity
search alone cannot answer them reliably.

**Independent Test**: Against an enriched fixture corpus with past and future
events, ask "what are the next events?" and verify the answer lists only future
events, soonest first; flip each per-agent temporal toggle off and verify the
corresponding behavior deactivates.

**Acceptance Scenarios**:

1. **Given** an enriched corpus with three future and two past events, **When** a
   user asks for upcoming events without naming a topic, **Then** the answer lists
   the three future events soonest-first and omits past events.
2. **Given** the same corpus, **When** a user asks a date-anchored question about a
   named topic, **Then** topical relevance still governs and temporal handling
   refines rather than replaces it.
3. **Given** an agent whose temporal structured-lookup setting is off, **When** a
   user asks for upcoming events, **Then** retrieval behaves as it does today
   (similarity only) for that agent.
4. **Given** an un-enriched corpus, **When** a user asks for upcoming events,
   **Then** the temporal behaviors do not degrade the answer relative to today's
   behavior.
5. **Given** the agent settings UI, **When** an operator opens the retrieval skill
   settings, **Then** the three temporal behaviors are individually switchable and
   default to on.

---

### User Story 4 - "Sort events by actuality" is deterministic (Priority: P3)

A user asks the agent to sort or list events by how current they are. The answer
presents events ordered by their extracted dates relative to today —
deterministically, not dependent on the language model happening to order them
correctly.

**Why this priority**: Polish on top of Stories 1 and 3; the ordering data already
exists by then.

**Independent Test**: With the deterministic-sort setting on, ask for events sorted
by actuality repeatedly; the presented order is date-ordered on every run.

**Acceptance Scenarios**:

1. **Given** an enriched corpus and deterministic sort enabled, **When** a user
   asks for events by actuality, **Then** events appear in date order relative to
   today on every repetition of the question.
2. **Given** deterministic sort disabled for an agent, **When** the same question
   is asked, **Then** behavior falls back to model-driven ordering.

---

### User Story 5 - Workbench eval coverage for event queries (Priority: P3)

An operator (and the team) can run workbench eval cases that exercise event-date
queries against an enriched fixture corpus — "when is X?", "what are the next
events?", "sort events by actuality" — so temporal retrieval quality is measurable
and regressions are visible.

**Why this priority**: Verification harness for the feature's promise; depends on
the other stories existing.

**Independent Test**: Run the new eval cases against a seeded enriched fixture
corpus; pass/fail status reflects whether answers respect dates and ordering.

**Acceptance Scenarios**:

1. **Given** the enriched fixture corpus, **When** the event-query eval cases run,
   **Then** each case reports pass/fail against its expected dated outcome.

---

### Edge Cases

- Date stated only once for multiple events, or several conflicting dates for one
  event: extraction must attach dates only where the text supports it; when
  ambiguous, prefer omission over fabrication.
- Relative dates without a resolvable anchor (no sync time, no publish date):
  record the fact unresolved rather than guessing.
- Events spanning ranges ("June 5–8"), open-ended ranges ("from June 5"), and
  recurring phrasing ("every Tuesday"): ranges are supported; recurring events may
  be represented by their next concrete occurrence or omitted, never fabricated.
- Non-Gregorian or localized date formats and non-English prose: extraction is
  LLM-based and multilingual; no language-specific keyword or regex rules anywhere.
- Documents that legitimately have no temporal facts: enrichment records the shape
  and adds nothing.
- Enrichment output that fails validation (wrong schema, impossible dates,
  character ranges out of bounds): treated as enrichment failure — document
  processes unenriched; failure is observable to operators.
- A previously enriched document reprocessed with enrichment off must not retain
  stale temporal metadata (chunks are rebuilt; document-level enrichment provenance
  is cleared).
- "Next events" asked when the corpus has only past events: the answer must say so
  rather than resurrect past events as upcoming.
- Today-boundary events (happening today) count as upcoming/ongoing.
- Documents larger than the enrichment context budget: the single call operates on
  a bounded representation of the document; behavior must degrade to partial or no
  extraction, never to multiple calls or failure of the processing run.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Backend in Node.js; frontend in React; PostgreSQL with `pgvector`.
- LLM integrations MUST use GPT-5.2 as the default provider.
- The enrichment prompt is a backend runtime LLM prompt asset and MUST live under
  `backend/prompts/` (proposed: `backend/prompts/ingestion/document-enrichment.md`).
- User-facing assistant copy (including "no upcoming events" phrasing) MUST come
  from the LLM, not hard-coded strings; the system is multilingual.
- Document-shape understanding and date interpretation MUST be LLM structured
  output (enums, ISO dates); NO English keyword lists or language-bound regexes to
  encode product meaning.
- Backend development MUST follow TDD: failing tests first.
- Frontend user-visible behavior MUST prefer Playwright coverage; unit tests only
  for non-visual logic.
- Secrets in `.env` only; update `.env.example` if new configuration appears.
- HTTP contract changes MUST go through the code-first OpenAPI registry
  (`backend/src/app/http/openapi/document.ts`) with regenerated
  `openapi.yaml`/`openapi.json`; contract tests aligned.
- Message-queue impact review REQUIRED: reprocess options ride on the processing
  job record, NOT on the AMQP message; the queue message contract is expected to
  remain unchanged and the review must confirm this, including retry semantics and
  queue docs/tests.
- Documentation parity: ingestion settings docs, sources docs, API reference, MCP
  tool docs (`reprocess_document`), SDK sync, and docs-portal equivalents updated
  in the same change, following `docs/document-writer-prompt.md`.
- Observability: new worker stage and new retrieval path need spans/logs/audit
  per repo policy; no document content, prompts, or completions in logs.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Shape classification and fact extraction contract = ingestion
  domain (`backend/src/modules/documents/domain/enrichment/`); the enrichment
  stage orchestration = documents services layer; temporal metadata field names
  (`dateFrom`/`dateTo`, ISO 8601) are the only contract shared with retrieval;
  retrieval consumes chunk metadata and never imports ingestion internals.
- **Encapsulation Rule**: `documentProcessingService.ts` remains an orchestrator —
  it gains one stage call, not extraction logic. `searchTextRenderer.ts` and the
  metadata-rule engine are reused as-is (they already understand
  `dateFrom`/`dateTo`). The enrichment LLM prompt knows nothing about chunking or
  storage; strategies know nothing about queues, settings resolution, or HTTP.
- **New Seams Required**:
  - `DocumentShape` enum + single-call enrichment output contract (discriminated
    union of shape-specific facts).
  - `DocumentEnrichmentStrategy` port (apply extraction results to
    document/chunk metadata patches; strategies make no LLM calls) + registry
    wired in `backend/src/app/composition/`.
  - Enrichment-enablement resolution helper (job override ?? source override ??
    workspace default) as a pure, tested function.
  - Reprocess job options seam: nullable options on the processing job record.
  - Per-agent temporal settings group in the retrieval skill settings schema.
  - Generated/indexed date columns on chunks for range queries (JSONB containment
    cannot express date ranges).
- **Anti-Goals**:
  - Do not add per-shape extraction branches inside the processing service or the
    chunker; shapes live behind the registry.
  - Do not put temporal ranking logic into route handlers or the chat service;
    it belongs in the retrieval pipeline stages behind skill settings.
  - Do not change the AMQP message schema for reprocess options.
  - Do not introduce a second LLM call per document (no classify-then-extract
    round trips).
  - Do not encode date vocabulary ("next", "upcoming", month names) in code.
  - Do not couple eval fixtures to live provider output; fixture corpus and
    expected outcomes are deterministic.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST classify each enriched document into exactly one
  known shape: `event`, `article`, `profile`, `reference`, or `generic`; unknown
  or low-confidence classifications resolve to `generic`.
- **FR-002**: The system MUST perform classification and shape-specific fact
  extraction in a single LLM call per document, returning structured output
  (shape, confidence, shape-dependent facts with normalized ISO-8601 dates and
  source character ranges).
- **FR-003**: For `event` documents, the system MUST attach each extracted date
  range to every stored chunk whose text overlaps the fact's source range, so a
  date stated far from the event introduction still lands on the event's chunks.
- **FR-004**: For `article` documents, the system MUST attach the publication (and
  where present, update) date at document level so all chunks inherit it.
- **FR-005**: For `profile`, `reference`, and `generic` shapes, the system MUST
  record the shape and attach no temporal facts.
- **FR-006**: The system MUST resolve relative date expressions against the
  document's source sync time or creation time and record which anchor was used;
  unresolvable relative dates are stored as unresolved, never guessed.
- **FR-007**: Temporal metadata attached to chunks MUST use the existing
  `dateFrom`/`dateTo` metadata contract so current search-text rendering,
  reranking guidance, and date-comparison rules activate without modification.
- **FR-008**: Enrichment failure or invalid extraction output MUST NOT fail
  document processing; the document completes unenriched and the failure is
  observable (log + audit).
- **FR-009**: Enrichment MUST be controlled by a workspace-level ingestion setting
  that defaults to disabled, exposed in the ingestion settings API and UI.
- **FR-010**: Each document source MUST support an enrichment override (on/off/
  inherit) stored in its configuration and editable via the sources API and UI.
- **FR-011**: Single-document and workspace reprocess requests MUST accept an
  optional enrichment override; effective enablement resolves as: reprocess
  override, else source override, else workspace default.
- **FR-012**: Reprocess overrides MUST be carried on the processing job record;
  the queue message contract MUST remain unchanged.
- **FR-013**: The system MUST provide a per-source reprocess action that requeues
  that source's eligible documents and reports queued/skipped counts, with an
  optional enrichment override, exposed via API and the sources UI.
- **FR-014**: Reprocessing with enrichment disabled MUST leave no stale temporal
  enrichment on the rebuilt document or chunks.
- **FR-015**: Document enrichment provenance (shape, model, enrichment time,
  anchor date) MUST be stored on the document and visible to operators.
- **FR-016**: When a turn is classified as a date-shaped event lookup without a
  topical anchor, retrieval MUST include a metadata-first candidate set: chunks
  with event dates from today onward, ordered soonest-first, blended with (not
  replacing) similarity results when a topical anchor exists.
- **FR-017**: A built-in upcoming-events boost (event date on/after today) MUST
  activate automatically on date-shaped event lookups without operator-authored
  rules.
- **FR-018**: When enabled, answer composition for date-shaped event lookups MUST
  present events in deterministic date order relative to today.
- **FR-019**: The three temporal retrieval behaviors (structured lookup, upcoming
  boost, deterministic sort) MUST each be independently selectable per agent in
  the retrieval skill settings, following the existing agent-override-over-system-
  default pattern, with system defaults on; all three MUST be inert on corpora
  without temporal metadata.
- **FR-020**: Chunk-level event dates MUST be queryable and orderable by range at
  the database level (indexed), not by scanning JSON payloads.
- **FR-021**: Workbench eval cases MUST cover: a date question about a named event
  whose date is in a different paragraph, an anchorless "next events" listing, and
  a sort-by-actuality request — each against a deterministic enriched fixture
  corpus with past and future events.
- **FR-022**: The enrichment stage MUST emit observability signals (span, log
  fields: shape, confidence bucket, fact count, applied-chunk count, latency, skip
  reason) without document content; the structured retrieval path MUST be visible
  in the turn's retrieval trace.

### UI Tasks

- Ingestion settings: an "AI document enrichment" toggle with a cost note
  (one model call per document), default off.
- Sources list/detail: per-source enrichment override (inherit / on / off) and a
  "Reprocess source" action showing queued document count; optional enrichment
  override on the reprocess confirmation.
- Document detail: show detected shape and enrichment provenance; surface
  enrichment failure state.
- Agent retrieval skill settings: three temporal behavior switches (structured
  lookup, upcoming boost, deterministic sort) alongside existing retrieval
  toggles.

### Key Entities

- **Document shape**: one of `event`, `article`, `profile`, `reference`,
  `generic`; stored as enrichment provenance on the document.
- **Temporal fact**: a normalized date or date range with a label and a source
  character range within the document; `event` facts map to chunk metadata,
  `article` facts to document metadata.
- **Enrichment provenance**: shape, model, enrichment timestamp, anchor date,
  failure state; document-level.
- **Enrichment enablement**: workspace default (ingestion settings), per-source
  override (source config), per-run override (processing job options).
- **Temporal retrieval settings**: per-agent group `{ structuredLookup,
  boostUpcoming, deterministicSort }` with system defaults on.
- **Enriched fixture corpus**: deterministic eval corpus containing dated and
  undated documents of multiple shapes, with past and future events.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On the eval fixture corpus, a date question about an event whose
  date appears in a different paragraph than the event name is answered with the
  correct date in 100% of eval runs (was: unreliable/failing today).
- **SC-002**: "What are the next events?" against the fixture corpus lists all
  future events and only future events, soonest-first, in 100% of eval runs with
  temporal settings on.
- **SC-003**: "Sort events by actuality" yields identical, date-correct ordering
  across 5 consecutive runs with deterministic sort on.
- **SC-004**: Enrichment uses exactly one model call per processed document, and
  documents of shapes without temporal meaning add no extraction cost beyond that
  single call.
- **SC-005**: With enrichment disabled (default), document processing behavior and
  outputs are byte-equivalent to today's pipeline for the same inputs.
- **SC-006**: An operator can enable enrichment for one source and reprocess just
  that source in two UI actions; documents of other sources show no metadata
  changes.
- **SC-007**: Induced enrichment failures on the fixture corpus produce zero
  failed documents (all complete unenriched) and each failure is visible to
  operators via logs/audit.
- **SC-008**: Turning any of the three per-agent temporal settings off restores
  the corresponding pre-feature behavior for that agent without affecting other
  agents.

## Assumptions

- Shapes beyond the five listed are out of scope; the registry is the extension
  point for future shapes (e.g. product, FAQ).
- Recurring-event expansion (RRULE-style) is out of scope for v1; a recurring
  event may surface as its next concrete occurrence only when the text states it.
- Backfill: enabling enrichment does not retroactively enrich existing documents;
  operators reprocess (per source or workspace) to enrich existing content.
- The bounded document representation for the single enrichment call is an
  implementation-time decision; partial extraction on very large documents is
  acceptable and observable.
- Existing rerank temporal guidance and `today()` metadata-rule support are
  reused, not redesigned.
