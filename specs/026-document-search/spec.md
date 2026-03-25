# Feature Specification: Document Search

**Feature Branch**: `026-document-search`  
**Created**: 2026-03-25  
**Status**: Draft  
**Input**: User description: "Add a document discovery feature with a headless search API, a documents top-bar search UI, persisted search history entries, and the same diagnostic trace graph available for chat retrieval."

## User Scenarios & Testing *(mandatory)*

## Clarifications

### Session 2026-03-25

- Q: When a prior document search is reopened later, should the system replay the stored result set or rerun search against the current document corpus? → A: Reopen uses stored snapshot semantics; fresh execution is a separate action.
- Q: Should document search diagnostics reuse the existing retrieval trace contract or introduce a separate search-specific trace model? → A: Reuse the existing retrieval trace contract and graph model, with chat-only stages marked skipped or unavailable where needed.
- Q: What exact next-step actions are guaranteed on each ranked result in v1? → A: V1 guarantees open document, inspect match evidence, open diagnostics/history entry, and rerun the same query as a new search; direct search-to-chat pivot is out of scope.

### User Story 1 - Search Documents Headlessly (Priority: P1)

An API consumer can submit a document search request and receive ranked document results that explain why each document matched, without needing to use the dashboard.

**Why this priority**: The primary product value is headless document discovery. Without the API, the feature does not solve the main usage mode.

**Independent Test**: Can be fully tested by submitting a search request with and without filters, verifying that ranked documents are returned with bounded match explanations, and confirming that ordinary document browsing remains separate.

**Acceptance Scenarios**:

1. **Given** a workspace with searchable documents, **When** an API consumer submits a document search request with a query, **Then** the system returns ranked document results scoped to that workspace.
2. **Given** a search request that includes supported filters, **When** the request is executed, **Then** only documents satisfying those filters are eligible for the ranked result set.
3. **Given** a search query that matches no eligible documents, **When** the request completes, **Then** the system returns an explicit no-results outcome rather than a misleading empty browse response.

---

### User Story 2 - Review Search Diagnostics Historically (Priority: P1)

An operator can reopen a prior document search from history and inspect the same diagnostic graph used for retrieval-backed chat answers so they can understand how the search behaved.

**Why this priority**: Search becomes operationally trustworthy only when it is traceable and reviewable after the fact. This is part of the requested behavior, not an optional enhancement.

**Independent Test**: Can be fully tested by executing a document search, confirming the search is recorded in history, reopening that search later, and verifying that the diagnostic graph and bounded trace data are available or explicitly unavailable.

**Acceptance Scenarios**:

1. **Given** a completed document search, **When** the operator opens search history, **Then** the search appears as a distinct historical entry rather than disappearing after the initial response.
2. **Given** a historical document search entry, **When** the operator opens its diagnostics, **Then** the system shows the recorded search trace as a readable graph with stable identity.
3. **Given** an older or partial search record without a full trace, **When** the operator opens diagnostics, **Then** the system shows an explicit unavailable state instead of a broken or misleading graph.

---

### User Story 3 - Reuse Search Runs As A Knowledge Workflow (Priority: P2)

A headless consumer or dashboard operator can treat a document search as a reusable knowledge-discovery step, not just a one-shot result list, by reopening the search later and acting on the matching documents.

**Why this priority**: If search only returns a transient list, users will still have to rebuild context manually. Making searches replayable and actionable is what turns this into a real product surface.

**Independent Test**: Can be fully tested by executing a document search, reopening the same search later by its stable identity, and confirming that the caller can inspect the same result set and act on returned documents without rerunning the search blindly.

**Acceptance Scenarios**:

1. **Given** a completed document search, **When** the caller reopens that search by its stable identity, **Then** the system returns the stored search summary, stored ranked result set, and diagnostic availability for that execution rather than silently recomputing current results.
2. **Given** a ranked search result, **When** the caller inspects that result, **Then** the system provides enough information and linked actions to continue the knowledge workflow instead of forcing the caller to start over elsewhere.
3. **Given** the underlying document set has changed since the original search, **When** the caller reopens the stored search, **Then** the historical search remains identifiable and reviewable even if some current document actions degrade gracefully.

---

### User Story 4 - Search From The Documents Top Bar (Priority: P3)

A dashboard user can use a search control at the top of the Documents view to find relevant documents quickly without losing access to the existing document-management workflow.

**Why this priority**: The dashboard should expose the same discovery capability for operators, but the headless API is the more important slice because it is the primary usage mode.

**Independent Test**: Can be fully tested by opening the Documents view, running a search from the top bar, verifying ranked results render in the existing surface, and clearing the query to return to ordinary browsing.

**Acceptance Scenarios**:

1. **Given** a dashboard user in the Documents view, **When** they enter a search query in the top-bar search control, **Then** the documents surface switches from plain browsing to ranked search results.
2. **Given** ranked search results are visible, **When** the user clears the search query, **Then** the Documents view returns to the ordinary browse list without leaving stale search state behind.
3. **Given** the search request is loading, fails, or returns no matches, **When** the Documents view updates, **Then** the user sees explicit loading, failure, or no-results states that preserve the existing page context.

### Edge Cases

- What happens when multiple chunks from the same document match strongly? The system should return one document result with bounded evidence of the strongest matches rather than duplicate document rows.
- What happens when a search query is empty or whitespace-only? The system should not create a misleading search execution and should preserve ordinary document browsing behavior.
- What happens when a document is deleted or reprocessed after a search is recorded? Historical search entries should remain reviewable, and any now-missing source material should degrade to an explicit unavailable state.
- What happens when supported filters narrow the candidate set to zero documents? The system should return a valid no-results outcome with the filters still visible to the caller or operator.
- What happens when a trace contains bounded diagnostics for search but not every optional stage participated? The graph should show skipped or unavailable stages explicitly rather than implying all stages ran.
- What happens when a workspace contains a large number of documents or repeated searches are run close together? Search history ordering and result identity should remain stable enough for operators to reopen the intended search entry.
- What happens when a caller reopens an older search after one or more matched documents have been removed? The historical snapshot should remain readable, and actions on missing documents should fail with an explicit unavailable state.

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

- **Boundary Rule**: Dedicated document-search transport owns request validation and response serialization; dedicated document-search orchestration owns query execution, result shaping, search-history recording, and trace correlation; existing retrieval modules remain the source of ranked candidate signals; persistence modules own durable search-history and trace storage or replay; the Documents view owns dashboard presentation of top-bar search states and results.
- **Encapsulation Rule**: `documentRoutes.ts` MUST remain transport-only and MUST NOT absorb ranking or trace-assembly logic. `backend/src/app/http/openapi/document.ts` MUST remain the code-first contract owner for all HTTP changes. Existing chat history and chat trace surfaces MUST remain responsible-limited and MUST NOT be repurposed into a generic search service or generic diagnostics god module. The Documents view MUST remain the owner of list and search presentation rather than pushing page-state orchestration into generic layout code.
- **New Seams Required**: Introduce an explicit document-search service boundary, an explicit document-search HTTP contract, a focused history-record seam for document-search executions, and a focused trace-presentation seam that can expose document-search diagnostics through the existing retrieval trace contract and graph model without coupling search execution to chat-answer generation.
- **Anti-Goals**: Do not overload `GET /document/` with ranked discovery behavior. Do not build a title-only or filename-only search that ignores document-content relevance. Do not move retrieval ranking logic into route handlers or frontend components. Do not create a second diagnostics model that diverges from the existing retrieval trace graph semantics.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a dedicated document-search operation separate from ordinary document browsing so API consumers can explicitly request ranked discovery behavior.
- **FR-002**: The document-search operation MUST accept a query string and return document-level ranked results scoped to the authenticated workspace.
- **FR-003**: The document-search operation MUST support bounded filtering for supported document attributes and metadata so callers can narrow eligible results without post-filtering client-side.
- **FR-004**: Ranked search results MUST represent documents, not duplicate chunk rows, even when multiple matching passages from one document contribute to its rank.
- **FR-005**: Each ranked document result MUST include bounded explanation fields that help the caller understand why the document matched, such as short match snippets, matched metadata, or other readable evidence.
- **FR-006**: The document-search operation MUST distinguish explicit no-results outcomes from errors and from ordinary unfiltered document browsing.
- **FR-007**: The document-search operation MUST give each completed search a stable identifier so the search can be correlated with its stored history entry and diagnostics.
- **FR-008**: The system MUST record each completed document search as a durable history entry associated with the active workspace.
- **FR-009**: Each document-search history entry MUST preserve enough summary information for later identification, including the submitted query, execution time or recency, and result count.
- **FR-009a**: The system MUST provide a way for callers to list prior document-search history entries for the active workspace.
- **FR-009b**: The system MUST provide a way for callers to retrieve one prior document-search execution by its stable identity, including its stored summary, stored ranked result set, and diagnostic availability.
- **FR-010**: The system MUST capture or preserve a bounded trace for each eligible document search so operators can inspect how the ranked result set was produced.
- **FR-011**: Document-search diagnostics MUST use the same readable graph model already used for retrieval-backed chat diagnostics rather than introducing a separate operator mental model.
- **FR-011a**: Document-search diagnostics MUST reuse the existing retrieval trace contract rather than introducing a parallel top-level search-trace contract.
- **FR-012**: The document-search trace MUST expose a stable trace identity and bounded stage-level diagnostics sufficient to explain query interpretation, candidate generation, ranking or selection, and final result shaping.
- **FR-013**: When a stage did not participate, was skipped, or is unavailable for a search trace, the diagnostic graph MUST show that state explicitly instead of implying a successful execution path.
- **FR-013a**: Chat-specific trace stages that do not apply to document search MUST be represented through the existing trace status model as skipped or unavailable rather than forcing search executions into fabricated chat outcomes.
- **FR-014**: The system MUST preserve historical document-search entries, stored ranked results, and their diagnostic availability independently of whether the current live document set has changed since the original search.
- **FR-014a**: Reopened historical searches MUST remain reviewable even when some linked documents or downstream actions are no longer available, and those unavailable actions MUST fail safely with explicit messaging.
- **FR-014b**: Reopening a historical document search MUST replay the stored search snapshot, while any fresh execution against the current corpus MUST be exposed as a separate new search action.
- **FR-015**: The dashboard Documents view MUST provide a search control in the top bar that executes the same document-search capability rather than a separate ad hoc browse filter.
- **FR-016**: When a dashboard search is active, the Documents view MUST render ranked search results and associated loading, failure, and no-results states without breaking access to ordinary document-management actions.
- **FR-017**: Clearing the active search in the Documents view MUST return the page to ordinary browse behavior without requiring a full route change or leaving stale ranked results visible.
- **FR-018**: The dashboard experience MUST provide access to the historical search entry or diagnostics for a completed document search using the same trace model available to headless consumers and operators.
- **FR-019**: Search history and diagnostics data MUST remain workspace-scoped and MUST fail safely when an entry or trace is unavailable to the current caller.
- **FR-020**: The feature MUST preserve the existing browse/list document operation as a plain browsing surface and MUST NOT silently change its semantics into ranked search.
- **FR-021**: Each ranked document result MUST provide clear next-step actions appropriate to the caller, such as opening the document, inspecting why it matched, or pivoting into a downstream knowledge workflow using that result.
- **FR-021**: Each ranked document result MUST provide the following v1 next-step actions: open the document, inspect match evidence, open the related diagnostics or history entry, and rerun the same query as a fresh new search.
- **FR-021a**: Directly pivoting from document search into a chat flow constrained to one document or result set is out of scope for this feature version.
- **FR-022**: The system MUST make the distinction between a live new search execution and a reopened historical search execution visible to the caller so replay and fresh execution are not confused.

### UI Tasks

- Add a search control to the top bar of the Documents view.
- Show explicit loading, failure, and no-results states for document search within the Documents surface.
- Render ranked document results in the existing Documents experience without presenting duplicate rows for the same document.
- Let operators clear the active search and return to ordinary document browsing quickly.
- Let operators reopen a historical search and understand whether they are viewing a fresh search or a stored prior run.
- Provide an entry point from a completed search result set or history surface to the corresponding diagnostic graph.
- Provide visible v1 next-step actions on ranked search results: open document, inspect match evidence, open diagnostics or history entry, and rerun as a fresh search.
- Reuse the existing dashboard visual language for search, history, and diagnostics states.

### Key Entities *(include if feature involves data)*

- **Document Search Request**: One explicit discovery operation containing a query, supported filters, workspace scope, and caller intent to retrieve ranked documents rather than browse the full list.
- **Document Search Result**: One ranked document-level match that includes document identity, rank position, bounded explanation fields, and correlation to the search execution that produced it.
- **Document Search History Entry**: A durable historical record of one completed document search, including stable search identity, submitted query, recency, result count, and diagnostic availability state.
- **Document Search Replay**: A reopened historical search execution that returns the stored summary, stored ranked result set, and trace availability for a prior search run without silently recomputing current results.
- **Document Search Trace**: The bounded diagnostic record for one document search execution, aligned to the same graph semantics used by retrieval-backed chat traces.
- **Shared Retrieval Trace Contract**: The existing trace schema and graph model reused across chat and document-search diagnostics, with stage participation varying by execution type.

## Assumptions

- The first release focuses on one workspace-scoped search operation and does not introduce cross-workspace search.
- Search uses the same general retrieval-quality concepts already present in the product, but this feature remains document discovery rather than answer generation.
- Ordinary document browsing remains valuable and should continue to exist as a separate workflow from ranked search.
- Historical search entries may outlive underlying document changes, so diagnostics must tolerate deleted, updated, or reprocessed documents gracefully.
- Reopening a prior search is a historical replay operation; re-running the same query against the current corpus is a separate fresh search.
- Document-search diagnostics reuse the existing retrieval trace contract and graph model, with non-applicable chat-only stages represented explicitly as skipped or unavailable.
- The guaranteed v1 action set stops short of direct search-to-chat pivoting; that remains a possible follow-on feature.
- The initial dashboard search surface can stay focused on query-first discovery without requiring a full advanced-filter builder in the same release.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In acceptance coverage, 100% of successful document-search API calls return either ranked document results or an explicit no-results outcome, never an ambiguous browse-style payload.
- **SC-002**: In acceptance coverage, 100% of completed document searches receive a stable identifier and a corresponding history entry that can be reopened later.
- **SC-003**: In historical diagnostics coverage, 100% of eligible completed document searches expose either their recorded trace graph or an explicit unavailable state.
- **SC-004**: In relevance evaluation using representative document-search tasks, the intended document appears in the top results often enough that operators can successfully identify the target document within the first result page for at least 85% of tasks.
- **SC-005**: In dashboard validation, operators can locate a target document from the Documents top-bar search within 30 seconds for at least 90% of representative search tasks.
- **SC-006**: In history-replay validation, 100% of completed document searches can be listed and reopened by stable identity, or return an explicit unavailable outcome when access is no longer valid.
- **SC-007**: In workflow validation, 100% of ranked search results expose at least one clear next-step action without requiring users to manually reconstruct search context elsewhere.
- **SC-007**: In workflow validation, 100% of ranked search results expose the guaranteed v1 next-step actions without requiring users to manually reconstruct search context elsewhere.
- **SC-008**: In regression coverage, 100% of ordinary document browse flows continue to function without requiring a search query or inheriting ranked-search semantics.
- **SC-009**: In bounded-diagnostics validation, 100% of document-search traces exclude prohibited sensitive content such as secrets, unrestricted raw logs, full raw prompts, and full raw document bodies.
