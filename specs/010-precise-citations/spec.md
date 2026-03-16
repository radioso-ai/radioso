# Feature Specification: Precise Citation Placement

**Feature Branch**: `010-precise-citations`  
**Created**: 2026-03-16  
**Status**: Draft  
**Input**: User description: "Fix chat citations so the backend generates precise source placement instead of heuristic post-processing"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read Precisely Cited Answers (Priority: P1)

An authenticated account user asks a question in chat and reads an assistant answer whose inline citations appear exactly where the supporting claim was written, instead of being guessed after generation.

**Why this priority**: Citation trust depends on marker placement being exact and predictable. If placement is wrong, the feature loses credibility even when retrieval is correct.

**Independent Test**: Can be fully tested by asking a question that produces a multi-claim answer and confirming each visible citation marker appears at the intended claim boundary, opens the expected source, and does not appear inside unrelated text such as URLs or numeric values.

**Acceptance Scenarios**:

1. **Given** a chat response is generated from retrieved sources, **When** the completed answer is shown, **Then** each citation marker appears only at the exact claim location declared by the backend for that answer.
2. **Given** an answer contains multiple cited claims, **When** the user reads the answer, **Then** the citation numbering remains consistent within that answer and each marker maps to the intended source.
3. **Given** an answer contains uncited connective text, **When** the answer is rendered, **Then** citation markers do not appear in unrelated words, punctuation, URLs, or currency values.

---

### User Story 2 - Receive Stable Streaming Answers (Priority: P2)

An authenticated account user receives a streamed answer without seeing malformed citation placeholder syntax, and the completed streamed answer resolves into the same precise citation layout as the non-streamed path.

**Why this priority**: Streaming is already part of the chat experience, so the citation fix cannot regress completion behavior or expose raw formatting artifacts while the answer is in flight.

**Independent Test**: Can be fully tested by submitting a streamed chat request and confirming that in-progress content remains readable, the completed message resolves to precise inline citations, and the final answer matches the non-streamed citation placement rules.

**Acceptance Scenarios**:

1. **Given** a streamed answer is still in progress, **When** partial text is shown, **Then** the user does not see broken or half-parsed citation syntax in the visible message state.
2. **Given** a streamed answer finishes successfully, **When** completion metadata is applied, **Then** the final rendered answer uses the same precise citation placement contract as the non-streamed response.
3. **Given** citation formatting cannot be validated on completion, **When** the streamed answer finalizes, **Then** the user still receives a readable answer and only validated citations are rendered.

---

### User Story 3 - Avoid Broken Citation States (Priority: P3)

An authenticated account user receives a readable answer even when the model emits invalid or incomplete citation anchors, rather than seeing raw placeholders or misleading source markers.

**Why this priority**: Precision only matters if failure handling is also safe. Invalid citation output must degrade predictably instead of producing a broken trust signal.

**Independent Test**: Can be fully tested by forcing invalid citation anchors in backend tests and confirming that unresolved placeholders are removed or ignored, invalid source references are not rendered, and valid references in the same answer still appear.

**Acceptance Scenarios**:

1. **Given** the model emits a citation anchor that does not map to any retrieved source, **When** the answer is finalized, **Then** that invalid citation is excluded from the rendered metadata.
2. **Given** the model emits a mixture of valid and invalid citation anchors, **When** the answer is finalized, **Then** the valid citations are preserved and the invalid ones do not create misleading markers.
3. **Given** citation anchors are malformed or incomplete, **When** the answer is finalized, **Then** the visible answer remains readable and no raw placeholder syntax is left behind.

### Edge Cases

- If the model emits duplicate anchors for the same source at one claim boundary, the answer should render a stable, deduplicated citation set at that exact location.
- If a source is retrieved but never cited in the generated answer, it should not appear as a visible inline citation.
- If the model cites a source number outside the retrieved result range, that source number should not become a visible marker.
- If the answer contains markdown, lists, links, or line breaks, citation placement should still attach to the intended claim boundary without breaking formatting.
- If the completed answer contains no valid citation anchors, the answer should still render without empty citation chrome or orphaned source lists.

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

- **Boundary Rule**: Retrieval services own ordered source context preparation; chat generation services own citation-anchor instructions and raw answer handling; chat presentation services own validation, normalization, and exact answer-segment construction; HTTP presenters remain transport-only; frontend chat components remain render-only for backend-supplied placement metadata.
- **Encapsulation Rule**: `backend/src/modules/chat/services/chatService.ts` MUST remain an orchestration layer and MUST NOT absorb citation parsing rules. `backend/src/modules/chat/services/answerPresentationService.ts` MUST stop using token-overlap heuristics for placement and either be reduced to deterministic normalization or delegate to a focused citation-anchor parser.
- **New Seams Required**: Introduce a focused backend seam for citation-anchor formatting and validation, including source numbering rules, raw-output parsing, invalid-anchor handling, and exact `answerSegments` generation for both JSON and SSE completion paths.
- **Anti-Goals**: Do not add more overlap scoring or punctuation heuristics to recover placement. Do not move citation interpretation into the frontend. Do not let route handlers, SSE presenters, or generic chat UI components parse model citation syntax directly.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST assign stable source numbers to retrieved results for each answer generation attempt before the model produces the answer.
- **FR-002**: The system MUST instruct the model to cite retrieved results using an explicit backend-parseable anchor format tied to those source numbers.
- **FR-003**: The system MUST parse the raw generated answer and convert valid citation anchors into exact answer-segment citation metadata instead of inferring placement from text similarity.
- **FR-004**: The system MUST preserve the visible answer wording and ordering except for removing or transforming citation-anchor syntax into structured citation metadata.
- **FR-005**: The system MUST include only sources that were explicitly and validly cited in the completed answer as visible citations for that message.
- **FR-006**: The system MUST ignore or remove citation anchors that reference unknown, malformed, or incomplete source numbers rather than rendering misleading markers.
- **FR-007**: The system MUST deduplicate repeated citations at the same rendered claim boundary while preserving distinct cited sources when multiple valid sources are attached to one claim.
- **FR-008**: The system MUST produce the same completed-answer citation placement contract for both non-streamed chat responses and SSE completion events.
- **FR-009**: The system MUST ensure the in-progress streaming state does not expose unfinished citation-anchor syntax as the final user-visible citation representation.
- **FR-010**: The system MUST preserve existing citation click behavior so each rendered citation still opens the intended account-scoped document.
- **FR-011**: The system MUST record enough validation behavior in tests to prove exact placement, invalid-anchor handling, and response parity between streaming and non-streaming paths.

### UI Tasks

- Render inline citation markers only from backend-provided exact placement metadata.
- Preserve existing source hover and document-opening interactions for valid citations.
- Avoid showing raw backend citation-anchor syntax in the completed assistant message.

### Key Entities *(include if feature involves data)*

- **Retrieved Result Number**: The ordered source identifier assigned to a retrieved context for one answer-generation attempt.
- **Citation Anchor**: The explicit source reference emitted in the raw model answer that points to one or more retrieved result numbers.
- **Presented Answer Segment**: A contiguous span of visible answer text paired with the exact citation indices that apply at that boundary.
- **Validated Citation Reference**: A rendered source marker derived only from a citation anchor that successfully maps to a retrieved result for the same answer.

## Assumptions & Dependencies

- The backend can safely change the prompt format used for grounded chat answers as long as the user-visible answer content remains readable.
- The frontend can continue rendering citations from `answerSegments` and `citations` as long as the payload remains structurally equivalent or changes in a backward-compatible way.
- Streaming can finalize precise citation placement on completion even if in-progress chunks do not yet carry citation metadata.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In acceptance testing, 100% of completed cited answers place markers only at backend-declared claim boundaries and never inside unrelated text such as URLs, numbers, or punctuation fragments.
- **SC-002**: In regression testing, 100% of invalid citation anchors are excluded from rendered citation metadata without leaving raw placeholder syntax in the completed answer.
- **SC-003**: In validation runs, the completed streamed response and the completed non-streamed response produce equivalent citation placement for the same generated answer content.
- **SC-004**: In user acceptance testing, 100% of rendered citation markers continue to open the intended account-scoped source document.

