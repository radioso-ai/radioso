# Feature Specification: Assistant-Retrieval Boundary

**Feature Branch**: `051-assistant-retrieval-boundary`
**Created**: 2026-04-26
**Status**: Draft
**Input**: User description: "Separate assistant and retrieval ownership so assistant owns chat, settings, and routing APIs while retrieval remains a standalone grounded search and answer capability. Human-facing channels like web chat and embed should integrate with assistant/chat, while MCP and headless RAG clients should keep using retrieval/search and retrieval/answer unless they explicitly opt into assistant chat."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Chat Through A Dedicated Assistant Surface (Priority: P1)

A product team can send human-facing conversations through one assistant chat surface, so web chat and embed share one assistant core without embedding retrieval policy in every channel.

**Why this priority**: This is the central architectural and product change. Without a dedicated assistant surface, the rest of the split remains conceptual rather than enforceable.

**Independent Test**: Can be fully tested by sending equivalent brand-new and follow-up chat requests through authenticated chat and public or embedded chat, then verifying that all of them use the same assistant API shape, preserve conversation history, and either answer directly or retrieve evidence as needed.

**Acceptance Scenarios**:

1. **Given** a user sends a normal chat message through a human-facing channel, **When** the request enters the backend, **Then** the channel forwards it through the assistant chat surface rather than directly into retrieval.
2. **Given** the latest user turn is social, identity-oriented, or otherwise does not require evidence, **When** the assistant interprets the turn, **Then** it may answer directly without invoking retrieval.
3. **Given** the latest user turn requires workspace evidence, **When** the assistant interprets the turn, **Then** it invokes retrieval as a downstream capability and returns a grounded response through the same assistant chat surface.
4. **Given** multiple supported human-facing chat surfaces point at the same workspace, **When** they send comparable turns, **Then** they receive consistent assistant-core behavior while preserving their own source metadata and session context.

---

### User Story 2 - Use Retrieval As A Standalone Grounded Capability (Priority: P1)

A developer or advanced customer can use retrieval search and retrieval answer directly without adopting the assistant product surface, so headless RAG integrations and MCP capability flows remain viable and do not inherit assistant persona or social behavior.

**Why this priority**: The split fails if retrieval-only users are forced through assistant orchestration. Standalone grounded search and grounded QA must remain first-class.

**Independent Test**: Can be fully tested by calling retrieval search and retrieval answer directly from a headless client or MCP-style capability client with and without optional conversation context, then verifying that grounded search, rewrite, evidence assembly, and citations still work without assistant-owned routing.

**Acceptance Scenarios**:

1. **Given** a client wants raw grounded search results, **When** it calls the retrieval search surface directly, **Then** it receives retrieval results and diagnostics without assistant-specific answer shaping.
2. **Given** a client wants a grounded answer without assistant persona or social handling, **When** it calls the retrieval answer surface directly, **Then** the system retrieves evidence, generates a grounded answer, and returns support diagnostics without using assistant identity or direct-answer chat behavior.
3. **Given** a client sends a follow-up grounded question such as "what about the advanced ones?", **When** it supplies optional conversation context to retrieval answer, **Then** retrieval may use that context for rewrite and evidence search without becoming the canonical owner of the conversation.
4. **Given** a retrieval-only client submits a social-only or assistant-identity-only input, **When** it calls retrieval answer, **Then** the system responds with a retrieval-scoped unsupported result rather than pretending to be the assistant product.
5. **Given** an MCP client needs grounded search, grounded answer generation, or document-oriented capability access, **When** it calls the retrieval and other platform surfaces directly, **Then** it does not need to route through assistant chat unless it explicitly wants assistant-style conversation behavior.

---

### User Story 3 - Configure Assistant And Retrieval Separately (Priority: P2)

A workspace operator can manage assistant behavior separately from retrieval behavior, so they can change identity, chat style, and channel-facing policies without accidentally changing search and grounding quality.

**Why this priority**: The architectural split only helps operators if it is visible and enforceable in settings and contracts.

**Independent Test**: Can be fully tested by changing assistant-facing settings and retrieval-facing settings independently, then verifying that each family affects only its own behavior and payloads.

**Acceptance Scenarios**:

1. **Given** an operator updates assistant identity or conversation behavior, **When** later assistant chats run, **Then** the assistant behavior changes without changing retrieval tuning payloads or retrieval-only answers.
2. **Given** an operator updates retrieval rewrite, ranking, or grounding behavior, **When** later retrieval-only and retrieval-backed assistant turns run, **Then** evidence gathering changes without mutating assistant identity or social behavior.
3. **Given** a workspace has never configured one or both settings families, **When** settings are read, **Then** assistant and retrieval settings both return safe defaults through separate settings surfaces.

---

### User Story 4 - Preserve Debuggability Across The Boundary (Priority: P2)

An engineer or operator can tell whether a response came from the assistant direct-answer path or a retrieval-backed path, so the new separation improves investigation instead of obscuring it.

**Why this priority**: A cleaner boundary is only useful if failures and misroutes remain observable.

**Independent Test**: Can be fully tested by exercising direct assistant replies, retrieval-backed assistant replies, and retrieval-only answers, then inspecting stored diagnostics and response metadata for the selected route and evidence usage.

**Acceptance Scenarios**:

1. **Given** an assistant chat response is answered directly, **When** diagnostics are inspected, **Then** they clearly show that the assistant route did not invoke retrieval.
2. **Given** an assistant chat response used retrieval, **When** diagnostics are inspected, **Then** they clearly show the retrieval-backed route and the associated evidence metadata.
3. **Given** a retrieval-only answer was requested directly, **When** diagnostics are inspected, **Then** they show a retrieval-scoped execution path rather than an assistant chat path.

---

### User Story 5 - Integrate Against Explicit Assistant And Retrieval Endpoints (Priority: P2)

A developer integrating Radioso can target clear assistant and retrieval endpoints directly, so the product contract is unambiguous and does not require inference from older mixed chat routes.

**Why this priority**: The architectural split is incomplete if the public contract remains implicit. Explicit endpoints are part of the product boundary.

**Independent Test**: Can be fully tested by reading the generated API contract, calling each documented endpoint with valid requests, and verifying that the returned behavior matches the endpoint family it belongs to.

**Acceptance Scenarios**:

1. **Given** a developer wants human-facing chat behavior, **When** they read the API contract, **Then** they can identify a dedicated assistant chat endpoint and the shared platform history and settings endpoints used alongside it.
2. **Given** a developer wants grounded retrieval capabilities or MCP-style capability access without assistant behavior, **When** they read the API contract, **Then** they can identify dedicated retrieval search and retrieval answer endpoints plus the shared platform settings endpoint.
3. **Given** a developer is choosing between assistant and retrieval surfaces, **When** they compare the documented endpoints, **Then** the difference in ownership and behavior is explicit enough to choose the correct family without reading backend code.

### Edge Cases

- What happens when a human-facing channel resumes an existing conversation after the assistant/retrieval split ships? The conversation must remain readable and continue through the assistant chat surface without losing prior history.
- What happens when retrieval answer receives conversational context hints that are partial, stale, or malformed? Retrieval must fail safely or ignore the bad hints without corrupting grounded search behavior.
- What happens when assistant settings are missing but retrieval settings are present, or vice versa? Each surface must remain usable with its own defaults instead of requiring the other settings family to exist first.
- What happens when a surface such as web chat, embed, or MCP needs source metadata for audit or policy purposes? The source metadata must remain attached to the request without forcing retrieval to own channel semantics.
- What happens when MCP needs conversational assistant behavior for one tool but direct retrieval capability for another? The platform must allow MCP to opt into assistant chat selectively rather than treating all MCP traffic as assistant-owned chat.
- What happens when the assistant decides retrieval is required but retrieval fails or returns no support? The assistant must fail honestly through the retrieval-backed path without silently switching to unsupported freeform behavior.

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
- Backend HTTP contract changes MUST update the code-first OpenAPI source and regenerated outputs in the same delivery.
- Any operator-facing settings, API docs, or user-visible behavior changed by this feature MUST update the corresponding documentation in the same delivery.
- Backend runtime LLM prompt assets introduced, moved, or revised by this feature MUST live under `backend/prompts/`.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Human-facing chat transport owns HTTP and surface adaptation only; the assistant module owns conversation context, route selection, assistant settings consumption, and final customer-facing response composition for assistant-backed chat; the retrieval module owns grounded search, rewrite, evidence assembly, and retrieval-only answer generation for evidence-backed answers; MCP and similar capability-oriented platform surfaces sit parallel to assistant and may call retrieval and other platform capabilities directly; persistence continues to own stored conversations, messages, workspace settings, and diagnostics.
- **Encapsulation Rule**: `backend/src/app/http/routes/chatRoutes.ts` and `backend/src/app/http/routes/publicChatRoutes.ts` must remain transport-only adapters and must not continue to own assistant-routing policy. `backend/src/modules/chat/services/chatService.ts` must not remain the long-term home for both assistant policy and retrieval orchestration. `backend/src/modules/retrieval/services/*` must not remain the owner of assistant identity, social reply behavior, or other assistant-only prompt shaping. Supported human-facing chat surfaces such as web chat and embed must not call retrieval directly for chat behavior. MCP and other capability-oriented surfaces must not be forced through assistant chat by default.
- **New Seams Required**: A focused assistant domain or module that owns assistant chat APIs, assistant settings, route selection, assistant-owned prompts, and conversation-context handling; a narrow assistant-to-retrieval port for evidence requests; separate assistant and retrieval settings contracts; retrieval-facing API seams for standalone search and grounded answer flows; and a clear platform boundary for MCP or similar capability surfaces that may use retrieval directly while optionally exposing assistant chat as a separate capability.
- **Anti-Goals**: Do not reframe the assistant as a generic multi-tool agent platform in this feature. Do not implement the assistant as just another connector plugin with webhook-oriented lifecycle semantics. Do not include external messaging connector support in this feature. Do not force retrieval-only customers or MCP capability clients to adopt assistant APIs for grounded search or grounded QA. Do not let retrieval-only APIs inherit assistant persona, greeting, or social behavior. Do not allow assistant freeform direct-answer behavior to bypass grounding policy when the selected route requires evidence.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a dedicated assistant chat surface for human-facing conversational requests, separate from retrieval-only search and retrieval-only answer surfaces.
- **FR-002**: Human-facing chat surfaces including authenticated chat and public or embedded chat MUST route their customer-facing chat requests through the assistant chat surface rather than directly through retrieval surfaces.
- **FR-003**: The assistant chat surface MUST own the decision about whether the latest conversational input can be answered directly or requires retrieval-backed evidence.
- **FR-004**: When the assistant decides a conversational input does not require evidence, the system MUST allow a direct assistant response without invoking retrieval.
- **FR-005**: When the assistant decides evidence is required, the system MUST invoke retrieval as a downstream capability and return the result through the same assistant chat surface.
- **FR-006**: The system MUST provide a standalone retrieval search surface that returns evidence-oriented results without requiring assistant-owned persona, social handling, or conversation-mode behavior.
- **FR-007**: The system MUST provide a standalone retrieval answer surface that performs rewrite, grounded search, and grounded answer generation without requiring use of the assistant chat surface.
- **FR-008**: Retrieval search and retrieval answer MUST remain usable for customers building headless RAG experiences and for MCP-style capability clients that do not want assistant-owned identity, chat routing, or social behavior.
- **FR-009**: Retrieval answer MUST accept optional caller-supplied conversation context hints that retrieval may use for rewrite continuity and evidence search, without making retrieval the canonical owner of conversation state.
- **FR-010**: Assistant-owned conversational context MUST remain the canonical source of conversation meaning for assistant chat flows, even when a downstream retrieval request includes a derived subset of that context.
- **FR-011**: MCP and similar capability-oriented platform surfaces MUST be able to consume retrieval and other platform capabilities directly without being required to route through assistant chat.
- **FR-012**: If MCP or another capability-oriented surface exposes conversational assistant behavior, that assistant behavior MUST be an explicit opt-in surface rather than the default contract for all capability calls.
- **FR-013**: The system MUST expose workspace settings through a shared platform settings surface rather than separate assistant-only and retrieval-only settings routes.
- **FR-014**: The shared settings contract MUST contain a distinct assistant section so assistant identity and other assistant-facing chat behavior can be managed without changing retrieval tuning.
- **FR-015**: The shared settings contract MUST contain a distinct retrieval section so rewrite, ranking, grounding, and retrieval-only answer behavior can be managed without absorbing assistant-only behavior.
- **FR-016**: The shared settings contract MUST allow assistant and retrieval sections to be read and updated independently within one platform settings payload.
- **FR-017**: Updating one settings section through the shared settings surface MUST NOT implicitly clear, overwrite, or reset the other settings section unless the caller explicitly includes that change.
- **FR-018**: Existing grounded trust behavior such as citations and typed unsupported outcomes MUST continue to apply on evidence-backed routes and MUST NOT be silently bypassed by the new architectural split.
- **FR-019**: Retrieval-only answer flows MUST return a typed retrieval-scoped unsupported result with a stable outcome code when a request falls outside retrieval scope, such as social-only or assistant-identity-only turns, rather than impersonating the assistant product surface.
- **FR-020**: The system MUST preserve enough response and stored metadata to identify whether a result came from an assistant direct-answer route, an assistant retrieval-backed route, a retrieval-only route, or an MCP or similar capability route that did not invoke assistant chat.
- **FR-021**: The system MUST expose a human-facing chat endpoint at `POST /api/v1/assistant/chat`.
- **FR-022**: The system MUST expose conversation-history endpoints at `GET /api/v1/history` and `GET /api/v1/history/:conversationId`.
- **FR-023**: In this feature, the shared history endpoints MUST expose assistant conversation history only; retrieval-only requests MUST NOT create or require separate history resources.
- **FR-024**: The system MUST expose shared settings endpoints at `GET /api/v1/settings` and `PUT /api/v1/settings`.
- **FR-025**: The system MUST expose a retrieval search endpoint at `POST /api/v1/retrieval/search`.
- **FR-026**: The system MUST expose a retrieval grounded-answer endpoint at `POST /api/v1/retrieval/answer`.
- **FR-027**: The shared settings response and write contract MUST support assistant and retrieval sections within one platform settings payload.
- **FR-028**: The assistant chat endpoint request contract MUST support conversation continuation, new-conversation chat, optional streaming, optional user-expected locale, optional input metadata, and source-channel context for human-facing channels.
- **FR-029**: The retrieval answer endpoint request contract MUST support the grounded query, optional caller-supplied conversation context for rewrite continuity, optional retrieval filters, and retrieval-scoped grounded answer output.
- **FR-030**: The retrieval search endpoint request contract MUST support grounded query input, optional retrieval filters, and evidence-oriented result output without assistant-facing answer composition.
- **FR-031**: The feature MUST include automated backend coverage for assistant direct-answer routing, assistant retrieval-backed routing, retrieval-only answer behavior, typed retrieval unsupported outcomes, retrieval-only conversation-context rewrite continuity, MCP or similar capability access that bypasses assistant chat by default, shared-settings merge behavior, and the documented endpoint contracts.
- **FR-032**: Any backend runtime prompt assets introduced, extracted, or moved to support assistant-owned behavior MUST be stored under `backend/prompts/`.

### Endpoint Contract

- **Assistant Chat**: `POST /api/v1/assistant/chat`
  Purpose: Human-facing conversational entry point for authenticated chat and public or embedded chat.
- **History List**: `GET /api/v1/history`
  Purpose: List platform conversation history for the active caller or session scope. In this feature, that history contains assistant conversations only while preserving assistant-owned conversation semantics behind the route.
- **History Detail**: `GET /api/v1/history/:conversationId`
  Purpose: Return one platform conversation with message history and related response metadata. In this feature, that conversation is an assistant conversation while preserving assistant-owned conversation semantics behind the route.
- **Settings Read**: `GET /api/v1/settings`
  Purpose: Return a shared workspace settings payload with distinct assistant and retrieval sections.
- **Settings Write**: `PUT /api/v1/settings`
  Purpose: Update shared workspace settings through one platform surface while preserving separate assistant and retrieval ownership inside the payload and without implicitly resetting untouched sections.
- **Retrieval Search**: `POST /api/v1/retrieval/search`
  Purpose: Return evidence-oriented grounded search results without assistant persona or social behavior.
- **Retrieval Answer**: `POST /api/v1/retrieval/answer`
  Purpose: Return a grounded answer built from retrieval rewrite and evidence search without assistant-owned direct-answer routing. Requests outside retrieval scope return a typed retrieval-scoped unsupported result.
- **MCP And Similar Capability Surfaces**
  Purpose: Operate parallel to assistant chat, using retrieval and other platform capabilities directly by default while exposing assistant chat only when explicitly desired.
### UI Tasks

- Introduce a shared platform settings surface with distinct assistant and retrieval sections so operators can tell which controls affect human-facing assistant behavior versus grounded retrieval behavior.
- Explain in plain language which channels use the assistant chat surface and which integrations, including MCP-style capability clients, may continue to use retrieval search or retrieval answer directly.
- Preserve or improve operator-facing debug surfaces so route selection and evidence usage remain understandable after the split.
- Keep user-facing API and settings language free of internal jargon such as "bootstrap" or "turn routing".
- Do not introduce new operator-facing controls for external messaging connectors in this feature.

### Key Entities *(include if feature involves data)*

- **Assistant Chat Request**: A human-facing conversational request that includes current input, conversation identity, source-channel context, and any assistant-owned behavior hints needed to produce the final response.
- **Assistant Route Decision**: The assistant-owned control-flow result that determines whether the current conversational input should be answered directly or through a retrieval-backed path.
- **Retrieval Search Request**: A retrieval-scoped request for evidence lookup and ranking that does not imply use of the assistant product surface.
- **Retrieval Answer Request**: A retrieval-scoped request for grounded answer generation that may include optional conversation-context hints for rewrite continuity without transferring ownership of the conversation.
- **Retrieval Unsupported Result**: A typed retrieval-scoped outcome returned by retrieval answer when the request is outside retrieval scope, allowing clients to handle unsupported conversational inputs predictably.
- **Platform Settings**: Workspace-scoped settings resource that contains separate assistant and retrieval sections under one shared contract.
- **Assistant Settings Section**: The part of platform settings that shapes assistant identity and other assistant-facing chat behavior independently from retrieval tuning.
- **Retrieval Settings Section**: The part of platform settings that shapes rewrite, ranking, and grounded-answer behavior independently from assistant identity and social behavior.
- **Route Diagnostics**: Stored or returned metadata that identifies whether a response used the assistant direct path, the assistant retrieval-backed path, or the retrieval-only path.

## Assumptions

- The first delivery may keep assistant and retrieval inside the same deployed backend process as long as the code boundaries and API ownership become explicit.
- Existing document, search, and settings persistence can be reused where the ownership split is logical; the goal is boundary clarity, not a forced data-model rewrite.
- Existing channel integrations should keep their user-visible behavior unless a change is required to enforce the new ownership model.
- External messaging connectors are intentionally out of scope for this feature so the assistant and retrieval boundary can ship without channel-specific delivery concerns.
- Retrieval rewrite remains a retrieval concern even when the request originated from assistant-owned conversational context.
- MCP remains a parallel capability-oriented platform surface and is not required to use assistant chat unless a specific conversational MCP tool opts into it.
- History remains a shared platform resource at the route level even though assistant owns the meaning and progression of conversational state behind it.
- Older mixed chat naming can be removed or replaced outright because no production compatibility requirement exists yet.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In validation, all covered human-facing chat channels enter the backend through one assistant-owned chat contract rather than through retrieval-owned surfaces.
- **SC-002**: In validation, retrieval-only customers can obtain grounded search results and grounded answers, including rewrite-assisted follow-up handling, without calling the assistant chat surface.
- **SC-003**: In validation, assistant settings changes do not alter retrieval-only answer behavior, and retrieval settings changes do not alter assistant identity or direct-answer behavior except through downstream evidence quality.
- **SC-004**: In validation, operators and engineers can identify the selected route for 100% of covered responses generated after the feature ships.
- **SC-005**: In validation, the generated API contract clearly exposes the assistant and retrieval endpoints and allows an integrator to choose the correct family without relying on older mixed chat routes.
