# Feature Specification: Chat Execution Classes

**Feature Branch**: `044-async-chat-jobs`  
**Created**: 2026-04-22  
**Status**: Draft  
**Input**: User description: "Define Radioso's chat execution model so normal chat remains synchronous and streaming, while future long-running chat-adjacent work has a clear deferred path instead of pressuring the product to queue every chat turn."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Keep Live Chat Immediate (Priority: P1)

As a chat user, I want normal conversations to start immediately and stream answers in the same request, so the assistant feels responsive instead of delayed behind a background queue.

**Why this priority**: Interactive latency is the core product experience. If normal chat is turned into a queued job, the assistant stops feeling like live software.

**Independent Test**: Can be fully tested by sending authenticated and public chat requests, confirming the server keeps the request open for streaming, and verifying the conversation persists without any queued-job handoff.

**Acceptance Scenarios**:

1. **Given** a user sends a normal chat message, **When** the platform accepts the request, **Then** retrieval, answer generation, and answer streaming happen in the live request path rather than being deferred to a background job.
2. **Given** a user starts a new authenticated, public, or embedded chat, **When** the first turn is created, **Then** any bootstrap greeting and first response follow the same interactive request path rather than a delayed job workflow.
3. **Given** the platform is under load, **When** a normal chat request cannot be served within defined interactive limits, **Then** the system fails with an explicit overload or timeout outcome instead of silently queueing the live turn.

---

### User Story 2 - Reserve Long Jobs For A Future Deferred Path (Priority: P1)

As a workspace operator or enterprise reviewer, I want long-running chat-adjacent work to be clearly identified as future deferred product scope rather than implied live-chat behavior, so expensive analysis or replay jobs can gain a credible enterprise path later without blocking live chat capacity now.

**Why this priority**: The product needs a credible enterprise story for background analysis, replay, and other non-interactive workloads without pretending that a deferred runtime already shipped in this feature.

**Independent Test**: Can be fully tested by classifying a set of long-running tasks, verifying they are documented as future deferred candidates rather than shipped background workflows, and confirming no current route silently behaves as if a deferred runtime exists.

**Acceptance Scenarios**:

1. **Given** the team reviews long-running assistant-adjacent workflows, **When** they classify them in the execution model, **Then** the model distinguishes current interactive behavior from future deferred candidates without implying a shipped background runtime.
2. **Given** an enterprise reviewer asks how heavy assistant workflows will evolve, **When** the team uses the approved docs and policy seam, **Then** the answer identifies a future deferred path without claiming those workflows already outlive the initiating request.
3. **Given** a current workflow such as eval replay still runs inline, **When** operators inspect the execution model, **Then** that workflow is described honestly as interactive today and only as a candidate for future deferred execution.

---

### User Story 3 - Give Operators A Predictable Service Model (Priority: P2)

As a workspace operator, I want a predictable service model for live chat and background assistant work, so I can set expectations correctly during rollout, troubleshooting, and enterprise review.

**Why this priority**: The real product value is predictability under load, not architectural vocabulary. Operators need to know what stays immediate, what can wait, and how the system behaves when capacity is constrained.

**Independent Test**: Can be fully tested by reviewing the execution model, mapping covered workflows to immediate or background behavior, and confirming the service response under overload or long-running work is consistent with those expectations.

**Acceptance Scenarios**:

1. **Given** the team reviews covered assistant workflows, **When** they inspect the execution model, **Then** each workflow is classified as either immediate live interaction or background work with no ambiguous middle state.
2. **Given** the platform is under interactive load pressure, **When** a normal chat request cannot be served within defined limits, **Then** the system responds according to the approved immediate-service contract rather than silently converting that request into background work.
3. **Given** a future feature proposes queueing normal chat turns, **When** the approved service model is applied, **Then** the proposal is recognized as out of scope unless it creates a clearly separate deferred user experience.

---

### User Story 4 - Document Immediate Versus Background Work (Priority: P2)

As a workspace operator or enterprise reviewer, I want clear documentation of which assistant actions are immediate versus background, so I can predict system behavior and explain it confidently to customers before rollout.

**Why this priority**: The execution model only creates value if humans can understand it. Ambiguity here creates support load, sales friction, and future scope drift.

**Independent Test**: Can be fully tested by reviewing the operator and architecture documentation, identifying the execution class for each covered workflow, and confirming the docs explain how background work differs from normal chat.

**Acceptance Scenarios**:

1. **Given** an operator reviews the documented execution model, **When** they look up a covered workflow, **Then** they can tell whether it is immediate live chat or background work without consulting engineers.
2. **Given** an enterprise reviewer asks how Radioso handles live chat versus heavy assistant jobs, **When** the team uses the approved documentation, **Then** the distinction is explained in customer-facing language rather than only implementation terms.
3. **Given** a future async chat-adjacent workflow is added, **When** it is documented, **Then** the docs explain how users start it, how they know it is background work, and how completion or failure is surfaced.

---

### Edge Cases

- What happens when a user disconnects mid-stream while the assistant is still generating a live response?
- What happens when an interactive chat turn exceeds the allowed latency budget but has already persisted the user message?
- What happens when a future async job needs retrieval and model access while the workspace settings change during execution?
- What happens when the same capability could be framed either as a live chat turn or as a background analysis request?
- What happens when an operator attempts to queue a workflow that still requires immediate token streaming or synchronous user confirmation?

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; runtime conversational copy MUST be generated by the LLM so multilingual behavior remains intact.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Chat HTTP routes own request validation, auth attachment, streaming transport, and overload responses for interactive turns. Chat orchestration owns session preparation, retrieval execution, answer generation, validation, and message persistence for interactive chat. Any future durable job orchestration for chat-adjacent work must remain separate from those live request seams. Persistence owns conversations, messages, audits, and any future async job records.
- **Encapsulation Rule**: `backend/src/app/http/routes/chatRoutes.ts` and `backend/src/app/http/routes/publicChatRoutes.ts` must remain transport-focused and must not absorb background job policy. `backend/src/modules/chat/services/chatService.ts` must remain the orchestration seam for live interactive chat and must not become the catch-all implementation for future batch workflows. Existing document worker modules must remain document-focused and must not become a generic chat task runner by accretion.
- **New Seams Required**: A focused execution-class policy seam that classifies workflows and documents future deferred candidates without forcing this feature to ship a dedicated async chat-job runtime.
- **Anti-Goals**: Do not put a broker or durable job queue in the critical path for normal chat turns. Do not silently downgrade overloaded interactive chat into eventual background work. Do not reuse document-processing worker modules for chat tasks without an explicit chat-job boundary. Do not blur interactive chat semantics with operator-triggered async analysis.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST define exactly two execution classes for chat-related work: interactive synchronous and durable async.
- **FR-002**: System MUST classify authenticated live chat, anonymous/public chat, embedded chat, and bootstrap greeting generation as interactive synchronous workflows.
- **FR-003**: Interactive synchronous chat MUST keep retrieval, answer generation, validation, conversation persistence, and answer delivery in the live request path.
- **FR-004**: Interactive synchronous chat MUST preserve token streaming behavior for supported live chat surfaces instead of routing normal turns through a delayed job queue.
- **FR-005**: When interactive chat cannot be served within defined interactive limits, the system MUST fail explicitly with a bounded overload, timeout, or cancellation outcome rather than implicitly queueing the turn.
- **FR-006**: System MUST identify a separate category of future async chat-adjacent work that may use a durable background job path in a later feature.
- **FR-007**: Future async chat-adjacent work MUST be limited to workflows whose value does not depend on immediate token streaming in the initiating request.
- **FR-008**: The execution model MUST name initial future async chat-adjacent candidates, including eval replay, exports, bulk analysis, notifications, and other operator-triggered long-running workflows, while treating normal chat turns as out of scope for background execution.
- **FR-009**: Future async chat-adjacent jobs MUST use durable job state that survives process restarts and allows operators to inspect queued, running, succeeded, and failed outcomes.
- **FR-010**: The execution model MUST preserve the requirement for independent capacity planning between interactive chat serving and any future background job execution so long-running async work does not require the live chat path to block on background completion.
- **FR-011**: The approved execution model MUST be documented clearly enough that product, engineering, and enterprise reviewers can map each major chat-related workflow to the correct execution class.
- **FR-011a**: Documentation for any future async chat-adjacent workflow MUST explain how the workflow is started, how a user or operator knows it is background work, and how completion or failure is surfaced.
- **FR-012**: The feature MUST include validation coverage that proves normal chat routes remain synchronous and that future async candidates are not misrepresented as shipped background workflows.
- **FR-013**: If this feature introduces or extracts backend runtime prompt assets for execution-class messaging or async job behavior, those prompt assets MUST live under `backend/prompts/`.
- **FR-014**: Any user-facing assistant or chat copy introduced by this feature MUST come from the LLM at runtime rather than hard-coded application strings because the system is multilingual.

### UI Tasks

- Add operator-facing documentation or settings guidance only if needed to explain which chat-related actions are immediate versus background.
- If a future async chat-adjacent workflow is exposed from the product UI, present it as a clearly separate action from the normal chat composer rather than silently changing how regular chat works.
- Keep authenticated chat, anonymous chat, and embedded chat experiences visually and behaviorally consistent with immediate live interaction.
- Ensure any operator-facing docs or UI guidance describe background work in plain language rather than only infrastructure terms such as queues, brokers, or worker runtimes.

### Key Entities *(include if feature involves data)*

- **Execution Class**: The approved classification for a chat-related workflow, indicating whether it is interactive synchronous or durable async.
- **Interactive Chat Turn**: A user-visible live conversation turn that performs retrieval, answer generation, validation, persistence, and delivery in the initiating request.
- **Async Chat Job**: A future durable background workflow for long-running chat-adjacent work whose value does not depend on immediate token streaming.
- **Execution Policy Decision**: The operator- and developer-facing rule that determines which workflows may run async and which must remain interactive.

## Assumptions

- Normal authenticated chat, anonymous/public chat, and embedded chat remain interactive product surfaces rather than operator-scheduled jobs.
- Enterprise buyers care more about explicit execution guarantees and workload separation than about forcing every live request through a broker.
- Existing durable async document-processing infrastructure can inform future async chat-job design, but this feature does not require reusing the same runtime.
- Any future async chat-adjacent workflow will expose a user or operator experience that clearly communicates delayed completion instead of pretending to be live chat.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In validation, 100% of covered normal chat flows continue to execute in the live request path without requiring background job creation.
- **SC-002**: In validation, 100% of covered interactive streaming flows can still begin answer delivery before any durable async handoff would have been required.
- **SC-003**: In validation, every covered long-running chat-adjacent workflow identified by the spec is classified unambiguously either as interactive today or as future deferred scope, with no mixed or implicit fallback mode.
- **SC-004**: Architecture and operator documentation allow a reviewer to identify the correct execution class for each covered workflow in one pass without relying on tribal knowledge or unstated assumptions.
- **SC-004a**: In validation, operators can explain the difference between immediate live chat and background assistant work for every covered workflow using the shipped documentation alone.
- **SC-005**: Future planning for async chat-adjacent jobs can proceed without reopening the question of whether normal live chat should be queue-backed.
