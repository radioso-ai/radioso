# Feature Specification: Chat History Debug Drawer

**Feature Branch**: `011-chat-history`  
**Created**: 2026-03-16  
**Status**: Draft  
**Input**: User description: "Add Chat History submenu with conversation debug drawer and remove inline chat debug"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Browse prior chats from History (Priority: P1)

An internal operator can open `Chat > History`, review the account's existing chat sessions, and select one to inspect without entering the live chat flow.

**Why this priority**: History discovery is the primary user value. Without a browsable list, there is no practical way to debug prior conversations.

**Independent Test**: Can be fully tested by navigating to the History entry, confirming prior conversations are listed for the current account, and opening one from the list.

**Acceptance Scenarios**:

1. **Given** an authenticated operator with existing conversations, **When** they open `Chat > History`, **Then** they see a list of account-scoped conversations ordered by most recent activity.
2. **Given** an authenticated operator with no prior conversations, **When** they open `Chat > History`, **Then** they see an empty state explaining that no chat history exists yet.
3. **Given** an operator viewing the history list, **When** new conversations exist for another account, **Then** those conversations are not shown in the current account's history list.

---

### User Story 2 - Inspect a conversation in a right-side drawer (Priority: P2)

An internal operator can click a conversation in history and inspect the full conversation transcript and debugging metadata in a right-side drawer while keeping the history list visible behind it.

**Why this priority**: The debugging drawer is the core inspection workflow and replaces the current inline debug pattern with a dedicated support-oriented surface.

**Independent Test**: Can be fully tested by opening a conversation from history and verifying the transcript plus metadata are visible in a right-side drawer that can be closed without leaving history.

**Acceptance Scenarios**:

1. **Given** a conversation in the history list, **When** the operator selects it, **Then** a right-side drawer opens and shows the conversation transcript in chronological order.
2. **Given** a conversation drawer is open, **When** the operator closes it, **Then** they return to the history list without losing their place in the list.
3. **Given** the selected conversation contains assistant turns with retrieval diagnostics, **When** the drawer loads, **Then** each assistant turn exposes its recorded debugging metadata in the drawer instead of the live chat surface.

---

### User Story 3 - Keep live chat clean while preserving debug visibility in history (Priority: P3)

An internal operator can continue using the live chat page without inline retrieval details, while still being able to inspect debugging information later through History.

**Why this priority**: This completes the UX separation between end-user style chat interaction and operator debugging, but depends on the history drawer existing first.

**Independent Test**: Can be fully tested by sending a live chat message, confirming the chat response no longer renders inline debug sections, and then opening the resulting conversation in History to view diagnostics there.

**Acceptance Scenarios**:

1. **Given** a live chat response with retrieval diagnostics, **When** the answer renders in the Chat page, **Then** the response content shows no inline debug/retrieval details.
2. **Given** that same conversation appears in History, **When** the operator opens it, **Then** the drawer shows the debugging metadata needed to inspect the assistant turn.

### Edge Cases

- If a conversation contains messages but no recorded debug metadata for one or more assistant turns, the drawer must show the transcript and a clear "debug metadata unavailable" state for those turns.
- If the selected conversation no longer exists or does not belong to the current account, the drawer must fail safely, close or reset the selection, and show a non-destructive error state.
- If a conversation is large, the drawer must remain navigable and preserve message ordering without truncating metadata silently.
- If a retrieval or answer generation attempt failed, the drawer must surface the failure state and any recorded diagnostic summary without implying the turn succeeded.

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

- **Boundary Rule**: Chat history transport must be served by dedicated history endpoints; history orchestration must assemble conversation summaries, transcript records, and recorded debug metadata; persistence must remain in repository modules; UI navigation, list rendering, and drawer rendering must be separated into focused frontend components.
- **Encapsulation Rule**: The live chat route and live chat view must remain focused on sending and rendering current-session messages only. The existing sidebar component must remain navigation-only and must not absorb history data loading or drawer state orchestration. Conversation and message repositories must remain persistence-focused and not take on presentation formatting.
- **New Seams Required**: A focused chat history read service, dedicated history API contract for list/detail retrieval, and a durable per-turn debug record seam that reliably associates assistant turns with their debugging metadata for later inspection.
- **Anti-Goals**: Do not continue rendering debug metadata inside the live chat transcript. Do not reconstruct history diagnostics with brittle client-side heuristics. Do not push history-loading logic into the generic sidebar. Do not expand the existing chat service into a mixed live-chat-plus-history god service without explicit read-side boundaries.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The dashboard navigation under `Chat` MUST expose a `History` entry that leads operators to a dedicated history view separate from the live chat composer experience.
- **FR-002**: The history view MUST list existing conversations for the active account and order them by most recent conversation activity.
- **FR-003**: Each history list item MUST expose enough summary information for quick identification, including conversation recency and a compact preview of the conversation contents.
- **FR-004**: Selecting a history list item MUST open a right-side drawer overlay rather than navigating away from the history view.
- **FR-005**: The drawer MUST display the selected conversation transcript in chronological order with clear user versus assistant turn separation.
- **FR-006**: The drawer MUST display conversation-level metadata including conversation ID, account ID, created time, last updated time, total message count, and total user/assistant turn counts.
- **FR-007**: For each assistant turn that has recorded debug data, the drawer MUST display debugging metadata required for support inspection, including parsed query details, candidate counts, applied constraints, rerank status, fallback status, citation count, and whether the answer was streamed.
- **FR-008**: For assistant turns where answer generation or retrieval failed, the drawer MUST display the recorded failure status instead of presenting the turn as a normal successful answer.
- **FR-009**: The system MUST persist or otherwise durably associate per-turn debug metadata with the corresponding historical conversation turn so the history drawer can render prior diagnostics without depending on transient in-memory chat state.
- **FR-010**: The history APIs and drawer data MUST remain account-scoped and MUST reject access to conversations outside the active account.
- **FR-011**: The live chat view MUST stop rendering inline retrieval/debug sections inside assistant messages.
- **FR-012**: The history view MUST provide explicit empty, loading, and error states for both the conversation list and the selected conversation drawer.

### UI Tasks

- Add a `History` submenu entry under `Chat`.
- Create a dedicated history screen that shows the existing chat sessions as a selectable list.
- Show a right-side slide-in drawer when a history item is selected.
- In the drawer, show transcript content and a clearly separated debug metadata section for assistant turns.
- Remove the inline debug/retrieval disclosure from the live chat screen.
- Provide empty, loading, and failure states that fit the existing dashboard visual language.

### Key Entities *(include if feature involves data)*

- **Conversation Summary**: A browsable history record for one conversation, including identity, recency, counts, and preview information used in the history list.
- **Conversation Detail**: A full historical conversation view containing ordered transcript turns plus conversation-level metadata shown in the drawer.
- **Conversation Turn Debug Record**: A durable record linked to an assistant turn that captures the debugging metadata required for later inspection, including retrieval diagnostics and answer outcome status.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Operators can open `Chat > History` and identify a target conversation from the list within 10 seconds for routine debugging cases.
- **SC-002**: Opening a conversation from history reveals the transcript and conversation metadata in a right-side drawer within 2 seconds for typical account history sizes.
- **SC-003**: 100% of assistant turns created after this feature ships expose either recorded debug metadata or an explicit unavailable/failure state when viewed through History.
- **SC-004**: The live chat page shows no inline retrieval/debug section for assistant responses after this feature is enabled.

## Assumptions

- The history experience is intended for internal/admin operators already using the authenticated dashboard.
- The first version is read-only and does not include rename, delete, export, search, or filtering controls.
- On smaller screens, the right-side drawer may use a full-width sheet pattern while preserving the same inspection workflow.
