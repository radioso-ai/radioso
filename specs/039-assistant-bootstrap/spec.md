# Feature Specification: Assistant Bootstrap

**Feature Branch**: `039-assistant-bootstrap`  
**Created**: 2026-04-15  
**Status**: Draft  
**Input**: User description: "Add workspace persona bootstrap with request-scoped userExpectedLocale for first-turn greeting and future popup locale support"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Configure Assistant Identity (Priority: P1)

A workspace operator can define the assistant's stable identity before any chat starts, so new conversations feel intentional instead of generic.

**Why this priority**: Without a configured identity, the assistant still feels blank at the moment of first contact. This is the core product value.

**Independent Test**: Can be fully tested by opening General Settings, saving assistant identity fields, reloading the page, and confirming the same values return for the same workspace.

**Acceptance Scenarios**:

1. **Given** a workspace with no assistant bootstrap configured, **When** the operator opens General Settings, **Then** they can add assistant identity details and save them for that workspace only.
2. **Given** a workspace with assistant bootstrap configured, **When** the operator reloads General Settings later, **Then** the saved identity values appear unchanged.
3. **Given** multiple workspaces under one account, **When** the operator updates assistant bootstrap in one workspace, **Then** the other workspaces keep their own independent values.

---

### User Story 2 - Start New Chats With the Right Greeting and Language (Priority: P1)

An end user opening a fresh chat receives a first assistant turn that matches the workspace identity and uses the expected locale for that chat session.

**Why this priority**: The first turn is the highest-leverage trust moment. It must reflect both what the assistant is and which language this user expects right now.

**Independent Test**: Can be fully tested by configuring assistant bootstrap, starting a fresh authenticated chat and a fresh public chat with `userExpectedLocale`, and verifying the first assistant turn is present, scoped to new conversations only, and uses the requested locale.

**Acceptance Scenarios**:

1. **Given** a workspace with proactive greeting enabled and assistant bootstrap configured, **When** a user opens a brand-new chat session, **Then** the system creates a first assistant message before any user message is sent.
2. **Given** a fresh chat request includes `userExpectedLocale` such as `it-IT`, **When** the first assistant turn is generated, **Then** the greeting is produced in that locale instead of relying on a workspace default.
3. **Given** proactive greeting is disabled or assistant bootstrap is empty, **When** a user opens a fresh chat, **Then** the conversation starts silently with no assistant message.
4. **Given** a conversation already exists, **When** the user returns to that conversation, **Then** the system does not insert another bootstrap greeting.

---

### User Story 3 - Preserve Future Embed and Popup Flexibility (Priority: P2)

A product team can embed the assistant in contexts such as website popups, where the user-selected language may change per visitor, without reworking workspace identity settings later.

**Why this priority**: The feature should solve today's dashboard experience without closing off the upcoming website/embed use case.

**Independent Test**: Can be fully tested by issuing two fresh-chat requests for the same workspace with different locale hints and verifying each new conversation greets in the requested locale while preserving the same assistant identity.

**Acceptance Scenarios**:

1. **Given** the same workspace identity is reused across channels, **When** one new chat starts with `userExpectedLocale: "en"` and another starts with `userExpectedLocale: "it-IT"`, **Then** each conversation uses the same persona but greets in the locale requested for that conversation.
2. **Given** no request-level locale is supplied, **When** a new chat starts, **Then** the system falls back to the workspace default locale if one is configured, otherwise it behaves safely without requiring a fixed workspace language.
3. **Given** a request provides an invalid or unsupported locale hint, **When** a new chat starts, **Then** the system ignores the bad hint, falls back safely, and still creates a usable greeting when proactive greeting is enabled.

### Edge Cases

- What happens when the operator saves assistant bootstrap with proactive greeting enabled but leaves all identity fields blank? The system treats bootstrap as inactive and starts chats silently.
- What happens when a user opens a fresh chat while documents are still processing or no documents are ready? The greeting may introduce the assistant, but it must not imply document-backed knowledge is already available.
- What happens when a locale hint is malformed, oversized, or not recognized? The system rejects or normalizes the value safely and falls back without exposing raw prompt text or breaking chat startup.
- What happens when the first-turn generation fails because the model or provider is unavailable? The system must fail quietly and allow the user to start the conversation manually.
- What happens when public or embedded chat opens multiple fresh sessions for the same workspace in different locales? Each new conversation uses the locale for its own request without mutating workspace identity settings.

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
- Public contract changes to settings or chat startup MUST update the code-first OpenAPI source and generated outputs.
- User-visible settings behavior and startup semantics MUST update relevant documentation in the same feature.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Settings routes own HTTP validation and response transport only; settings services own workspace bootstrap orchestration; chat startup orchestration owns first-turn creation; repositories own persistence; chat and public-chat routes remain transport-only entry points.
- **Encapsulation Rule**: Retrieval settings modules must remain retrieval-only. `settingsRoutes.ts` must not absorb greeting-generation logic. `chatRoutes.ts` and `publicChatRoutes.ts` must not build persona prompts inline. Frontend settings screens must present and save the configuration but must not own fallback rules.
- **New Seams Required**: A focused workspace assistant-bootstrap settings seam, plus a focused chat-start/bootstrap orchestration seam that can generate or suppress the first assistant turn using request-scoped locale input.
- **Anti-Goals**: Do not store session language as permanent workspace identity. Do not turn this into a full prompt editor. Do not require a fake user message just to trigger a greeting. Do not mix retrieval tuning with assistant identity settings.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST let workspace operators configure workspace-scoped assistant bootstrap settings in General Settings rather than Retrieval Settings.
- **FR-002**: Assistant bootstrap settings MUST support stable assistant identity fields covering assistant name, assistant role or purpose, optional greeting style or opener guidance, and a proactive greeting toggle.
- **FR-003**: System MUST support an optional workspace default locale as a fallback only; it MUST NOT require locale to be the primary source of truth for every chat.
- **FR-004**: System MUST accept an optional request-scoped locale hint named `userExpectedLocale` when a new chat session starts.
- **FR-005**: When `userExpectedLocale` is present and valid, the system MUST prefer it over any workspace default locale for the first assistant turn in that conversation.
- **FR-006**: The system MUST keep workspace persona stable across channels while allowing different new conversations to use different locale hints.
- **FR-007**: When proactive greeting is enabled and assistant bootstrap is meaningfully configured, the system MUST create a first assistant turn for brand-new conversations in authenticated chat.
- **FR-008**: Public chat flows MUST support the same assistant bootstrap behavior and the same request-scoped locale hint behavior as authenticated chat.
- **FR-009**: The system MUST suppress bootstrap greeting creation for existing conversations and only apply it to brand-new conversations.
- **FR-010**: If assistant bootstrap is absent, blank, or proactively disabled, the system MUST start conversations silently.
- **FR-011**: The first assistant turn MUST reflect the configured assistant identity without claiming access to information that has not yet been retrieved or processed.
- **FR-012**: Invalid locale hints MUST be validated or normalized safely and MUST fall back without breaking chat startup.
- **FR-013**: The system MUST preserve usable chat startup when first-turn generation fails, including letting the user continue with a manual first message.
- **FR-014**: Settings responses and saves MUST round-trip assistant bootstrap values for the active workspace only.
- **FR-015**: Chat startup audit and diagnostics behavior MUST remain clear enough to explain whether a bootstrap greeting was generated, skipped, or failed.

### UI Tasks

- Add an "Assistant Identity" section to General Settings with compact, opinionated fields for assistant name, role or purpose, optional greeting style guidance, default locale fallback, and proactive greeting.
- Explain in plain language that workspace identity is stable, while the active chat locale can be overridden per request or channel.
- Show clear empty-state guidance so operators understand that leaving assistant bootstrap blank results in silent chat start.
- Keep the authenticated chat and public chat empty states consistent with whether proactive greeting is enabled or suppressed.

### Key Entities *(include if feature involves data)*

- **Assistant Bootstrap Settings**: Workspace-scoped operator configuration representing stable assistant identity, greeting enablement, and fallback locale.
- **Chat Start Request**: A new-conversation request carrying optional request-scoped context such as `userExpectedLocale` that influences the first turn for that conversation only.
- **Bootstrap Greeting Result**: The outcome of chat startup for a new conversation, including whether a first assistant turn was generated, skipped, or failed safely.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In validation, operators can configure assistant bootstrap settings for one workspace and reload them without cross-workspace leakage.
- **SC-002**: In validation, 100% of covered new-conversation startup scenarios use the request locale when `userExpectedLocale` is provided, even when the same workspace is used concurrently in a different locale.
- **SC-003**: In validation, 100% of covered existing-conversation scenarios avoid inserting duplicate bootstrap greetings.
- **SC-004**: In validation, chat startup remains usable when locale hints are invalid or greeting generation fails, with no blocked user path to manual messaging.
- **SC-005**: In validation, authenticated chat and public chat both honor the same workspace persona while allowing different request-level locale hints for different new conversations.

## Assumptions

- Public chat is part of the near-term embed/popup path, so the same locale-aware bootstrap capability should apply there in the first release.
- The first release keeps assistant bootstrap compact and opinionated instead of exposing arbitrary long-form system prompt editing.
- If no request-level locale is supplied, a workspace default locale may be used as fallback, but future channels remain free to override it per conversation.
