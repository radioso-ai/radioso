# Feature Specification: Selectable Chunking Strategies

**Feature Branch**: `codex/007-chunking-strategy-selection`  
**Created**: 2026-03-14  
**Status**: Draft  
**Input**: User description: "Let's not replace fixed-window chunking but allow an alternative that is behind the same interface that chunking has to adhere to. The Settings UI should let us choose. Use deterministic rules based on document structure: headings, paragraphs, bullets, numbered steps, tables, code fences, FAQ pairs. Let's not do any english-based regex. A very practical middle ground is: split by paragraph first, embed each paragraph and compare to adjacent, merge adjacent paragraphs while similarity remains high, start a new chunk when the topic changes, still enforce min/max token sizes."

## Clarifications

### Session 2026-03-14

- Q: Should this feature add only the chunking strategy selector, or also expose advanced structured-chunking tuning controls in Settings? → A: Add only the chunking strategy selector; structured-chunking thresholds and sizing rules remain internal defaults in this feature.
- Q: If adjacent semantic-similarity comparison is unavailable during structured chunking, what fallback should the system use? → A: Continue with deterministic structure-only chunking and size bounds, without semantic merging.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Choose Chunking Strategy In Settings (Priority: P1)

An operator managing one account's retrieval behavior can choose which chunking strategy new document ingests should use without replacing or breaking the existing fixed-window behavior.

**Why this priority**: The feature only has value if operators can opt into the new chunking behavior safely and explicitly instead of having the system silently change chunking for every account.

**Independent Test**: Can be fully tested by loading retrieval settings for an account, selecting a chunking strategy in Settings, saving, reloading the page, and verifying that the same strategy is returned and applied on the next document ingest or update.

**Acceptance Scenarios**:

1. **Given** an account using the default retrieval settings, **When** the operator opens Settings, **Then** the chunking strategy control shows the current strategy and leaves fixed-window available as a selectable option.
2. **Given** an operator changes the chunking strategy and saves, **When** retrieval settings are fetched again for that account, **Then** the saved strategy is returned through the existing retrieval settings flow without requiring a separate settings surface.

---

### User Story 2 - Structure-Aware Chunking For New Ingests (Priority: P2)

An operator selecting the structured strategy expects newly ingested or updated documents to be chunked according to document structure and topic continuity instead of only fixed character windows.

**Why this priority**: The new strategy exists to create more coherent retrieval units for structured content while still keeping chunk sizes bounded and deterministic.

**Independent Test**: Can be fully tested by ingesting representative documents containing headings, paragraphs, lists, tables, code fences, and FAQ-style sections under the structured strategy and verifying that resulting chunks preserve structural boundaries unless size limits force a split.

**Acceptance Scenarios**:

1. **Given** a document with headings followed by related paragraphs, **When** the structured chunking strategy is selected and the document is ingested, **Then** the produced chunks preserve source order and keep related neighboring blocks together until a topic break or size limit requires a new chunk.
2. **Given** a document containing bullets, numbered steps, tables, code fences, or FAQ pairs, **When** the structured strategy is used, **Then** the chunker recognizes those document structures as deterministic boundaries or merge units without relying on English-specific regular expressions.
3. **Given** the structured strategy is selected but adjacent semantic-similarity comparison is unavailable during ingestion, **When** the document is chunked, **Then** the system continues with deterministic structure-only chunk assembly and size bounds instead of failing the ingest or switching to fixed-window chunking.

---

### User Story 3 - Predictable Scope Of Strategy Changes (Priority: P3)

An operator changing chunking strategy needs the impact to be predictable so existing indexed content does not silently change until documents are deliberately reprocessed.

**Why this priority**: Strategy changes affect retrieval quality and operational expectations, so the system must make clear when the new choice takes effect and avoid hidden reindexing behavior.

**Independent Test**: Can be fully tested by ingesting a document under one strategy, changing the account's setting, confirming the existing stored chunks remain unchanged, and then updating or re-ingesting the document to confirm the newly selected strategy is applied.

**Acceptance Scenarios**:

1. **Given** an account has already ingested documents, **When** the operator changes the chunking strategy, **Then** the existing stored chunks remain unchanged until a document is newly ingested or updated.
2. **Given** a newly selected chunking strategy cannot derive ideal structure boundaries for part of a document, **When** ingestion continues, **Then** the system still produces bounded, ordered chunks rather than failing or falling back to unbounded content.

### Edge Cases

- What happens when a document is shorter than the minimum chunk target and contains only one paragraph or one structural block?
- How does the system handle a single table, code fence, or paragraph that exceeds the maximum chunk size on its own?
- What happens when adjacent paragraphs have weak structural cues but high semantic similarity?
- How does the system behave when a heading is followed by only one short paragraph or one short FAQ answer?
- What happens when the account selects a chunking strategy value that is no longer supported by the running application?
- How does the system handle documents that mix plain paragraphs with lists, tables, and code fences in rapid succession?
- What happens when semantic-similarity comparison is temporarily unavailable while the structure-aware strategy is selected?

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

- **Boundary Rule**: Settings routes remain transport-only, settings services own account-scoped retrieval configuration, document ingestion remains the orchestration layer that applies the selected chunking strategy during ingest and update flows, chunking domain modules own chunk-boundary rules, and persistence repositories remain the only owners of settings and chunk storage.
- **Encapsulation Rule**: The settings UI must remain a selector and explainer of chunking behavior, not an owner of chunking rules. Document ingestion must remain orchestration-only and must not absorb structure parsing rules inline. Retrieval settings persistence must not embed chunking logic. Chunking strategy modules must not perform direct database writes or route-level request handling.
- **New Seams Required**: The retrieval domain must expose a chunking strategy interface, a strategy resolver or registry that selects the active implementation from account settings, and a focused structure-aware chunking path that separates deterministic document block parsing from adjacent-block similarity merging and size-bound enforcement.
- **Anti-Goals**: Do not replace fixed-window chunking. Do not add a boolean flag that branches through one monolithic chunking function. Do not put strategy selection logic in route handlers or React components. Do not use English-specific regular expressions to infer headings, FAQs, or topic shifts. Do not automatically re-chunk every existing document when the setting changes. Do not add advanced structured-chunking tuning controls to the Settings UI in this feature.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST preserve fixed-window chunking as a supported strategy rather than replacing it.
- **FR-002**: System MUST expose chunking behavior through a stable shared interface so multiple chunking strategies can be selected without changing the document ingestion contract.
- **FR-003**: System MUST let operators choose the chunking strategy from the existing Settings experience and persist that choice through the existing retrieval settings flow.
- **FR-004**: System MUST treat chunking strategy selection as account-scoped retrieval configuration so one account's choice does not affect another account's ingests.
- **FR-005**: System MUST default accounts without an explicit chunking-strategy selection to fixed-window chunking.
- **FR-006**: System MUST apply the currently selected chunking strategy whenever a document is newly ingested or an existing document is updated.
- **FR-007**: Changing the chunking strategy MUST NOT silently rewrite or replace chunks that were already stored for existing documents.
- **FR-008**: The structure-aware strategy MUST detect and use deterministic document structure boundaries for headings, paragraphs, bullets, numbered steps, tables, code fences, and FAQ pairs.
- **FR-009**: The structure-aware strategy MUST begin by splitting content into ordered paragraph or block units before deciding how those units should be merged into retrieval chunks.
- **FR-010**: The structure-aware strategy MUST compare adjacent block units semantically and merge neighboring blocks while they remain on the same topic.
- **FR-011**: The structure-aware strategy MUST start a new chunk when adjacent block units indicate a topic change, even when the maximum chunk size has not yet been reached.
- **FR-012**: The structure-aware strategy MUST enforce minimum and maximum chunk-size bounds so chunks remain usable for embedding and retrieval.
- **FR-013**: If one structural unit exceeds the maximum chunk size by itself, system MUST split that unit in a bounded way without dropping content, duplicating content excessively, or producing empty chunks.
- **FR-014**: The structure-aware strategy MUST preserve source order across all produced chunks.
- **FR-015**: The structure-aware strategy MUST NOT rely on English-specific regular expressions or English-only keyword heuristics to identify supported structures or topic boundaries.
- **FR-016**: System MUST continue to persist chunk indexes and offsets for produced chunks so downstream retrieval and citation behavior remains compatible with existing chunk storage.
- **FR-017**: System MUST return and accept the selected chunking strategy through the existing retrieval settings endpoint without requiring a separate chunking-specific API.
- **FR-018**: System MUST inform operators in Settings when a chunking-strategy change takes effect so they understand that existing documents keep their current chunks until re-ingested or updated.
- **FR-019**: System MUST validate chunking-strategy selections and reject unsupported values with the same safe error behavior used for other invalid retrieval settings.
- **FR-020**: System MUST keep structured-chunking similarity thresholds and chunk-size heuristics as internal behavior for this feature rather than exposing additional operator-tunable controls beyond the strategy selector.
- **FR-021**: If adjacent semantic-similarity comparison is unavailable during the structure-aware strategy, system MUST continue with deterministic structure-only chunking and enforce the same size-bound guarantees rather than failing the ingest or silently switching strategies.
- **FR-022**: System MUST keep chunking strategy selection and structure-aware chunking behavior testable through isolated unit coverage plus end-to-end ingest and settings tests.

### UI Tasks

- The Settings screen must display the current chunking strategy as part of retrieval configuration.
- The Settings screen must let operators select between fixed-window chunking and the new structure-aware chunking option.
- The Settings screen must explain, in plain language, how each chunking option behaves and when a changed selection takes effect.
- The Settings screen must preserve the existing save flow so chunking strategy changes are saved together with the rest of retrieval settings.
- The Settings screen must not introduce advanced structured-chunking tuning controls in this feature.

### Key Entities *(include if feature involves data)*

- **Chunking Strategy Selection**: The account-scoped retrieval setting that identifies which chunking implementation should be used for future document ingests and updates.
- **Chunking Strategy Interface**: The shared contract that every chunking implementation must satisfy so ingestion can invoke any supported strategy through the same boundary.
- **Structural Block Unit**: A deterministic source segment such as a paragraph, heading section, bullet list, numbered step group, table, code fence, or FAQ pair that acts as the input unit for structure-aware chunk assembly.
- **Chunk Boundary Decision**: The result of evaluating whether neighboring structural block units should be merged into one retrieval chunk or split at a topic boundary.
- **Stored Chunk Set**: The ordered chunk records saved for one document, including content, position metadata, and embeddings, produced under the strategy active at ingest time.

## Assumptions

- The selected chunking strategy is stored as part of the existing account-scoped retrieval settings model.
- Fixed-window chunking remains the default strategy for compatibility and rollback safety.
- A chunking-strategy change applies to documents on their next ingest or update rather than triggering automatic background reprocessing of all existing content.
- The structure-aware strategy may use semantic similarity between adjacent structural units, but its structure detection remains deterministic and language-agnostic.
- If semantic-similarity comparison is unavailable at ingest time, the structure-aware strategy falls back within the same strategy to deterministic structure-only merging behavior.
- Similarity thresholds, merge heuristics, and chunk-size bounds for the structure-aware strategy are implementation defaults in this feature and not operator-configurable.
- Existing chat and document endpoint contracts remain unchanged apart from the retrieval settings payload gaining chunking-strategy support.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In account settings tests, 100% of valid chunking-strategy selections round-trip through the existing retrieval settings flow and 100% of unsupported selections are rejected with a validation error.
- **SC-002**: In a representative structured-document fixture set, at least 90% of headings, bullet lists, numbered step groups, tables, code fences, and FAQ pairs remain intact as structural units unless a size limit requires a bounded split.
- **SC-003**: In a representative topic-shift fixture set, the structure-aware strategy reduces cross-topic chunk joins by at least 50% compared with the current fixed-window baseline.
- **SC-004**: In regression tests covering strategy changes after ingestion, 100% of existing stored chunk sets remain unchanged until the affected documents are updated or re-ingested.
- **SC-005**: In ingest tests for both strategies, 100% of produced chunk sets preserve source order, contain no empty chunks, and respect the defined chunk-size bounds.
- **SC-006**: In structured-strategy fallback tests where semantic-similarity comparison is unavailable, 100% of ingests still complete with deterministic structure-only chunks that preserve order and size bounds.
