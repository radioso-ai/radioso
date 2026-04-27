# Feature Specification: Document-Diverse Retrieval Cascade

**Feature Branch**: `borohhov/retrieval-cascade-pack`
**Created**: 2026-04-27  
**Status**: Approved  
**Input**: User description: "Add document-aware final context selection so one document cannot dominate prompt context after chunk retrieval, and fix cases where wide retrieval collapses into a tiny, low-quality final prompt context."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Diversify final answer evidence (Priority: P1)

As a workspace operator evaluating assistant answers, I want Radioso to use evidence from distinct relevant documents when available, so the assistant does not overfit to several nearby chunks from one document while ignoring other useful sources.

**Why this priority**: Chunk retrieval currently can return many sibling chunks from the same document because document titles and subjects are embedded into every chunk. Final prompt context needs diversity before answer generation can surface better links and options.

**Independent Test**: Can be tested by passing a ranked candidate list where the top two chunks share a document and lower-ranked chunks come from distinct documents; the final prompt context should include the first chunk from the dominant document and then distinct-document chunks before returning to the dominant document.

**Acceptance Scenarios**:

1. **Given** multiple high-ranking chunks from one document and relevant chunks from other documents, **When** final prompt contexts are selected, **Then** the selected contexts include distinct documents before adding a second chunk from the same document.
2. **Given** only one relevant document is available, **When** final prompt contexts are selected, **Then** the system may still include more than one chunk from that document within the configured cap and token budget.

---

### User Story 2 - Preserve existing context quality constraints (Priority: P2)

As a developer maintaining retrieval quality, I want document diversity to preserve duplicate removal and token-budget behavior, so better breadth does not reintroduce repeated text or oversized contexts.

**Why this priority**: The selector already protects prompt budget and exact duplicate content. Document diversity must layer onto those protections rather than replace them.

**Independent Test**: Can be tested with duplicate chunks, oversized chunks, and same-document chunks in one ranked list; selected contexts should remain within budget, skip duplicate text, and prefer document diversity.

**Acceptance Scenarios**:

1. **Given** duplicate content across retrieved chunks, **When** final prompt contexts are selected, **Then** duplicate content is still skipped.
2. **Given** a high-ranking chunk exceeds the prompt budget, **When** final prompt contexts are selected, **Then** later chunks that fit remain eligible.

---

### User Story 3 - Use a retrieval cascade before expensive reranking (Priority: P1)

As a workspace operator with broad document collections, I want Radioso to discover candidates widely but rerank and answer from a smaller high-quality shortlist, so answer quality improves without making every chat turn pay to judge every retrieved chunk.

**Why this priority**: A trace for query "yoga" retrieved 70 candidate chunks, reranked broadly, then packed only three final contexts, including one low-information fragment. Wide discovery is useful, but expensive reranking and final prompt packing need separate limits and quality gates.

**Independent Test**: Can be tested by passing more prepared candidates than the configured rerank candidate limit; the rerank gateway should only receive the capped shortlist, while final prompt selection should use a smaller final context limit.

**Acceptance Scenarios**:

1. **Given** many prepared candidates, **When** reranking is enabled, **Then** the reranker receives only the configured candidate shortlist rather than every retrieved chunk.
2. **Given** a reranked shortlist larger than the final answer context count, **When** prompt contexts are selected, **Then** the final answer context count remains bounded independently from the rerank candidate count.

---

### User Story 4 - Pack useful excerpts into the final answer prompt (Priority: P1)

As a visitor asking broad questions, I want the assistant to answer from several useful sources rather than one large chunk plus tiny boilerplate fragments, so broad queries can surface multiple relevant links and options.

**Why this priority**: The observed "yoga" answer selected a large shop page, a useful course chunk, and a near-empty "Back to All Events" chunk. Final prompt packing must prevent large chunks from monopolizing the budget and reject fragments that add no answerable evidence.

**Independent Test**: Can be tested with one large chunk, several medium useful chunks, and one tiny boilerplate chunk; the final prompt contexts should include truncated/excerpted useful chunks and skip the tiny boilerplate.

**Acceptance Scenarios**:

1. **Given** a selected chunk is larger than the per-context prompt excerpt budget, **When** it is packed into the final prompt, **Then** its content is excerpted and token cost is computed from the excerpt.
2. **Given** a low-information boilerplate fragment such as navigation text, **When** final prompt contexts are selected, **Then** it is skipped if other useful contexts are available.
3. **Given** the final answer has several useful selected contexts, **When** the answer model is called, **Then** the default answer token budget is high enough for a concise but complete multi-source answer.

### Edge Cases

- If no alternate documents are available, the selector should still return the best available same-document chunks up to the configured per-document cap.
- If alternate documents are available but exceed the token budget, the selector should continue considering same-document chunks that fit.
- If all remaining chunks are exact duplicates of selected content, the selector should stop without padding the prompt context.
- If a retrieved chunk contains only page chrome or navigation fragments, the selector should avoid using it as final answer evidence when useful chunks remain.
- If a highly relevant chunk is large, final prompt packing should use an excerpt rather than allowing it to crowd out all other useful contexts.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; runtime conversational copy MUST be generated by the LLM so multilingual behavior remains intact.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit tests MUST stay focused on non-visual logic rather than markup or design assertions.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Retrieval cascade policy is owned by retrieval domain services. Vector search, lexical search, chat routes, and prompt generation remain consumers of selected contexts and must not absorb document-diversity, rerank-candidate, or prompt-packing policy.
- **Encapsulation Rule**: `ContextSelectionStageService` owns orchestration between candidate scoring, reranking, and final prompt selection. `PromptContextSelectorService` owns final context ordering, excerpting, and filtering after reranking.
- **New Seams Required**: Add focused selector logic for document-aware passes, per-document counts, low-information filtering, and per-context excerpt packing. Add a separate rerank candidate cap before invoking the reranker. Avoid new persistence or transport surfaces.
- **Anti-Goals**: Do not change chunk ingestion, embedding text construction, visible citation collapse behavior, or answer prompt voice in this feature. Do not introduce a new external reranker provider in this PR.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST prefer distinct documents in final prompt contexts when multiple relevant documents are available.
- **FR-002**: The system MUST select the best eligible chunk from each document before selecting additional chunks from documents already represented.
- **FR-003**: The system MUST retain existing token-budget enforcement for final prompt contexts.
- **FR-004**: The system MUST retain existing duplicate-content suppression for final prompt contexts.
- **FR-005**: The system MUST cap same-document final prompt contexts by default so one document cannot dominate the prompt context.
- **FR-006**: The system MUST continue to return useful contexts when all eligible chunks come from a single document.
- **FR-007**: The system MUST cap the candidate set sent to an LLM reranker separately from the wider retrieval candidate count.
- **FR-008**: The system MUST cap the final answer context count separately from the reranked shortlist count.
- **FR-009**: The system MUST skip low-information final prompt chunks when other useful chunks are available.
- **FR-010**: The system MUST excerpt large final prompt chunks so a single chunk cannot consume most of the final prompt context budget.
- **FR-011**: The system SHOULD allow a higher default answer output token budget so multi-source answers can include useful detail without becoming verbose.

### Key Entities

- **Retrieved Chunk**: A ranked evidence unit returned by semantic or lexical retrieval, including document identity, title, content, scores, and retrieval source metadata.
- **Rerank Candidate**: A prepared candidate included in the capped shortlist sent to semantic reranking.
- **Final Prompt Context**: A retrieved chunk selected for answer-generation prompt context after reranking, duplicate suppression, document-diversity selection, and token-budget checks.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a ranked list with at least three eligible documents and multiple top chunks from one document, the final selected contexts include at least three distinct documents when the requested top count and token budget allow.
- **SC-002**: In a ranked list with only one eligible document, the selector returns at least one context and no more than the configured per-document cap when the requested top count and token budget allow.
- **SC-003**: Existing duplicate-content and token-budget selector tests continue to pass.
- **SC-004**: The feature requires no database migration and no API contract change.
- **SC-005**: A retrieval turn with more prepared candidates than the rerank candidate cap sends no more than the configured cap to the reranker.
- **SC-006**: A final prompt selection with one large useful chunk and several medium useful chunks can return at least four useful contexts when the requested final count and budget allow.
- **SC-007**: A final prompt selection skips tiny boilerplate fragments when useful alternatives exist.
