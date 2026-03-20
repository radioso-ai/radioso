# Feature Specification: Anonymous Chat Access

**Feature Branch**: `020-anon-chat-access`
**Created**: 2026-03-20
**Status**: Draft
**Input**: User description: "Allow unauthenticated users to talk to the bot via a toggle in general settings with a shareable URL and cookie-based user distinction"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Admin Enables Anonymous Chat (Priority: P1)

An admin navigates to General Settings and toggles on "Anonymous Chat Access." Once enabled, the system generates a shareable public URL. The admin copies the URL and shares it with external users (e.g., customers, website visitors) who can immediately start chatting with the bot without creating an account.

**Why this priority**: This is the core enabling action — without the toggle and URL, no anonymous chat can happen.

**Independent Test**: Can be fully tested by toggling the setting on, verifying the URL appears, and confirming it can be copied. Delivers the admin-side setup of anonymous access.

**Acceptance Scenarios**:

1. **Given** the admin is on the General Settings page, **When** they toggle "Anonymous Chat Access" on, **Then** a shareable public chat URL is displayed and can be copied to clipboard.
2. **Given** anonymous chat is enabled, **When** the admin toggles it off, **Then** the public URL is deactivated and visiting it shows a "Chat unavailable" message.
3. **Given** anonymous chat is disabled (default), **When** a user visits the public chat URL, **Then** they see a message indicating chat is not available.

---

### User Story 2 - Anonymous User Chats via Public Link (Priority: P1)

An unauthenticated user opens the shared public chat URL in their browser. They land on a chat interface (no login required) and can immediately send messages and receive responses from the bot. The system assigns them a persistent identity via a browser cookie so their conversation history is preserved if they return later in the same browser.

**Why this priority**: This is the primary user-facing value — the anonymous user must be able to chat seamlessly.

**Independent Test**: Can be fully tested by opening the public URL in an incognito browser, sending messages, receiving bot responses, closing the tab, re-opening the URL, and verifying conversation history persists.

**Acceptance Scenarios**:

1. **Given** anonymous chat is enabled, **When** an unauthenticated user opens the public chat URL, **Then** they see a chat interface and can send messages without logging in.
2. **Given** an anonymous user is chatting, **When** they send a message, **Then** they receive a bot response using the workspace's configured knowledge base and settings.
3. **Given** an anonymous user has an active conversation, **When** they close the browser tab and reopen the same URL in the same browser, **Then** their previous conversation history is displayed.
4. **Given** an anonymous user opens the URL in a different browser or after clearing cookies, **When** they start chatting, **Then** a new conversation is created (they are treated as a new user).

---

### User Story 3 - Admin Monitors Anonymous Conversations (Priority: P2)

An admin can view a list of anonymous chat sessions in the admin panel to monitor usage, review conversations, and understand how external users interact with the bot.

**Why this priority**: Visibility into anonymous usage is important for trust and oversight, but the feature can function without it initially.

**Independent Test**: Can be tested by enabling anonymous chat, having several anonymous users chat, then verifying the admin can see a list of anonymous sessions with conversation previews.

**Acceptance Scenarios**:

1. **Given** anonymous chat is enabled and users have chatted, **When** the admin views the chat history section, **Then** anonymous conversations appear with labels like "Anonymous User #1" and timestamps.
2. **Given** an admin is viewing anonymous conversations, **When** they select one, **Then** they can read the full conversation thread.

---

### Edge Cases

- What happens when the anonymous user's cookie expires or is deleted? → They are treated as a new anonymous user with a fresh conversation.
- What happens if many anonymous users connect simultaneously? → The system handles concurrent anonymous sessions independently with no cross-contamination of conversations.
- What happens if the admin disables anonymous chat while users are mid-conversation? → Active conversations are allowed to complete, but no new messages can be sent after the current exchange. A notice informs the user that chat has been disabled.
- What happens if the workspace has no documents or knowledge base configured? → The bot still responds using its base capabilities, same as for authenticated users.
- What happens if the admin changes the rate limit while users are actively chatting? → The new limit takes effect immediately for subsequent messages. No in-flight messages are affected.

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

- **Boundary Rule**: The anonymous chat route is a new transport layer; it must not embed orchestration or domain logic. Chat orchestration and LLM calls reuse existing services.
- **Encapsulation Rule**: The existing chat route handler must remain authenticated-only; anonymous access uses a separate route/controller. General settings service owns the toggle state; the anonymous chat module reads it but does not manage it.
- **New Seams Required**: A new anonymous session service/module to manage cookie-based identity, anonymous session lifecycle, and mapping anonymous users to conversations. A new public chat route separate from the authenticated chat route.
- **Anti-Goals**: Do not add anonymous auth logic into the existing authenticated chat middleware. Do not store personally identifiable information for anonymous users. Do not allow anonymous users to access admin features or workspace settings. Do not duplicate chat UI components — the public chat page must reuse the same message list, input, streaming, and citation components as the authenticated chat.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a toggle in General Settings labeled "Anonymous Chat Access" that enables or disables public chat access for the workspace.
- **FR-002**: When anonymous chat is enabled, the system MUST generate and display a unique, shareable public URL for the workspace's anonymous chat.
- **FR-003**: The admin MUST be able to copy the public chat URL to their clipboard with a single click.
- **FR-004**: When an unauthenticated user visits the public chat URL, the system MUST render a chat interface that allows immediate messaging without login.
- **FR-005**: The system MUST assign a persistent browser cookie to each anonymous user to distinguish them across sessions in the same browser.
- **FR-006**: The system MUST preserve conversation history for anonymous users and restore it when they return with the same cookie.
- **FR-007**: Anonymous chat conversations MUST use the same workspace knowledge base, LLM settings, and system prompt as authenticated conversations.
- **FR-008**: When anonymous chat is disabled, visiting the public URL MUST show a user-friendly "Chat unavailable" message.
- **FR-009**: Anonymous conversations MUST be visible to admins in the chat history section, labeled to distinguish them from authenticated user conversations.
- **FR-010**: The system MUST handle concurrent anonymous sessions independently with no data leakage between users.
- **FR-011**: The system MUST enforce a configurable per-session rate limit on anonymous chat messages, expressed as a maximum number of messages per minute.
- **FR-012**: The admin MUST be able to set the anonymous chat rate limit in General Settings (default: 10 messages per minute).
- **FR-013**: When an anonymous user exceeds the rate limit, the system MUST reject the message with a user-friendly error and indicate how long to wait before retrying.

### UI Tasks

- Add a toggle switch for "Anonymous Chat Access" in the General Settings page.
- Display the generated public chat URL with a copy-to-clipboard button when the toggle is on.
- Add a "Rate Limit" number input (messages per minute) in the Anonymous Chat section of General Settings, visible when the toggle is on.
- Create a public-facing chat page (accessible without login) that reuses the existing chat components (message list, input box, message bubbles, streaming display, citations). The page differs only in layout (no sidebar/navigation) and context (anonymous session instead of authenticated user). No new chat UI components should be created.
- Display a "Chat unavailable" page when anonymous chat is disabled.
- Label anonymous conversations distinctly (e.g., "Anonymous User") in the admin chat history list.

### Key Entities

- **Anonymous Session**: Represents a distinct anonymous user's session. Linked to a browser cookie identifier. Associated with one or more conversations. Has no personal information — only a system-generated session ID and timestamps.
- **Workspace Setting (anonymous_chat_enabled)**: A boolean flag on the workspace indicating whether anonymous chat access is active. Controls URL generation and public route availability.
- **Workspace Setting (anonymous_rate_limit)**: An integer representing the maximum number of anonymous chat messages allowed per session per minute. Default: 10.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Admins can enable anonymous chat and obtain a shareable URL in under 30 seconds.
- **SC-002**: Anonymous users can send their first message within 5 seconds of opening the public URL (no login, no signup).
- **SC-003**: Returning anonymous users (same browser, same cookie) see their prior conversation history 100% of the time.
- **SC-004**: Anonymous conversations are fully visible to admins alongside authenticated conversations.
- **SC-005**: Disabling the toggle immediately prevents new anonymous conversations from starting.
- **SC-006**: Anonymous users who exceed the configured rate limit receive a clear error message and are blocked from sending until the window resets.

## Assumptions

- The workspace already has a General Settings page where the toggle can be added.
- The existing chat orchestration and LLM pipeline can be reused for anonymous users without modification.
- Cookie-based identification is sufficient for distinguishing anonymous users (no fingerprinting or IP tracking needed).
- Anonymous users do not need to set a display name — the system assigns an identifier automatically.
- The public chat URL uses a non-guessable token to prevent unauthorized enumeration of workspaces.
- Standard cookie expiration (e.g., 30 days) is acceptable for anonymous session persistence.
