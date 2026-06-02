# Feature Specification: Conversation Actions (async outbox dispatch)

**Feature Branch**: `070-conversation-actions`
**Created**: 2026-06-02
**Status**: Draft
**Input**: Follow-up to the routine runtime (#520, specs `069-conversation-routines`). Replaces the synchronous skill-dispatch step for routines with a generic **async action** path so a routine can *request* a side effect (send an email, call a webhook) without the chat turn blocking on it.

**Scope Note**: A routine collects information through **chat** steps and, when ready, emits an **ActionRequest** (`{ type, payload }`) instead of synchronously dispatching a skill. The host persists the request to a durable **outbox** transactionally with the turn, confirms to the user immediately ("received"), and a worker-driven **action dispatcher** later routes each request by `type` to a registered **ActionHandler** that performs the work (idempotently, with retries). The pure engine only *declares* the action intent; persistence, dispatch, and execution are host/worker concerns. This is the deferred/outbox shape the contract already gestures at (`SkillDispatchResult.deferred`) and that the EE human-contact flow already uses internally (record now, deliver in the background).

v1 is **fire-and-forget**: the routine does not wait for the action's result. Feeding an action result back into the conversation (the full deferred-resolution loop where a completion event re-enters the engine) is an explicit **anti-goal** for v1.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A Routine Requests A Side Effect Without Blocking (Priority: P1)

As a developer, I want a routine to reach an **action step** that records "do `contact.send` with this payload" and immediately confirm to the user, so the chat turn never blocks on an email/webhook and the side effect happens reliably afterward.

**Why this priority**: This is the capability — a routine that *does* something, without synchronous dispatch in the chat hot path.

**Independent Test**: Drive a routine to its action step; assert (a) an `ActionRequest` row is written with the declared `type` and the collected `payload`, (b) the turn's user-facing reply is the confirmation step (not a wait), and (c) no handler ran synchronously in the turn.

**Acceptance Scenarios**:

1. **Given** a routine at an action step, **When** the turn runs, **Then** an `ActionRequest` is persisted (status `pending`) in the same unit of work as the turn, and the routine advances to its confirmation/terminal step.
2. **Given** a persisted `ActionRequest`, **When** the dispatcher runs, **Then** it routes by `type` to the registered handler, which performs the work and marks the request `dispatched` (or `failed` after its retry budget).

---

### User Story 2 - Actions Are Generic And Registered, Not Hard-Coded (Priority: P1)

As an architect, I want action types to be a **registered extension** (`registerActionHandler(type, handler)`), with the routine *definition* declaring which action a step emits and the LLM only filling the **payload**, so new actions plug in without touching the engine or the dispatcher, and the model cannot dispatch an arbitrary action.

**Why this priority**: Generic + safe is the point — "chat writes what to dispatch" must not become arbitrary-action injection.

**Independent Test**: Register a throwaway handler for `test.echo`; a routine whose action step declares `type: "test.echo"` emits a request the dispatcher routes to it. A payload that names a different `type` does not change which handler runs (type is authored, payload is data).

**Acceptance Scenarios**:

1. **Given** a registered handler for a type, **When** a request of that type is dispatched, **Then** that handler runs; an unregistered type is recorded as a failed/parked request, never silently dropped.
2. **Given** a routine action step, **When** it emits, **Then** the `type` comes from the step definition and the `payload` from routine variables — the model never selects the `type`.

---

### Edge Cases

- **Crash after confirming**: the outbox write is transactional with the turn, so a request is never lost after the user was told "received".
- **Duplicate dispatch / retry**: the handler is idempotent (an idempotency key on the request); re-dispatch does not double-send.
- **Unregistered type**: recorded as `failed` (or `parked`) with a reason; surfaced, not dropped.
- **Handler throws / transient failure**: retried up to a budget, then `failed`; the conversation is unaffected (fire-and-forget).
- **No worker configured (local `noop`)**: requests are dispatched by the in-process poller, same as document jobs.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Backend Node.js/TypeScript; PostgreSQL. The outbox is a new table; dispatch reuses the existing worker dispatch driver (`noop` / `cloud-tasks` / `amqp`).
- TDD: the routine→outbox emit, the dispatcher routing/retry, and handler idempotency are test-first.
- Least privilege: an action handler runs with the workspace/account context carried on the request; a routine/handler the agent is not authorized for is not dispatched.
- Modular boundaries: the **pure engine only declares action intents** (it MUST NOT import DB/HTTP/worker). Persistence (outbox), the dispatcher, and handlers are host/worker code. Handlers own their own side-effect logic.
- Composition owns wiring: handlers are registered at composition (`registerActionHandler`), assembled under `backend/src/app/composition/`.
- Contract review (a worker payload): the outbox row + dispatch are a cross-service contract — review queue payloads/retry semantics and the worker docs.
- Docs: describe the action lifecycle (emit → outbox → dispatch → handler) and the registration surface.

## Architecture Constraints *(mandatory)*

- **Intent-vs-effect Rule (keystone)**: A routine **action step** emits an `ActionRequest` (`type` from the step definition, `payload` from variables) as part of the engine's turn result. The engine declares *what*; the host persists it and a worker executes it. The engine never performs or imports the side effect.
- **Transactional-outbox Rule**: The host MUST persist the `ActionRequest` in the same unit of work as the turn's message persistence, so an acknowledged request cannot be lost.
- **Registered-handler Rule**: Action execution is dispatched by `type` to a handler registered at composition. The `type` set is authored (definition + registry); the model fills only the payload. Adding an action is `registerActionHandler` + a routine that emits it — no engine/dispatcher change.
- **Idempotency Rule**: Every `ActionRequest` carries an idempotency key; handlers MUST be idempotent so retries/redelivery do not double-execute.
- **Fire-and-forget Rule (v1)**: The routine does not await the action result; it advances to its confirmation step on emit. Result-feedback into the conversation is out of scope for v1.
- **Reuse-the-worker Rule**: Dispatch reuses the existing job-dispatch abstraction (poller for `noop`, `cloud-tasks`/`amqp` otherwise) rather than a new transport.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Routine model gains an **action step** kind declaring an `actionType` (and an optional payload projection from variables). On landing, the runner emits the action intent in its result and auto-advances along the step's single edge (no wait).
- **FR-002**: The engine surfaces emitted action intents on the turn result without persisting them (engine purity); the host persists each as an `ActionRequest` (status `pending`) transactionally with the turn.
- **FR-003**: An `ActionRequest` has: id, `type`, `payload`, workspace/account/conversation context, idempotency key, status (`pending`/`dispatched`/`failed`), attempts, timestamps.
- **FR-004**: A worker-driven **dispatcher** consumes `pending` requests, routes by `type` to the registered handler, and marks `dispatched` on success or `failed` after the retry budget; an unregistered type is recorded as `failed` with a reason (never dropped).
- **FR-005**: Handlers are registered at composition via `registerActionHandler(type, handler)`; the handler receives the payload + request context and MUST be idempotent.
- **FR-006**: The `type` of an emitted action comes from the routine step definition; the LLM never selects it. Payload values come from routine variables.
- **FR-007**: Documentation MUST describe the action lifecycle and registration.

### Key Entities *(include if feature involves data)*

- **ActionRequest** — durable outbox row: `type`, `payload`, context, idempotency key, status, attempts. New table.
- **Routine action step** — a step kind that emits an `ActionRequest` and auto-advances. New (extends the routine graph).
- **ActionHandler** — `(payload, context) => Promise<void>`, registered by `type`. New extension surface.
- **Action dispatcher** — worker that drains the outbox and routes to handlers. New; reuses the job-dispatch driver.

## Data Model Direction

New table `routine_action_requests` (an outbox): `id`, `type`, `payload JSONB`, `workspace_id`, `account_id`, `conversation_id`, `idempotency_key` (unique), `status`, `attempts`, `last_error`, `created_at`, `updated_at`. Inserted in the turn's transaction; consumed by the dispatcher. **Decision**: a dedicated outbox table (not a session event) — explicit status/retry/idempotency, fits the existing job-queue worker pattern, and keeps work-dispatch out of the conversation event stream.

## API Direction

No new public REST endpoints; the assistant chat surfaces are unchanged. The dispatcher rides the existing worker runtime. Internal contract types (`ActionRequest`, the handler port, the routine action-step shape) are not public API but MUST be reviewed against the worker/queue payload contracts.

## Delivery Split

1. **Action step + intent on the turn result** (engine + contract) — _done_: the routine action-step kind; the runner emits intents; the result carries them. No persistence.
2. **Outbox + transactional emit** (host) — _done_: the `routine_action_requests` table + persisting emitted intents at turn completion (idempotent enqueue keyed on conversation+type+payload).
3. **Dispatcher + registry** (worker) — _done_: `registerActionHandler` on the application module surface, the `ActionHandlerRegistry` + `ActionDispatcher` that routes by type (unregistered → recorded failed, never dropped), and the `ActionDispatchWorker` poll loop wired into the worker runtime. The outbox repository backs both the enqueue (chat) and the drain (worker).
4. **First handler + routine** (host) — _done_: the live routine wiring (a `RoutineChatModelGateway` over the host chat gateway; per-turn runner assembled by composition; `routineStore` + `routineProvider` threaded through `ChatService` → the engine, guarded so a host with no routines registered pays nothing), plus the reference consumer — a chat-only `contactRoutine` that gathers email/message and emits `contact.send`, and a generic `ContactSendActionHandler`. Proven end-to-end: the routine emits the action through the real engine, and the handler dispatches it.
5. **Default enablement** (host) — _done_: `contactRoutineModule` (a built-in in the default composition) wires the feature so it works out of the box. An **intake advertiser** surfaces the existing public-chat "contact a human" button (gated on the advertised `human_contact.request` action) but never claims the turn (`handle` → null), so the turn falls through to the engine and the routine activates on the `intent_click`. The recipient is the **workspace owner** (`WorkspaceOwnerContactRecipientResolver`, falling back to an admin) — no extra config. EE coexistence: EE's human-contact intake runs pre-engine and claims the turn first, so the routine stays dormant in EE; the advertised action de-duplicates.
   - **Resolved decisions**: on by default (yes); recipient = workspace owner email (a host swaps it by registering its own handler); trigger = the existing public-chat contact button (no frontend change). **Known follow-up**: a routine-claimed turn still runs retrieval during session prep (a later optimization).

## Assumptions

- The routine runtime (#520) is merged; the live chat-only routine wiring lands alongside slice 4 here (the model-gateway adapter + per-turn assembly + `ChatService` threading).
- Fire-and-forget is sufficient for v1 (contact, notifications). Result-feedback is a later, separate loop.
- The existing worker dispatch infrastructure is sufficient; no new transport.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A routine action step emits a persisted `ActionRequest` (right type + payload) transactionally with the turn, and the user sees a confirmation, with **no** handler run synchronously in the turn (verified by the US1 test).
- **SC-002**: A new action plugs in with `registerActionHandler` + a routine that emits it, with **zero** engine or dispatcher changes (US2 test + diff inspection).
- **SC-003**: A re-dispatched request does not double-execute (idempotency test); an unregistered type is recorded `failed`, not dropped.
- **SC-004**: The model cannot change which action `type` runs by crafting payload text (the type is authored — adversarial test).
- **SC-005**: The pure engine declares action intents and imports no DB/worker/HTTP (boundary inspection).
- **SC-006**: Docs describe emit → outbox → dispatch → handler and the registration surface.
