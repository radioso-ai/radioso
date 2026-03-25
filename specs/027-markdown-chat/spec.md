# Feature Specification: Safe Markdown Chat Answers

**Feature Branch**: `027-markdown-chat`  
**Created**: 2026-03-25  
**Status**: Draft  
**Input**: User description: "Support safe markdown rendering in assistant chat answers while preserving structured citations and streaming behavior"

## User Scenarios & Testing *(mandatory)*

<!--
  IMPORTANT: User stories should be PRIORITIZED as user journeys ordered by importance.
  Each user story/journey must be INDEPENDENTLY TESTABLE - meaning if you implement just ONE of them,
  you should still have a viable MVP (Minimum Viable Product) that delivers value.
  
  Assign priorities (P1, P2, P3, etc.) to each story, where P1 is the most critical.
  Think of each story as a standalone slice of functionality that can be:
  - Developed independently
  - Tested independently
  - Deployed independently
  - Demonstrated to users independently
-->

### User Story 1 - Read Structured Answers Clearly (Priority: P1)

As a workspace user reading an assistant response, I can see common structured formatting such as paragraphs, lists, code snippets, links, and quoted text so that long answers are easier to scan and follow.

**Why this priority**: Readability is the primary user value of markdown support, and it should stand on its own even if no citation-specific work ships beyond preserving the current behavior.

**Independent Test**: Can be fully tested by asking the assistant for list-heavy or code-heavy answers and confirming that supported markdown patterns render as readable formatted content instead of undifferentiated plain text.

**Acceptance Scenarios**:

1. **Given** an assistant answer containing supported markdown patterns, **When** the answer is displayed in chat, **Then** the content is rendered with readable formatting that preserves the original wording.
2. **Given** an assistant answer containing inline and fenced code, **When** the answer is displayed in chat, **Then** code content remains visually distinct from surrounding prose and line breaks are preserved.

---

### User Story 2 - Keep Citations Trustworthy (Priority: P2)

As a workspace user relying on source-backed answers, I can still see and open citations in the same answer even when markdown formatting is present, so that readability improvements do not weaken answer provenance.

**Why this priority**: Citation integrity is a core product trust feature. Markdown support that interferes with citation placement or source access would reduce confidence in the product.

**Independent Test**: Can be fully tested by displaying an assistant answer that contains both supported markdown and citations, then confirming that citation markers still appear in the intended places and still open the referenced documents.

**Acceptance Scenarios**:

1. **Given** an assistant answer with both supported markdown and citation-backed segments, **When** the answer is displayed, **Then** citations remain attached to the intended text and can still be opened from the chat UI.
2. **Given** a response where citation display is disabled, **When** the answer is displayed, **Then** supported markdown formatting still renders but citation markers are not shown.

---

### User Story 3 - Reject Unsafe Rich Content (Priority: P3)

As a workspace operator, I can trust that markdown rendering will not execute unsafe rich content or introduce arbitrary embedded content into chat answers.

**Why this priority**: The value of better formatting does not justify opening an XSS or unsafe-content surface in the assistant UI.

**Independent Test**: Can be fully tested by rendering answers that include unsupported or unsafe markdown constructs and confirming they are ignored, downgraded to inert text, or otherwise prevented from creating active rich content.

**Acceptance Scenarios**:

1. **Given** an assistant answer containing raw HTML or unsupported rich content, **When** the answer is displayed, **Then** the UI does not execute or render that content as active rich content.
2. **Given** an assistant answer containing a standard markdown link, **When** the answer is displayed, **Then** the link remains usable without granting the answer any broader rendering privileges.

---

### Edge Cases

- What happens when a markdown delimiter is incomplete because the answer is still streaming?
- What happens when a citation boundary splits text that also contains markdown formatting?
- How does the system handle unsupported markdown constructs such as tables, images, task lists, or raw HTML?
- How does the UI behave when a markdown link and a citation marker appear adjacent to each other?
- What happens when historical assistant messages created before this feature are reopened in chat history?

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
- Backend API contracts MUST remain code-first and any HTTP contract change must regenerate generated OpenAPI artifacts instead of hand-editing them.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Chat transport and streaming event shapes remain owned by backend chat presenters and route handlers; answer normalization and citation mapping remain owned by backend chat presentation services; markdown rendering behavior remains owned by focused frontend chat rendering components; document-opening behavior remains owned by existing citation interaction components.
- **Encapsulation Rule**: `backend/src/modules/chat/services/chatService.ts` must remain orchestration-focused and must not absorb frontend rendering rules; `frontend/components/dashboard/chat-message-thread.tsx` must remain a container-level thread view rather than becoming the place where markdown parsing, citation reconciliation, and safety policy all accumulate.
- **New Seams Required**: The feature may introduce a dedicated assistant-message markdown renderer or formatting helper in the frontend so markdown parsing, sanitization policy, and citation-aware rendering are isolated from thread layout concerns.
- **Anti-Goals**: Do not switch chat answers to arbitrary HTML rendering; do not embed citation semantics inside markdown syntax; do not broaden the scope into user-authored markdown composition; do not add unsupported rich media features as part of this work.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST render a supported markdown subset in assistant chat answers, including paragraphs, line breaks, emphasis, inline code, fenced code blocks, blockquotes, bullet lists, numbered lists, and links.
- **FR-002**: The system MUST preserve the existing plain-language answer content when rendering supported markdown, so that formatting changes do not alter the meaning of the response text.
- **FR-003**: The system MUST keep citations as structured UI elements attached to answer segments rather than requiring citations to be encoded in markdown.
- **FR-004**: The system MUST preserve citation placement and document-opening behavior for answers that include both citations and supported markdown formatting.
- **FR-005**: The system MUST continue to present readable assistant responses while streaming, including cases where markdown delimiters are incomplete until later chunks arrive.
- **FR-006**: The system MUST treat raw HTML and unsupported rich markdown constructs as non-active content so they cannot execute scripts, inject arbitrary markup, or embed external rich content in the chat answer surface.
- **FR-007**: The system MUST preserve backward compatibility for previously stored assistant messages so historical chat answers still render safely even if they contain no markdown metadata beyond their stored text and citations.
- **FR-008**: The system MUST limit this feature to assistant-answer presentation and MUST NOT introduce markdown authoring or rich-text editing features for end users.

### UI Tasks

- Display supported markdown patterns in assistant messages with clear visual hierarchy that matches the existing chat UI.
- Preserve current citation markers, hover affordances, and document-opening interactions when citations appear near formatted text.
- Ensure code blocks, lists, and blockquotes remain legible on both desktop and narrow mobile layouts.

### Key Entities

- **Assistant Answer**: A chat response shown to the user, including response text, optional citation metadata, and optional answer segments used to place citations.
- **Answer Segment**: A contiguous portion of assistant answer text that may carry one or more citation references and must remain renderable alongside markdown formatting.
- **Citation Marker**: A structured source reference in the chat UI that opens a document and must remain separate from markdown syntax.
- **Supported Markdown Subset**: The small set of formatting patterns allowed in assistant answers for readability without enabling arbitrary rich content.

### Assumptions

- Tables, images, task lists, and raw HTML are out of scope for the initial release unless later approval expands the feature.
- Existing chat APIs can continue to expose answer text, citations, and answer segments without introducing a general-purpose HTML payload.
- Existing citation behavior remains the source of truth for provenance even when markdown formatting is added to the visible answer text.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In manual verification, all supported markdown patterns in the approved subset render as formatted assistant content in both live chat and reopened chat history.
- **SC-002**: Citation-backed answers that include supported markdown retain correct citation placement and source-opening behavior in 100% of covered regression scenarios.
- **SC-003**: Unsafe-content regression scenarios confirm that unsupported rich content does not render as active embedded content or executable markup in the chat surface.
- **SC-004**: Historical assistant messages without new formatting constructs continue to render without user-visible regressions in covered chat history scenarios.
