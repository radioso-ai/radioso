# Feature Specification: Assistant Turn Loop As Skill-Dispatching Spine

**Feature Branch**: `066-assistant-turn-loop-spine`
**Created**: 2026-05-29
**Status**: Draft
**Input**: GitHub issue #465 — "Lift the assistant turn loop into a skill-dispatching spine (conversational agent platform)."

**Scope Note**: This spec covers one re-seam: making `assistantChatService` (via `ChatService`) a **turn loop that dispatches capabilities through the skills catalog**, with `retrieval.answer` dispatched as one registered skill rather than `RetrievalPipelineService` being a privileged constructor dependency of the chat path. It redefines the **skill-invocation port** so that it admits deferred/asynchronous results in its type and lets a skill emit interim events into the session while it works — even though every skill resolves synchronously today.

This spec does **not** build an async execution engine, a durable deferred-result store, a visual/DAG workflow builder, or any operator-authored orchestration graph. It does **not** remove the headless `retrieval.*` caller surfaces (SDK/MCP). It does **not** change billing. Those are explicit anti-goals. The deliverable is the **port shape + the loop + one registered retrieval skill + a worked design example** proving the async weave is expressible against the new port without implementing it.

**Predecessor dependency**: This work depends on retrieval first becoming a **skill with selectable execution strategies** (`fixed` | `reasoning`), with the strategy chooser owned by a retrieval executor/controller rather than a `pipelineMode` field on `retrieval_settings` (spec `065-agent-runtime-and-agentic-retrieval` and its follow-on). This spec lifts the spine *above* that re-seam and assumes `retrieval.answer` is already executable as a skill.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Add A Capability Without Touching Retrieval (Priority: P1)

As a developer extending the assistant, I want to add a new synchronous skill (for example, an order-status lookup for a support agent) by registering it in the skills catalog and registering its executor, so that the assistant can use it **without threading any new code through the retrieval module or the chat turn loop**.

**Why this priority**: This is the architectural reason the feature exists. Today retrieval is the de-facto orchestrator and the chat path depends on `RetrievalPipelineService` directly; every non-retrieval capability is an architectural fight. The proof the re-seam worked is that a new capability arrives as a registration, not as edits to retrieval or to the loop.

**Independent Test**: Add a throwaway test skill to the catalog with `execution.kind: internal` and register a stub executor for it. Submit an assistant turn whose message matches the skill's intent. Assert that (a) the turn dispatched that skill through the skills catalog, (b) no file under `backend/src/modules/retrieval/` was imported or modified to make it work, and (c) the skill's outcome is woven into the assistant's response.

**Acceptance Scenarios**:

1. **Given** a registered synchronous skill whose `supportedCallers` includes `assistant` and whose `requiredCapabilities` the agent holds, **When** an assistant turn matches that skill's intent, **Then** the turn loop dispatches the skill through the skills catalog and incorporates its outcome into the response, with the dispatch recorded in the turn's activity trace.
2. **Given** the same skill, **When** I inspect the wiring, **Then** the only places that reference the skill are its catalog entry and its executor registration in composition; the chat turn loop and the retrieval module contain no skill-specific branches.
3. **Given** an agent that lacks a skill's `requiredCapabilities`, **When** a turn would otherwise match that skill, **Then** the skill is reported as `forbidden` by the capability check and is not dispatched, and the agent responds without it.

---

### User Story 2 - Retrieval Is A Skill, Not A Privileged Pipeline (Priority: P1)

As a maintainer, I want `retrieval.answer` to be dispatched through the same skill-invocation port as every other skill, so that retrieval has no special standing in the chat path and the spine is genuinely capability-neutral.

**Why this priority**: Removing retrieval's privilege is the structural change that makes the spine a spine. If retrieval stays a direct dependency of `ChatService`, the catalog is decorative and the next capability still fights the substrate.

**Independent Test**: Inspect `ChatService`'s constructor and confirm it no longer takes `RetrievalPipelineService`. Run an existing grounded-answer conversation end to end and assert the produced answer, citations, and activity trace are behaviorally equivalent to before the re-seam (regression parity), with the trace now showing `retrieval.answer` dispatched as a skill.

**Acceptance Scenarios**:

1. **Given** a workspace with grounded answering enabled, **When** an assistant turn requires retrieval, **Then** the loop dispatches `retrieval.answer` as a registered skill and the resulting grounded answer and citations match the pre-re-seam behavior for the same query and corpus.
2. **Given** the chat module, **When** its dependency graph is inspected, **Then** the chat turn loop depends on the skills catalog and the skill-invocation port and does **not** import the retrieval module directly.
3. **Given** the headless retrieval surfaces (SDK/MCP `retrieval.*`), **When** a non-assistant caller invokes retrieval directly, **Then** it still works unchanged, because `retrieval.answer` declares `supportedCallers` that include both the assistant and the direct surfaces.

---

### User Story 3 - The Async Weave Is Expressible But Not Built (Priority: P1)

As an architect, I want the skill-invocation port to model "the agent dispatches an invocation and receives a result, possibly in a later turn" — including a skill emitting interim status into the conversation while it works — so that the order-status-while-talking use case is not foreclosed and never requires redesigning the boundary later.

**Why this priority**: This is the one shape that must not be foreclosed. If the port is typed `(input) => Promise<Answer>` the async weave is structurally impossible to add without a breaking boundary change. The cost of getting this wrong is paid much later and is far higher than the cost of getting the type right now.

**Independent Test**: A design artifact (`research.md` worked example, plus a compiling type-level fixture or skipped test) demonstrates an order-status skill that (a) emits an interim "checking your order…" status event into the session, and (b) returns a `deferred` disposition whose eventual result is modeled as a later session event — all against the real port type, with the executor stubbed so no async engine runs.

**Acceptance Scenarios**:

1. **Given** the skill-invocation port type, **When** a skill executor is written that returns a `deferred` disposition, **Then** it type-checks against the port without modification to the port, and the turn loop's handling of `deferred` is defined (it completes the current turn without blocking on the deferred result).
2. **Given** a skill executor with access to the turn's emit port, **When** it emits a status event mid-execution, **Then** that event is appended to the session event stream and is observable by the client before the skill settles.
3. **Given** that every shipped skill resolves synchronously today, **When** the test suite runs, **Then** no skill returns `deferred` at runtime and no async engine is exercised; the `deferred` path exists only in the type and in the worked example.

---

### Edge Cases

- What happens when a skill executor throws? The turn must still complete with a recorded failure outcome (`skillOutcomeStatus: failed`) and the agent must respond without crashing the session.
- What happens when no skill matches the turn? The loop must still produce a response (the agent's default conversational behavior), not error.
- What happens when more than one skill matches a turn? The loop must define ordering/selection and whether multiple skills can be dispatched in one turn (sequential dispatch is in scope; the port permits parallel dispatch but a single-skill-per-turn policy is acceptable for v1 as long as it is a loop policy, not a port limitation).
- What happens when a skill emits interim events but the turn is cancelled (new user input arrives, or shutdown)? Emission must stop cleanly and the cancellation must be recorded.
- What happens when a deferred skill's result would arrive after the conversation has moved on? Out of scope to resolve in v1 — but the port's event-shaped result must make "append the late result as a new event" the natural representation rather than an impossible one.
- What happens to `retrieval.answer` when the predecessor strategy chooser (`fixed` | `reasoning`) is mid-migration? The skill executor owns strategy selection; the loop must not know which strategy ran.
- What happens when a skill declares `execution.enqueue: true`? In v1 the loop may dispatch it synchronously regardless, but the port must not assume `enqueue: false`; the enqueue seam belongs to the executor/future async engine.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Backend MUST be implemented in Node.js and TypeScript.
- Database MUST be PostgreSQL with `pgvector`. This spec introduces no new storage system; it does not persist deferred results in v1.
- Backend development MUST follow TDD: tests written and failing before implementation, including a type-level/skipped fixture proving the `deferred` disposition compiles.
- Customer data MUST be protected with least-privilege access. Skill dispatch MUST honor the existing per-agent capability model (`requiredCapabilities`, `capabilityChecks`); a skill the agent is not authorized for MUST NOT be dispatched.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, persistence, and replaceable runtime adapters. The chat turn loop composes the skills catalog and the skill-invocation port and MUST NOT reach into retrieval internals.
- Application composition owns replaceable runtime wiring: executor registrations and the per-agent orchestration strategy MUST be assembled under `backend/src/app/composition/`, not inside domain modules.
- Runtime LLM prompt templates MUST live under `backend/prompts/`. Any prompt used to decide skill selection MUST live there; skill selection MUST NOT be encoded as English keyword lists or regexes in code (Radioso is multilingual — selection is an LLM-returned enum/structured decision or a settings-owned rule).
- User-facing assistant copy MUST come from the LLM. No hard-coded conversational responses, including for "I'm checking that for you" interim messages — interim status is a structured status event, and any human-readable rendering of it is produced through the existing LLM/canned path, not literal strings in orchestration code.
- Public/SDK/MCP/worker contract changes MUST include a message-queue impact review. The skill `execution` descriptor already carries `enqueue`; this spec MUST review whether redefining the skill-invocation port affects document-worker dispatch, AMQP payloads, or retry semantics, and MUST update queue docs/tests if so. v1 introduces no new enqueued payloads.
- Documentation MUST be updated to describe how skills are registered and dispatched and the assistant-as-spine model.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: The chat module owns the **turn loop / spine**: it gathers context, selects which skill(s) to dispatch, dispatches them through the skill-invocation port, and composes the response. It MUST NOT own retrieval strategy, any individual skill's business logic, LLM provider details, or skill execution mechanics. `retrieval.answer` business logic stays in the retrieval module behind its registered executor.
- **Encapsulation Rule**: The skills module owns the **skill-invocation port, the executor registry, and the catalog contract**. Concrete executors (including `retrieval.answer`'s) live in their owning domain modules and are registered into the registry at composition. The chat loop consumes skills only through the port and the catalog; it MUST NOT import concrete executors or the retrieval module.
- **Dependency Direction Rule**: `chat → skills (port + catalog)`. `retrieval → skills (contract, to register its executor)`. The chat module MUST NOT depend on the retrieval module; the current `RetrievalPipelineService` constructor dependency of `ChatService` MUST be removed. Modules with broad knowledge (chat orchestration) depend on modules with narrow knowledge (the port), never the reverse.
- **Port Shape Rule (the one that must not be foreclosed)**: The skill-invocation port MUST model dispatch as *the agent dispatches an invocation and receives a result, possibly in a later turn*, not pure call-return. Concretely the port MUST: (a) hand the executor a narrow **emit port** so it can append *structured* interim status/custom events to the session while it works — the emit port MUST NOT expose a raw user-facing message channel, because assistant copy is owned by the LLM/canned-rendering path in the turn loop, not authored in skill code; (b) return a **disposition** that is either `settled` (outcome available now) or `deferred` (the outcome will arrive as a later session event); and (c) carry the outcome as a **control envelope**, not a bare answer string. The port MUST NOT be typed `(input) => Promise<Answer>`.
- **Control Envelope Rule**: A skill outcome is a steering channel, not a payload. It MUST be able to express, at minimum: an outcome `status` (reuse `skillOutcomeStatus`, which already includes `awaiting_tool`, `paused`, `awaiting_confirmation`), the grounded answer/outputs when present, control bits (e.g. session-mode change for human handoff, result lifespan), transient guidance for the rest of the turn, and frontend-only metadata not seen by the model. The existing flat `{ answer, outputs }` `SkillExecutorResult` MUST be superseded by this envelope.
- **Orchestration-As-Capability Rule**: The decision of which skills to dispatch, in what order, and synchronously vs. deferred MUST be a **runtime, per-agent strategy resolved at composition**, not branches hard-coded in `ChatService` and not an operator-authored workflow graph. The loop holds the mechanism; the strategy is replaceable per agent (default strategy for all agents is acceptable for v1).
- **Source Of Truth Rule**: The session/conversation event stream is the system of record for a turn's observable output. A deferred result, if ever resolved, is represented as a new event appended to that stream — never as a mutation of the dispatching call's return value. v1 does not implement deferred resolution but MUST NOT adopt a representation that precludes it.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `assistantChatService`/`ChatService` MUST invoke capabilities by dispatching skills through the skills catalog and the skill-invocation port. The chat turn MUST be structured as a loop that gathers context, selects skill(s), dispatches them, and composes a response — not a fixed retrieve-then-answer sequence.
- **FR-002**: `retrieval.answer` MUST be dispatched as a registered skill through the same port as every other skill. `ChatService` MUST NOT take `RetrievalPipelineService` (or the retrieval module) as a dependency.
- **FR-003**: The grounded-answer behavior (answer text, citations, activity trace contents) for an existing conversation MUST be preserved through the re-seam (regression parity), with the trace additionally recording that retrieval ran as a dispatched skill.
- **FR-004**: The skill-invocation port MUST be redefined so a dispatch returns a **disposition** of either `settled` (outcome present) or `deferred` (outcome to arrive later as a session event). The `deferred` arm MUST exist in the type even though no shipped executor returns it in v1.
- **FR-005**: The skill-invocation port MUST provide each executor a **narrow emit port** capable of appending *structured* interim status and custom events to the session during execution. The emit port MUST be scoped to the current turn/session, MUST NOT expose the full session store, and MUST NOT expose a raw user-facing message channel — user-facing copy for any interim signal is rendered by the turn loop through the LLM/canned path, not authored by the executor.
- **FR-006**: A skill outcome MUST be a **control envelope** carrying at least: `status` (from `skillOutcomeStatus`), optional grounded answer and structured outputs, optional control bits (session-mode change for handoff, result lifespan), optional transient guidance, and optional model-invisible metadata. The prior flat `SkillExecutorResult` (`{ answer, outputs }`) MUST be removed or adapted into this envelope.
- **FR-007**: Adding a new synchronous skill whose `supportedCallers` includes `assistant` MUST require only (a) a catalog entry and (b) an executor registration in composition. It MUST require **no** changes to the retrieval module and **no** skill-specific branches in the chat turn loop.
- **FR-008**: Skill dispatch MUST enforce the per-agent capability model. A skill the agent is not authorized for (`requiredCapabilities` unmet) MUST be reported `forbidden` and MUST NOT be dispatched.
- **FR-009**: Which skill(s) a turn dispatches, their order, and sync-vs-deferred MUST be decided by a **per-agent orchestration strategy resolved at composition**. v1 MAY ship a single default strategy and a single-skill-per-turn policy, provided multi-skill and parallel dispatch are not precluded by the port type.
- **FR-010**: Skill selection MUST NOT be encoded as English keyword lists or regexes. Selection MUST be driven by the catalog's declared `intent`/`intake`, agent capabilities, and an LLM-returned structured decision or settings-owned rule. Any selection prompt MUST live under `backend/prompts/`.
- **FR-011**: A skill executor that throws or returns a failure MUST result in a recorded `failed` (or appropriate `skillOutcomeStatus`) outcome and MUST NOT crash the turn; the agent MUST still produce a response.
- **FR-012**: When no skill matches a turn, the loop MUST still produce the agent's default conversational response.
- **FR-013**: Turn cancellation (new input, shutdown) MUST stop interim emission cleanly and record the cancellation; partial emitted events remain in the session stream.
- **FR-014**: A worked design example MUST demonstrate the order-status-while-talking weave against the real port type: an executor that emits an interim status event and returns a `deferred` disposition, with the eventual result modeled as a later session event. This MUST compile/type-check; it MUST NOT exercise any async engine at runtime.
- **FR-015**: The activity/turn trace MUST record, per dispatched skill: skill name, the disposition (`settled`/`deferred`), the outcome `status`, and a result summary, with parity to the existing retrieval trace for the retrieval skill.
- **FR-016**: Headless `retrieval.*` caller surfaces (SDK/MCP) MUST continue to function unchanged; `retrieval.answer`'s `supportedCallers` MUST include both the assistant and the direct surfaces.
- **FR-017**: Public contract, SDK types, MCP contracts, worker payloads, and queue docs/tests MUST be reviewed for impact from the port redefinition and updated in the same change where affected. v1 introduces no new enqueued payloads.
- **FR-018**: Documentation MUST be updated to describe (a) how a skill is registered and dispatched, (b) the assistant-as-spine model, and (c) that the port admits deferred results while the async engine is out of scope.

### Key Entities *(include if feature involves data)*

- **Skill (catalog entry)** — existing declarative contract (`intake`/`intent`/`fields`/`outcomes`/`supportedCallers`/`execution`/`requiredCapabilities`). Unchanged by this spec except that `retrieval.answer` is exercised as a dispatched skill.
- **Skill Invocation** — the dispatch input: the resolved skill, collected intake values, turn/session context, the **emit port**, and a cancellation signal.
- **Skill Dispatch Result** — a disposition: `settled` (carries a Skill Outcome) or `deferred` (carries a reference/ticket whose resolution is a future session event). New type introduced by this spec.
- **Skill Outcome (control envelope)** — `status` (`skillOutcomeStatus`), optional answer/outputs, control bits (session-mode/handoff, lifespan), transient guidance, model-invisible metadata. Supersedes the flat `SkillExecutorResult`.
- **Skill Emit Port** — narrow interface to append *structured* interim status/custom events to the current session. Exposes no raw user-facing message channel; copy is rendered by the loop.
- **Orchestration Strategy (per-agent)** — resolved at composition; decides skill selection, ordering, and sync-vs-deferred for a turn. No persisted entity in v1.
- **Session event stream** — existing conversation/message store; the system of record for a turn's observable output and the natural home for a future deferred result as an appended event.

## Data Model Direction

This spec introduces **no new tables** and **no new persistence**. Deferred results are not stored in v1; the `deferred` disposition exists in the type and in the worked example only. The conversation/message event stream remains the source of truth for turn output. If a future spec implements deferred resolution, the late result is appended as a new message/event row keyed by conversation, not stored as a mutation of the dispatching turn — but that table is explicitly out of scope here.

The control-envelope outcome reuses the existing `skillOutcomeStatus` enum (`active`, `paused`, `awaiting_confirmation`, `awaiting_tool`, `completed`, `cancelled`, `expired`, `failed`) rather than introducing a parallel status vocabulary.

## API Direction

No new public REST endpoints. The assistant chat request/response and streaming surfaces (`assistantChatSchemas`, `AssistantChatStreamEvent`) are preserved; interim skill status surfaces through the existing chat stream event channel (`SkillStreamPayload`/`SkillStreamPhase` already exist). Internal type changes (the skill-invocation port, dispatch result, and outcome envelope) are not public API but MUST be reflected in any generated/exported skill contract types consumed by the SDK or MCP, and reviewed against the OpenAPI registry. The `retrieval.*` headless surfaces are unchanged.

## Delivery Split

Suggested slices, each independently shippable and behavior-preserving where possible:

1. **Port redefinition (types + shim)**: Replace `SkillExecutorPort.execute(): Promise<SkillExecutorResult>` with the dispatch/emit/disposition/envelope shape. Adapt the single existing executor path so all current skills resolve as `settled`. Add the type-level `deferred` fixture. No behavior change.
2. **Retrieval as registered skill**: Register `retrieval.answer`'s executor into the registry; route the chat path's retrieval call through dispatch; remove `RetrievalPipelineService` from `ChatService`. Assert grounded-answer parity.
3. **Loop + per-agent strategy**: Restructure the chat turn into the gather→select→dispatch→compose loop with a default per-agent orchestration strategy resolved at composition.
4. **Worked example + docs**: The order-status-while-talking design artifact against the port, plus skill-registration and assistant-as-spine docs.

## Assumptions

- The predecessor re-seam (retrieval as a skill with `fixed`/`reasoning` strategies, chooser owned by a retrieval executor/controller) lands first; this spec assumes `retrieval.answer` is dispatchable as a skill.
- A single default orchestration strategy and a single-skill-per-turn dispatch policy are acceptable for v1; multi-skill and parallel dispatch must remain expressible by the port but need not be implemented.
- The existing chat stream event channel is sufficient to carry interim skill status; no new transport is required for v1.
- No durable/cross-restart deferred-result handling is needed in v1.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new synchronous skill can be made available to the assistant by adding one catalog entry and one executor registration, with **zero** changes to files under `backend/src/modules/retrieval/` and **zero** skill-specific branches added to the chat turn loop (verified by diff inspection in the User Story 1 test).
- **SC-002**: `ChatService`'s constructor no longer references `RetrievalPipelineService` or the retrieval module, and the chat module's dependency graph shows no import of the retrieval module (verified by static check).
- **SC-003**: For a fixed set of existing grounded-answer conversations, post-re-seam answers and citations match pre-re-seam output (regression parity), with `retrieval.answer` shown as a dispatched skill in the trace.
- **SC-004**: A skill executor returning the `deferred` disposition type-checks against the port with no port modification, and a skill executor emitting an interim status event produces an event observable in the session stream before settlement (verified by the worked-example fixture/test).
- **SC-005**: The skill-invocation port contains no `(input) => Promise<Answer>`-shaped signature anywhere in its public type; the outcome is a control envelope and the result is a disposition.
- **SC-006**: Skill selection contains no English keyword lists or regexes; selection is driven by catalog metadata, capabilities, and an LLM-returned structured decision or settings rule (verified by review against the no-keyword-lists rule).
- **SC-007**: Docs describe skill registration/dispatch and the assistant-as-spine model, and explicitly state that deferred results are expressible but the async engine is out of scope.
