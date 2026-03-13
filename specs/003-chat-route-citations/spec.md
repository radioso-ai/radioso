# Feature Specification: Chat Route Citations

**Feature Branch**: `003-chat-route-citations`  
**Created**: 2026-03-14  
**Status**: Draft  
**Input**: User description: "Chat frontend: inline citations with hover titles and document navigation, SSE response streaming, and URL-backed account/document routes"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read Answers With Inline Sources (Priority: P1)

An authenticated account user asks a question in chat and reads the assistant answer with inline citation markers directly in the answer text so the supporting sources are visible at the point of each claim.

**Why this priority**: Citation visibility is the core trust and usability improvement requested for the chat experience.

**Independent Test**: Can be fully tested by asking a question that returns cited content and confirming the answer renders inline markers, each marker reveals the cited document title on hover, and each marker opens the cited document when clicked.

**Acceptance Scenarios**:

1. **Given** a chat answer includes cited source references, **When** the answer is shown to the user, **Then** the answer displays inline citation markers such as `[1]` and `[2]` at the relevant parts of the answer instead of listing sources below the message bubble.
2. **Given** an answer contains one or more inline citation markers, **When** the user hovers a citation marker, **Then** the cited document title is displayed before the user clicks.
3. **Given** an answer contains one or more inline citation markers, **When** the user clicks a citation marker, **Then** the interface navigates to the documents area and opens the cited document for that same account.

---

### User Story 2 - Receive Streaming Answers (Priority: P2)

An authenticated account user submits a chat question and sees the answer appear progressively while the response is being generated, instead of waiting for the full answer to complete before any text is shown.

**Why this priority**: Streaming materially improves perceived responsiveness, but the user still has a usable chat flow without it.

**Independent Test**: Can be fully tested by submitting a question against a backend that supports streamed completion and confirming that partial answer text appears before the final response completes, then confirming the final answer state still includes citations and conversation continuity.

**Acceptance Scenarios**:

1. **Given** chat streaming is available for the request, **When** the user submits a question, **Then** assistant text begins appearing before the full answer is complete.
2. **Given** a streamed answer completes successfully, **When** the final stream event arrives, **Then** the completed answer remains visible, conversation continuity is preserved, and the final citations are attached to the completed answer.
3. **Given** streaming is unavailable or fails before completion, **When** the user submits a question, **Then** the chat experience still resolves to a completed answer or a clear failure state without leaving the interface stuck in a loading state.

---

### User Story 3 - Navigate By URL (Priority: P3)

An authenticated account user can see the current frontend location in the browser URL and return to the same screen or open document by refreshing or loading the route directly.

**Why this priority**: Route-backed navigation is necessary for deep links, citation-driven document navigation, and predictable browser behavior.

**Independent Test**: Can be fully tested by navigating between chat, documents, settings, token, and a specific document route, then refreshing each route and confirming the same screen reappears after authentication bootstrap.

**Acceptance Scenarios**:

1. **Given** an authenticated account user navigates between primary dashboard areas, **When** the view changes, **Then** the browser URL updates to the matching account-scoped route.
2. **Given** an authenticated account user opens a specific document, **When** the document is opened, **Then** the browser URL includes that document identifier in the account-scoped documents route.
3. **Given** the user reloads a valid account-scoped route after authentication bootstrap succeeds, **When** the page finishes loading, **Then** the same screen and targeted document state are restored.

### Edge Cases

- If a chat answer has no citations, the answer should render without empty citation markers or a blank sources area.
- If multiple inline markers point to the same document, each marker should still be clickable and should open that document reliably.
- If a citation references a document the user can no longer load, the click action should fail with a clear document-loading error state instead of leaving the user on a broken route.
- If the browser loads an account-scoped route for a different account than the authenticated user, the experience should redirect or recover to the authenticated account context without exposing another account's data.
- If streaming delivers text but the final completion metadata never arrives, the unfinished assistant message should not remain indefinitely in a pending state.
- If a user refreshes a deep link before account bootstrap completes, the interface should resume the intended route after bootstrap rather than dropping the user to an unrelated default screen.

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

- **Boundary Rule**: Account-scoped route handlers and route-level screens own navigation state; dashboard shell components own layout and visual framing; chat transport adapters own request and stream handling; document modules own listing, loading, and opening document records.
- **Encapsulation Rule**: The dashboard shell must remain a layout/navigation surface rather than absorbing chat citation parsing, streaming transport concerns, or document-loading logic. Chat presentation must remain responsible for rendering answer content, while document views remain responsible for loading and presenting document details.
- **New Seams Required**: Introduce a focused route-state seam for account-scoped dashboard navigation, a focused chat streaming client seam for streamed answer events, and a focused citation rendering seam that maps answer citations to navigable inline markers without coupling that logic to the sidebar or global layout.
- **Anti-Goals**: Do not keep primary dashboard navigation in local component state once URL-backed routes exist. Do not embed stream protocol parsing inside generic UI widgets. Do not move document-opening logic into chat transport code. Do not add account-crossing navigation shortcuts that bypass authenticated account scoping.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST render assistant citations inline within the visible answer content using ordered markers such as `[1]`, `[2]`, and higher numbers when multiple citations are present.
- **FR-002**: The system MUST assign citation marker numbers consistently within each assistant answer so the same visible marker always refers to the same cited document target during that message render.
- **FR-003**: Users MUST be able to discover the cited document title by hovering or focusing an inline citation marker.
- **FR-004**: Users MUST be able to activate an inline citation marker and be taken directly to the cited document within the authenticated account's documents experience.
- **FR-005**: The system MUST preserve the completed assistant answer and its citations after a citation is activated so users can return to the prior chat context through normal browser navigation.
- **FR-006**: The system MUST request streamed chat delivery when available and show assistant text progressively while the response is being produced.
- **FR-007**: The system MUST finalize a streamed answer into the same completed message state used for non-streamed answers, including conversation identity and citations.
- **FR-008**: The system MUST recover from unavailable or failed streaming without leaving the chat interface in an indeterminate loading state.
- **FR-009**: The system MUST expose account-scoped URLs for each primary frontend area, including chat, documents, settings, and API token management.
- **FR-010**: The system MUST expose an account-scoped URL for an opened document so a specific document can be refreshed or loaded directly.
- **FR-011**: The system MUST restore the route-targeted screen after page reload once authentication bootstrap confirms the current user session.
- **FR-012**: The system MUST prevent account-scoped document routes from opening document data belonging to another account.

### UI Tasks

- Show inline citation markers inside assistant message content instead of a source list below the bubble.
- Provide a hover or focus affordance that reveals the cited document title for each marker.
- Navigate to the documents experience when a citation is clicked and visibly open the targeted document.
- Display streamed assistant text progressively in the existing chat surface while a response is in progress.
- Reflect the active dashboard section in the browser URL, including a specific open-document URL.

### Key Entities *(include if feature involves data)*

- **Account-Scoped Route**: A browser location that identifies the authenticated account context and the currently selected dashboard destination, including optional document selection.
- **Assistant Message**: A chat response shown to the user, including visible answer text, conversation identity, completion state, and any associated citations.
- **Citation Reference**: A numbered inline source marker that points from a portion of an assistant answer to a specific document available to the same account.
- **Opened Document State**: The currently selected document in the documents experience, including whether it was reached from direct navigation or from a citation click.

## Assumptions & Dependencies

- The authenticated user identifier available in the frontend is the same account identifier used to scope dashboard routes.
- The chat service can return streamed answer events and final citation metadata for supported requests.
- The existing documents experience remains the place where a cited document is opened; this feature does not introduce a separate document-reading product area.
- Route restoration depends on successful authentication bootstrap and continued authorization to load the targeted document.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In user acceptance testing, 100% of cited assistant answers display inline numbered markers instead of a footer-style source list.
- **SC-002**: In user acceptance testing, 100% of inline citation markers reveal the cited document title on hover or keyboard focus.
- **SC-003**: In user acceptance testing, 100% of citation clicks from chat open the intended document in the authenticated account context without a manual document search step.
- **SC-004**: For streamed chat responses in a supported environment, users see the first visible assistant text before the full answer completes.
- **SC-005**: In route validation, refreshing any supported account-scoped dashboard URL returns the user to the same frontend destination after authentication bootstrap succeeds.
