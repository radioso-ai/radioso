# Feature Specification: Hybrid Retrieval

**Feature Branch**: `009-hybrid-retrieval`  
**Created**: 2026-03-14  
**Status**: Draft  
**Input**: User description: "Improve retrieval with schema-light hybrid retrieval that combines semantic search, lexical retrieval, enriched chunk search text, deterministic structured attributes for dates/prices/locations/ranges, constraint-aware filtering or boosting, rerank enrichment, diagnostics, and account-scoped controls over supported attribute families."

## Clarifications

### Session 2026-03-14

- Candidate merge strategy uses chunk identity as the deduplication boundary, retains which retrieval sources produced each candidate, and combines source signals before reranking instead of emitting duplicate prompt contexts.
- Search-text rendering is a normalized retrieval representation that prioritizes title, available section context, concise attribute text, and chunk body in a stable order rather than embedding raw chunk text alone.
- Hard filtering is allowed only for high-confidence supported constraints and normalized supported attribute values; lower-confidence interpretations must degrade to boost-only behavior.
- The first release defines explicit candidate-generation defaults to keep tuning bounded: semantic retrieval `topK` 40, lexical retrieval `topK` 20, merged candidate cap 50, with final rerank and prompt selection continuing through retrieval settings.
- Supported attribute values must be normalized before retrieval use so equivalent dates, prices, currencies, and locations compare consistently across ingestion and query parsing.
- The operator-facing UI includes retrieval-information visibility so administrators can inspect the retrieval interpretation and fallback path for executed queries without reading raw backend logs.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Retrieve Exact And Mixed-Signal Matches (Priority: P1)

A chat user asking about a named item, exact phrase, date, price, or location expects the system to retrieve the right source even when semantic similarity alone is not enough.

**Why this priority**: The current vector-first retrieval path is weakest on exact-match and mixed semantic-plus-literal queries, so hybrid candidate generation is the highest-value user-facing improvement.

**Independent Test**: Can be fully tested by indexing a representative document set, asking exact-match and mixed-signal questions, and verifying that relevant cited sources appear in the top retrieved contexts more reliably than under the current vector-only baseline.

**Acceptance Scenarios**:

1. **Given** indexed content containing exact names, dates, prices, or locations, **When** a user asks a query that includes those exact terms, **Then** the retrieval system returns relevant supporting contexts without depending only on semantic similarity.
2. **Given** a query that mixes natural-language intent with precise literal cues, **When** retrieval runs, **Then** the candidate set includes relevant results from both semantic and lexical signals before reranking.

---

### User Story 2 - Respect Structured Constraints Safely (Priority: P2)

A chat user asking for results within a date window, below a price, or in a location expects retrieval to prefer or require content that satisfies those constraints without forcing the system into rigid document-type modeling.

**Why this priority**: Constraint-aware retrieval is the main precision gain from adding schema-light attributes, but it should be introduced narrowly and safely to avoid harming recall.

**Independent Test**: Can be fully tested by indexing documents with supported attributes, running constraint-heavy queries, and verifying that returned contexts satisfy high-confidence constraints or degrade predictably through the fallback flow when strict filtering would underflow results.

**Acceptance Scenarios**:

1. **Given** indexed content contains supported dates, date ranges, money values, and locations, **When** a user asks a constraint-heavy query, **Then** retrieval applies those supported attributes as filters or boosts according to account settings and extraction confidence.
2. **Given** a strict constraint would leave too few results, **When** retrieval executes, **Then** the system relaxes the constraint according to the defined fallback behavior instead of returning an empty candidate set by default.

---

### User Story 3 - Control Supported Attribute Families Per Account (Priority: P3)

An account operator managing retrieval quality wants to enable or disable supported attribute families and control whether they influence ranking as boosts only or can participate in hard filtering.

**Why this priority**: Operators need bounded control over retrieval behavior, but the feature should stop short of turning Settings into a custom schema designer.

**Independent Test**: Can be fully tested by changing retrieval settings for one account, verifying the saved controls round-trip through the existing settings flow, and confirming another account's retrieval behavior remains unchanged.

**Acceptance Scenarios**:

1. **Given** retrieval settings for an account, **When** an operator updates supported attribute-family controls, **Then** the new values persist through the existing retrieval settings flow and apply only to future retrievals for that account.
2. **Given** one account disables or limits an attribute family, **When** another account performs retrieval without that change, **Then** the second account's retrieval behavior remains unaffected.

---

### User Story 4 - Diagnose Retrieval Decisions (Priority: P3)

An operator investigating retrieval quality wants diagnostics that explain how a query was interpreted, which candidates were generated, which constraints were applied, and how fallback behavior changed the final result set.

**Why this priority**: Hybrid retrieval adds more moving parts, so observability is required to tune and trust the system safely.

**Independent Test**: Can be fully tested by executing representative queries and verifying that retrieval telemetry records query intent, candidate-source counts, applied filters or boosts, fallback decisions, and final context counts.

**Acceptance Scenarios**:

1. **Given** a successful hybrid retrieval request, **When** diagnostics are recorded, **Then** they capture parsed query intent, candidate counts by source, applied constraints, and final selected contexts.
2. **Given** retrieval falls back from strict constraints to softer behavior, **When** diagnostics are recorded, **Then** the fallback decision and resulting candidate counts are visible for review.

---

### User Story 5 - Review Retrieval Information In The Admin UI (Priority: P3)

An operator evaluating retrieval quality wants the admin experience to show retrieval interpretation and ranking diagnostics for executed queries so they can understand why a result set was produced.

**Why this priority**: Diagnostics are more actionable when they are visible in the product rather than only in backend telemetry, but this remains lower priority than improving retrieval quality itself.

**Independent Test**: Can be fully tested by running representative queries through the existing admin experience and verifying that retrieval information is displayed in a bounded, readable format that matches recorded diagnostics.

**Acceptance Scenarios**:

1. **Given** a completed retrieval-backed chat request, **When** an operator opens the retrieval-information view, **Then** the UI shows parsed query intent, candidate counts by source, applied supported constraints, and whether fallback behavior was used.
2. **Given** retrieval uses both semantic and lexical candidates, **When** the operator views retrieval information, **Then** the UI shows that both sources participated without exposing raw implementation logs.

### Edge Cases

- What happens when deterministic extraction finds ambiguous or conflicting date, money, or location values within the same chunk?
- How does the system behave when lexical retrieval returns strong exact matches that semantic retrieval misses entirely?
- What happens when structured constraints produce zero candidates after filtering?
- How does the system handle chunks that contain no supported attributes at all?
- What happens when an operator disables an attribute family that was previously used for filtering or boosting?
- How does the system handle malformed or partially normalized literal values such as incomplete dates, unknown currency markers, or vague locations?
- What happens when one supported attribute family has low extraction confidence but another has high confidence in the same query?
- How does the system behave when lexical retrieval, attribute extraction, or reranking is temporarily unavailable?

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Chat routes remain transport-only, chat service remains orchestration-only, retrieval pipeline services own candidate generation and ranking decisions, ingestion services own search-text rendering and deterministic attribute extraction, settings services own account-scoped retrieval configuration, and persistence repositories own chunk search data and retrieval-setting storage.
- **Encapsulation Rule**: Route handlers and frontend components must not implement retrieval scoring, query parsing, or attribute extraction logic. The prompt builder must remain focused on context formatting rather than retrieval decisions. Document ingestion must not absorb query-time ranking logic. Persistence modules must not contain request-specific scoring heuristics.
- **New Seams Required**: The retrieval domain must expose separate candidate-generation ports for semantic and lexical retrieval, a focused query-understanding seam for supported constraints, an attribute-aware candidate merge or scoring seam, a deterministic structured-attribute extraction seam during ingestion, and a retrieval-settings seam for account-scoped attribute-family controls.
- **Anti-Goals**: Do not add retrieval ranking logic to chat route handlers. Do not replace vector retrieval with lexical retrieval. Do not introduce rigid document types such as Event or Product in this feature. Do not build arbitrary user-authored extraction schemas or free-form custom attribute definitions. Do not require a new external search engine for the first implementation if PostgreSQL lexical retrieval is sufficient. Do not break existing chat answer or citation contracts while hybrid retrieval is introduced.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST generate retrieval candidates from both semantic retrieval and lexical retrieval for supported queries rather than relying only on vector similarity.
- **FR-002**: System MUST store a normalized search-text representation for each indexed chunk that combines the chunk body with retrieval-relevant context such as title and other supported enrichment text.
- **FR-003**: System MUST deduplicate and merge semantic and lexical candidates before reranking and final context selection.
- **FR-003a**: System MUST use chunk identity as the candidate deduplication boundary and retain which retrieval sources contributed to each merged candidate.
- **FR-003b**: System MUST apply a documented merge strategy that preserves source participation, supports score combination or source-aware boosting before reranking, and prevents duplicate contexts from being sent to prompt assembly.
- **FR-004**: System MUST keep the current vector retrieval path available as part of hybrid retrieval rather than replacing it.
- **FR-004a**: System MUST define bounded default candidate counts for the first release, using semantic retrieval `topK` 40, lexical retrieval `topK` 20, and merged candidate cap 50 unless account-scoped retrieval settings override the downstream selection stages.
- **FR-005**: System MUST deterministically extract a bounded first set of structured attribute families during ingestion consisting of date points, date ranges, money values, and locations.
- **FR-006**: System MUST persist extracted supported attributes in a form that retrieval can use for filtering, boosting, diagnostics, and context assembly.
- **FR-006a**: System MUST normalize supported extracted attributes before persistence so equivalent literal values compare consistently across retrieval operations.
- **FR-007**: System MUST parse supported query constraints for the same bounded attribute families when those constraints are present in the user query.
- **FR-007a**: System MUST normalize supported query constraints into the same comparison form used by stored supported attributes before applying filtering or boosting logic.
- **FR-008**: System MUST support applying high-confidence supported constraints as hard filters when the account setting for that attribute family allows hard filtering.
- **FR-008a**: System MUST define and document confidence thresholds for supported constraints so hard filtering is reserved for high-confidence interpretations and lower-confidence cases degrade to boost-only behavior.
- **FR-009**: System MUST support applying supported constraints as soft boosts when the account setting for that attribute family is boost-only or when strict filtering confidence is insufficient.
- **FR-010**: System MUST relax supported hard filters to softer behavior according to a defined fallback sequence when strict filtering would reduce the candidate set below the configured minimum useful threshold.
- **FR-011**: System MUST rerank merged candidates using enriched candidate text that includes retrieval-relevant context instead of reranking on raw chunk text alone.
- **FR-011a**: System MUST render search text in a stable normalized order that includes chunk title, available section or hierarchy context, concise supported attribute text when present, and chunk body text.
- **FR-011b**: System MUST normalize whitespace, duplicated literals, and equivalent literal formatting in search text so lexical retrieval and embeddings operate on a consistent representation.
- **FR-012**: System MUST keep reranking behind a provider abstraction so rerank-model choice remains swappable without changing retrieval orchestration behavior.
- **FR-013**: System MUST include relevant supported attributes in the final retrieval context presented to answer generation when those attributes are available.
- **FR-014**: System MUST preserve existing chat response and citation behavior when hybrid retrieval is enabled, including safe fallback behavior when no useful supporting contexts remain.
- **FR-015**: System MUST expose account-scoped retrieval settings that let operators enable or disable each supported attribute family independently.
- **FR-016**: System MUST expose account-scoped retrieval settings that let operators choose, for each enabled supported attribute family, whether it participates as boost-only or may be used for hard filtering where supported.
- **FR-017**: System MUST default new and existing accounts to a safe retrieval behavior that does not require operator configuration before hybrid retrieval can function.
- **FR-018**: System MUST NOT support arbitrary user-defined attribute schemas, custom extraction rules, or document-type definitions in this feature.
- **FR-019**: System MUST log retrieval diagnostics that capture parsed query intent, candidate counts by source, applied filters or boosts, fallback decisions, rerank status, and final context counts.
- **FR-019a**: System MUST make bounded retrieval information available in the operator-facing UI for executed queries, including parsed query intent, candidate counts by source, applied supported constraints, and fallback usage.
- **FR-020**: System MUST keep hybrid retrieval behavior testable through isolated unit coverage plus end-to-end retrieval benchmarks covering exact-match, follow-up, noisy-corpus, fallback, and constraint-heavy scenarios.
- **FR-021**: System MUST degrade predictably when lexical retrieval, structured extraction, or reranking is unavailable by continuing with the remaining available retrieval signals and logging the fallback.
- **FR-022**: System MUST keep supported attribute-family controls account-scoped so one account's retrieval settings do not affect another account's retrieval behavior.
- **FR-023**: System MUST ensure changes to supported attribute-family settings affect future retrieval behavior without requiring users to redesign or redefine the indexed schema.

### UI Tasks

- The Settings screen must display supported attribute-family controls as part of retrieval configuration.
- The Settings screen must let operators enable or disable date points, date ranges, money values, and locations independently.
- The Settings screen must let operators choose whether each enabled supported attribute family behaves as boost-only or is eligible for hard filtering where supported.
- The Settings screen must explain, in plain language, that supported attribute families are system-defined and not custom user-authored schemas.
- The Settings screen must preserve the existing retrieval-settings save flow rather than introducing a separate schema-design workflow.
- The admin experience must provide a retrieval-information view for executed queries that shows parsed intent, candidate counts by source, applied supported constraints, rerank status, and fallback usage in readable product language.

### Key Entities *(include if feature involves data)*

- **Chunk Search Text**: The normalized retrieval representation for one chunk that combines body content with retrieval-relevant context used for lexical search, embeddings, reranking, or both.
- **Structured Attribute Family**: A supported typed group of extracted values, initially limited to date points, date ranges, money values, or locations.
- **Extracted Attribute Value**: A normalized value attached to a chunk that can support filtering, boosting, diagnostics, and context assembly.
- **Parsed Query Constraint**: A query-time interpretation of a supported literal constraint such as date overlap, date boundary, money threshold, or location match.
- **Hybrid Candidate Set**: The merged and deduplicated set of chunk candidates produced from semantic retrieval, lexical retrieval, and supported attribute-aware adjustments before reranking.
- **Attribute-Family Retrieval Control**: An account-scoped retrieval setting that determines whether a supported attribute family is enabled and whether it can influence retrieval as boosts only or as eligible hard filters.
- **Retrieval Information View**: The operator-facing product surface that presents bounded retrieval diagnostics for executed queries without requiring direct log inspection.

## Assumptions

- The initial lexical retrieval implementation uses PostgreSQL-native search capabilities rather than introducing a new external search engine.
- The first release supports only system-defined attribute families and does not allow operators to define new attribute names or custom parsing rules.
- Supported attribute extraction in the first release is deterministic and bounded to date points, date ranges, money values, and locations.
- Supported attribute normalization uses one comparison form per family so equivalent values can be matched consistently between ingestion and query parsing.
- Confidence thresholds for hard filtering are implementation-defined but must be explicit, testable, and conservative enough to prefer recall-safe degradation over false exclusions.
- The admin retrieval-information view is a bounded diagnostic surface for operators, not a general-purpose analytics product.
- Constraint parsing and filtering should prefer recall-safe behavior when confidence is limited, including relaxing filters to boosts when necessary.
- Existing document and chat APIs remain unchanged except where the retrieval settings payload must expand to support account-scoped hybrid-retrieval controls.
- Existing indexed documents may require reprocessing or update flows to benefit fully from richer search text and stored supported attributes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In benchmark coverage for exact-match and mixed-signal queries, top-5 retrieval recall improves by at least 20% over the current vector-only baseline on the agreed fixture set.
- **SC-002**: In benchmark coverage for constraint-heavy queries using supported attribute families, at least 85% of top-5 retrieved contexts satisfy the intended date, price, or location constraints on the agreed fixture set.
- **SC-003**: In fallback benchmark coverage where strict filtering would underflow results, 100% of such queries degrade through the defined fallback sequence and produce diagnostics rather than failing silently.
- **SC-004**: In retrieval-settings tests, 100% of supported attribute-family controls round-trip correctly per account and 100% of invalid control values are rejected safely.
- **SC-004a**: In normalization tests for supported attribute families, 100% of equivalent fixture values compare consistently after ingestion-time and query-time normalization.
- **SC-005**: In regression tests for existing direct-answer, follow-up, noisy-corpus, and no-context scenarios, hybrid retrieval preserves the current safe-answer and citation behavior with no contract regressions.
- **SC-006**: In diagnostics coverage, 100% of retrieval executions record candidate counts by source, rerank status, applied supported constraints, and whether fallback behavior was used.
- **SC-007**: In operator-facing retrieval-information tests, 100% of displayed retrieval views match the recorded parsed intent, candidate-source counts, applied supported constraints, and fallback status for the corresponding executed query.
