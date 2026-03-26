# Feature Specification: Large Result Set Hardening

**Feature Branch**: `030-document-list-scale`  
**Created**: 2026-03-26  
**Status**: Draft  
**Input**: User description: "Prevent the documents page from crashing the backend for workspaces with about 20,000 documents by confirming the failure mode and remediating document list scalability." Expanded scope: analyze all application paths that can return large result sets, not just documents, and fix them.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Browse large libraries safely (Priority: P1)

A workspace admin can open collection-heavy dashboard views, including Documents and saved history views, for a workspace with very large stored data without destabilizing the backend.

**Why this priority**: The system must eliminate unbounded collection reads that can crash or stall the backend when a workspace grows.

**Independent Test**: Seed representative large datasets for documents, saved conversations, and document-search history, then load the related views and verify each request completes with bounded results and no backend crash.

**Acceptance Scenarios**:

1. **Given** a workspace with approximately 20,000 documents, **When** the admin opens the Documents page, **Then** the system returns a bounded first page of results instead of the full library.
2. **Given** a workspace with large saved chat and search history collections, **When** the admin opens the History view, **Then** each collection is returned through bounded result windows and the backend remains responsive.

---

### User Story 2 - Continue operating at scale (Priority: P2)

An admin can page through large result sets and continue normal management actions without forcing a full-library reload.

**Why this priority**: The fix must preserve usability, not just reduce backend load.

**Independent Test**: Page through large document, conversation, and search-history lists, then create, retry, delete, or open items and verify visible counts and navigation remain accurate.

**Acceptance Scenarios**:

1. **Given** a paged collection view, **When** the admin moves between pages, **Then** the client fetches only the requested window and shows correct counts and page state.
2. **Given** a paged Documents view, **When** the admin creates, retries, or deletes a document, **Then** the visible list and total count remain consistent with the current sort order.

---

### User Story 3 - Open long-lived conversations predictably (Priority: P2)

An admin or anonymous end user can open a conversation with many stored messages without requiring the full conversation history to load at once.

**Why this priority**: Conversation detail endpoints can also grow without bound and should not remain as hidden high-cardinality paths after list endpoints are fixed.

**Independent Test**: Open a conversation with a large number of stored messages and verify the initial view loads a bounded window of messages with a clear way to load more history.

**Acceptance Scenarios**:

1. **Given** a conversation with many stored messages, **When** its detail view is opened, **Then** the system returns a bounded message window together with metadata needed to request additional history.
2. **Given** a bounded conversation detail view, **When** the user requests older messages, **Then** the next bounded message window is returned in the correct chronological order.

---

### User Story 4 - Verify and explain the remediation (Priority: P3)

An operator or developer can confirm which large-result-set paths were unbounded before the fix and can review a clear remediation summary describing the bounded-work changes.

**Why this priority**: The user asked both for analysis and for a fix, so the feature must leave behind a clear explanation of what was hardened.

**Independent Test**: Review each identified large-result-set path, compare pre-fix and post-fix behavior, and verify that the final summary maps each risky path to its remediation.

**Acceptance Scenarios**:

1. **Given** the set of collection-returning routes in the app, **When** the analysis is complete, **Then** each path is categorized as bounded by design, newly hardened, or intentionally out of scope with justification.
2. **Given** the final delivery summary, **When** an operator reviews it, **Then** it clearly states the previously unbounded paths and the changes that now keep them bounded.

### Edge Cases

- A collection has zero results and still returns a valid empty page.
- The final page contains fewer items than the standard page size.
- Items are created or deleted between page requests and the next page request remains valid.
- A requested page or message window falls beyond the current total after deletions.
- Conversation messages remain chronologically correct when older windows are fetched.
- Invalid paging inputs are rejected safely instead of triggering unbounded backend work.
- Small bounded collections that are inherently low-cardinality remain unchanged unless they share the same unbounded risk pattern.

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
- Backend HTTP contract changes MUST be defined in the code-first OpenAPI registry and regenerated from code rather than hand-editing generated artifacts.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: HTTP routes own request validation and response shaping; service-layer list/detail orchestration owns collection paging behavior; repositories own bounded data access; frontend API clients and views own page navigation and merge behavior for additional windows.
- **Encapsulation Rule**: Route handlers must remain transport-only, services must remain orchestration-only, repositories must remain persistence-only, and UI views must not absorb backend-specific shaping logic beyond requesting result windows and rendering paging state.
- **New Seams Required**: The feature must formalize dedicated bounded read paths for high-cardinality collections, including summary-list reads and conversation-message window reads, rather than reusing full-detail queries for collection browsing.
- **Anti-Goals**: Do not keep any user-generated high-cardinality route unbounded. Do not fetch full document bodies for list views. Do not fetch all messages for long conversation threads on initial load. Do not rely on larger process limits, longer timeouts, or payload-size increases as the primary remediation. Do not expand into unrelated retrieval ranking, ingestion, or connector redesign work.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST identify every application route that can return user-generated large result sets and must harden each route that is currently unbounded.
- **FR-002**: The system MUST support bounded retrieval for authenticated document list browsing.
- **FR-003**: The system MUST support bounded retrieval for authenticated chat-history summary browsing.
- **FR-004**: The system MUST support bounded retrieval for document-search history summary browsing.
- **FR-005**: The system MUST support bounded retrieval for anonymous-session conversation summary browsing.
- **FR-006**: The system MUST support bounded retrieval for conversation message history when opening long-lived conversation details.
- **FR-007**: Each hardened collection response MUST include paging metadata needed for the client to render navigation and result counts without loading the full collection.
- **FR-008**: Collection list responses MUST include only the fields required for list-level browsing and actions.
- **FR-009**: Existing list sort orders MUST be preserved unless explicitly changed by a later approved specification.
- **FR-010**: Invalid paging inputs MUST fail safely with a clear client-visible error.
- **FR-011**: The Documents view, History view, and anonymous chat bootstrap flow MUST request only the currently needed collection window during normal use.
- **FR-012**: The system MUST include automated coverage for each newly hardened high-cardinality path, including at least one validation scenario that exercises approximately 20,000 stored records for a representative collection.
- **FR-013**: The final remediation summary MUST explicitly list the high-cardinality paths reviewed, identify which were unbounded, and describe the bounded-work fix for each.

### UI Tasks

- Show page state and total counts for large collection views where users browse lists.
- Allow users to move through collection pages without loading the full collection into the browser.
- Preserve existing list-level actions in the Documents and History views.
- Show bounded conversation history with a clear affordance for loading older messages when more history exists.
- Keep loading, empty, and error states understandable for paged collection browsing.

### Key Entities *(include if feature involves data)*

- **Collection Page**: A bounded window of collection items plus total-count metadata.
- **Conversation Message Window**: A bounded chronological slice of messages from a single conversation plus metadata for requesting older history.
- **Collection Paging Request**: The requested result window within a high-cardinality collection.

## Assumptions

- High-cardinality paths are the routes that can return user-generated collections whose size can grow substantially with workspace use.
- Low-cardinality administrative collections, such as fixed connector registries, are out of scope unless analysis shows they are effectively unbounded in practice.
- Default page sizes may differ between list views and conversation message windows as long as each remains bounded and predictable.
- Live document search results are already bounded by retrieval behavior and are not part of this hardening unless analysis reveals an unbounded path.
- Confirmation of the failure modes can be satisfied through code-path analysis and reproducible validation evidence rather than requiring production incident logs.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Opening the Documents page for a workspace with approximately 20,000 documents completes successfully without backend crash or restart during validation.
- **SC-002**: Loading large chat-history, document-search-history, and public-conversation summary views completes successfully through bounded result windows.
- **SC-003**: Opening a long-lived conversation no longer requires the full stored message history to be returned in the initial response.
- **SC-004**: Repeated requests across the hardened high-cardinality paths complete successfully for at least 95% of representative validation runs.
- **SC-005**: During representative large-collection validation, unrelated authenticated API requests remain available while these collection requests are in progress.
- **SC-006**: The final remediation summary identifies every high-cardinality path reviewed and clearly states whether it was hardened, already bounded, or intentionally excluded with justification.
