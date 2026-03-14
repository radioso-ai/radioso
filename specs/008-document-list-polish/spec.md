# Feature Specification: Document List Polish

**Feature Branch**: `008-document-list-polish`  
**Created**: 2026-03-14  
**Status**: Draft  
**Input**: User description: "Polish document list layout and status display, add document deletion, and make chat citations fail gracefully when a cited source has been deleted"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Manage Documents Without Layout Breakage (Priority: P1)

An authenticated dashboard user reviews documents in the knowledge-base list and can read long titles without horizontal scrolling or clipped status information.

**Why this priority**: The current list is hard to use during normal document management, and fixing readability is the main UX problem raised by the request.

**Independent Test**: Can be fully tested by opening the documents list with short and long titles on common desktop and tablet widths and confirming that each row stays within the viewport, titles remain readable, and no horizontal page scrolling is required.

**Acceptance Scenarios**:

1. **Given** the documents list includes long document titles, **When** the user views the list, **Then** each row stays within the available viewport width and the user does not need to scroll horizontally to inspect the document.
2. **Given** a document row is visible in the list, **When** the row is rendered, **Then** the document shows one human-readable status with one icon instead of multiple stacked status labels.
3. **Given** the system does not distinguish between queueing and processing internally, **When** the status is shown to the user, **Then** the user sees the closest human-readable status without duplicate or conflicting wording.

---

### User Story 2 - Remove Obsolete Documents (Priority: P2)

An authenticated dashboard user can remove a document they no longer want in the knowledge base by using a small delete control on the document row.

**Why this priority**: Removing stale or incorrect documents is a core management task, but users still receive value from the list improvements even before deletion is added.

**Independent Test**: Can be fully tested by deleting a document from the list, confirming the action requires explicit confirmation, confirming the document disappears from the current list, and confirming it is no longer present after reloading the page.

**Acceptance Scenarios**:

1. **Given** a document row is visible in the list, **When** the user activates the delete control and confirms the action, **Then** the document is removed from the user’s knowledge base and disappears from the list.
2. **Given** a user starts the delete flow for a document, **When** the user cancels the confirmation, **Then** the document remains unchanged in the list.
3. **Given** a delete attempt fails, **When** the failure is returned, **Then** the document remains visible and the user receives a clear failure state instead of a misleading success.

---

### User Story 3 - Open Citations Safely After Source Removal (Priority: P3)

An authenticated chat user can still interact safely with citation markers even if the cited document has been deleted since the answer was generated.

**Why this priority**: Citation reliability matters for trust, but graceful failure is a secondary extension of the document-deletion request rather than the main document-management workflow.

**Independent Test**: Can be fully tested by generating a cited chat answer, deleting the cited document, activating the citation, and confirming the user sees a clear unavailable-source outcome instead of a broken or misleading document view.

**Acceptance Scenarios**:

1. **Given** a chat answer contains a citation to a document that has since been deleted, **When** the user activates the citation, **Then** the interface shows a clear unavailable-source state instead of failing silently or opening a broken document view.
2. **Given** a cited document still exists, **When** the user activates the citation, **Then** the user is taken to the intended document as usual.
3. **Given** a citation cannot open because the source is unavailable, **When** the failure state is shown, **Then** the user can return to the existing chat context without losing the answer they were reading.

### Edge Cases

- If a document title contains very long words, URLs, or product names without spaces, the row should still remain within the viewport rather than forcing horizontal overflow.
- If the list contains a mix of ready, processing, and failed documents, the status treatment should remain visually consistent and should not show two different labels for the same row.
- If the last item on the current page is deleted, the list should recover cleanly without leaving the user on an empty or invalid page state.
- If a document is deleted while its edit or detail view is open elsewhere in the interface, the experience should recover to a safe state instead of leaving stale document content onscreen as if it still exists.
- If a delete request races with another update to the same document, the user should receive a clear result and the final visible list state should match persisted reality after refresh.
- If a chat citation points to a document that no longer exists, the user should see a clear unavailable-source message rather than a blank dialog, a dead route, or raw error data.

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

- **Boundary Rule**: Document list presentation owns row layout, iconography, confirmation affordances, and empty/error states; frontend document API adapters own document-fetch and document-delete requests; backend document routes own request validation and account scoping; document orchestration services own delete behavior and business rules; persistence repositories own document removal from storage.
- **Encapsulation Rule**: The document list view must remain the UI owner for list rendering and row actions; chat citation rendering must remain responsible for citation activation feedback instead of moving document-recovery behavior into global layout code; backend route handlers must remain transport-only and must not absorb deletion or citation fallback business logic.
- **New Seams Required**: Introduce or extend a focused document-deletion capability at the document service and repository seam, and a focused citation-unavailable presentation path that can show source-deleted failures without changing the chat answer content model.
- **Anti-Goals**: Do not add duplicate status fields to document rows. Do not hide overflow by truncating all long titles into unreadable labels. Do not implement soft delete, trash bins, or restore flows in this feature. Do not change citation generation or retrieval ranking behavior when the only issue is that a previously cited source was later removed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST render document rows within the available list viewport so users do not need horizontal scrolling to review the list during normal use.
- **FR-002**: The system MUST keep long document titles readable within the row layout instead of forcing content outside the viewport.
- **FR-003**: The system MUST show exactly one human-readable status per document row, paired with a single matching status icon.
- **FR-004**: The system MUST present user-facing document statuses using plain language that reflects the current document state without showing duplicate internal labels.
- **FR-005**: Users MUST be able to initiate document deletion directly from the document row using a dedicated delete control.
- **FR-006**: The system MUST require explicit confirmation before permanently deleting a document.
- **FR-007**: The system MUST remove a confirmed document from persistent storage for the authenticated account and exclude it from future document-list loads.
- **FR-008**: The system MUST ensure a user can delete only documents that belong to that user’s account.
- **FR-009**: The system MUST provide a clear failure state when a document deletion request does not succeed and MUST leave the document visible until deletion is confirmed by the system.
- **FR-010**: When a cited document has been deleted after a chat answer was generated, the system MUST show a graceful unavailable-source outcome when the citation is activated.
- **FR-011**: The system MUST preserve the existing chat answer context when a citation cannot open because its source document has been deleted.
- **FR-012**: The system MUST continue opening existing cited documents normally when the source is still available.

### UI Tasks

- Update the document-list row layout so long titles remain readable without horizontal page scrolling.
- Replace the current duplicate status treatment with one status label and one icon per document.
- Place a small delete control on the right side of each document row below the status treatment.
- Show a confirmation step before finalizing document deletion.
- Show a clear unavailable-source outcome when a citation points to a deleted document.

### Key Entities *(include if feature involves data)*

- **Document Row**: A single visible knowledge-base item in the documents list, including title, updated timestamp, status treatment, and row-level actions.
- **Document Lifecycle Status**: The user-facing expression of a document’s current readiness, such as queued, processing, ready, or failed, shown as one readable status with one icon.
- **Document Deletion Request**: A user-confirmed request to permanently remove one account-scoped document from the knowledge base.
- **Citation Availability State**: The outcome of trying to open a cited source, including whether the source is still available or has been deleted since the answer was produced.

## Assumptions & Dependencies

- Document deletion is a permanent removal rather than a reversible archive flow.
- Existing account authentication and authorization remain the mechanism used to scope document deletion.
- Removing a document also removes or invalidates its dependent retrieval data through existing storage ownership rules.
- Existing chat answers may still reference deleted document identifiers after deletion, so the citation experience must handle missing sources at open time.
- This feature reuses the current admin visual language rather than introducing a new document-management surface.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In acceptance testing on supported dashboard widths, users can review document rows without any horizontal page scrolling.
- **SC-002**: In acceptance testing, 100% of visible document rows display one status label and one status icon only.
- **SC-003**: In acceptance testing, 100% of confirmed document deletions remove the document from the current list and keep it absent after page reload.
- **SC-004**: In acceptance testing, canceled deletion flows leave the targeted document unchanged.
- **SC-005**: In acceptance testing, 100% of citation activations for deleted sources end in a clear unavailable-source state rather than a blank or broken document experience.
