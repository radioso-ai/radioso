# Feature Specification: Conversation Routines (Stateful Journeys)

**Feature Branch**: `069-conversation-routines`
**Created**: 2026-06-01
**Status**: Approved (implementation in progress; slice 4 soak-gated)
**Input**: #482 entanglement #4 (intake is a parallel mini-engine), #520 (intake unification → Routine runtime). See `research.md` for the model and rationale.

**Scope Note**: This spec adds **Routines** — the stateful, multi-step conversational flows the platform vocabulary already names ("Directives first, Routines second": Directives steer, Routines run multi-step flows). A Routine is an authored graph of **steps** connected by conditional **transitions**; the conversation engine activates a Routine, persists the session's position in it, advances it one step per turn via an LLM next-step selector, **projects the current step into a Directive** so it steers the reply through the existing steering set, and dispatches **skills** at tool steps. The EE human-contact flow — today a ~640-line hand-rolled intake state machine running *outside* the engine — is the **pilot**: it is transplanted onto the Routine runtime in the terminal slice, after which the parallel `registerChatIntakeProvider` path and the pre-engine intake loop in `ChatService` are retired.

This spec keeps the engine **pure and product-independent**: the Routine runtime lives in the conversation engine/contract packages and reaches behavior only through existing ports (Directives for steering, skills for actions). It does **not** build a routine-authoring UI, backtracking, multi-routine-per-turn, or any change to the headless `retrieval.*`/SDK/MCP surfaces. Those are anti-goals.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run An Authored Routine Across Turns (Priority: P1)

As a developer, I want to register a Routine (a graph of steps + transitions) and have the engine activate it, walk the user through it over multiple turns, fill its variables, dispatch a skill at a tool step, and complete it — without any flow-specific branch in the engine.

**Why this priority**: This is the core capability. Without it there is no runtime; everything else is migration.

**Independent Test**: Register a throwaway two-step routine (`ask_value` → `act` tool step) whose activation trigger matches a test intent. Drive three turns. Assert (a) turn 1 activates the routine and the reply reflects step 1's action, (b) turn 2 fills the variable and the engine advances, (c) the tool step dispatches the registered skill with the collected variable, (d) the routine completes and clears its session state, and (e) no engine file branches on the routine's identity.

**Acceptance Scenarios**:

1. **Given** a registered routine whose trigger matches, **When** a turn runs, **Then** the engine marks the routine active, persists position at the first step, and the current step is projected into the steering set the composer reads.
2. **Given** an active routine at a CHAT step, **When** the user supplies the requested value, **Then** the next-step selector advances along the satisfied transition and persists the new position + the captured routine variable.
3. **Given** an active routine at a skill (tool) step, **When** the step runs, **Then** the engine dispatches the named skill with routine variables as input and advances deterministically on success.

---

### User Story 2 - Resume Mid-Routine On A Later Turn (Priority: P1)

As a user, when I'm partway through a multi-step flow, I want the next turn to continue from where I left off rather than restarting or being re-classified from scratch.

**Why this priority**: Multi-turn statefulness is the whole point of a journey; resume is what distinguishes a Routine from a one-shot skill.

**Independent Test**: Activate a routine on turn 1 (reach step 2 of 3). On turn 2, assert the engine loads the persisted routine position and continues from step 2 — it does **not** re-run activation/selection from the root, and the reply reflects step 2, not step 1.

**Acceptance Scenarios**:

1. **Given** a session with a non-terminal routine position, **When** the next turn begins, **Then** the engine resumes that routine before normal skill selection (a pending routine claims the turn).
2. **Given** a resumed routine, **When** the user's input does not satisfy the current step's transition, **Then** the step is re-asked (or paused) without losing already-captured variables.

---

### User Story 3 - Transplant The Contact Flow And Retire The Parallel Intake Path (Priority: P1)

As a maintainer, I want the EE human-contact flow re-expressed as a Routine, so the bespoke `humanContactIntakeProvider` and the engine-bypassing intake path in `ChatService` are removed and the flow runs through the one turn spine.

**Why this priority**: This is the #482/#520 payoff — eliminating the last non-engine turn path — and the proof the runtime fits a real journey.

**Independent Test**: With the contact Routine registered, reproduce the existing human-contact conversations (pill-click start, NL start, collect email, collect message, submit, confirm; plus the embedded-value pause). Assert behavior parity (prompts, the submitted contact-request row, idempotency, the receipt/confirmation) and that `registerChatIntakeProvider` and the `ChatService` pre-engine intake loop are gone.

**Acceptance Scenarios**:

1. **Given** a no-context-refusal turn with contact configured, **When** the user clicks the contact **pill** (`inputMetadata.method === "intent_click"`), **Then** the contact Routine activates and collects email → message → submits, identical to today's outcome.
2. **Given** the same flow started by natural language, **When** the user expresses contact intent, **Then** the routine's NL trigger activates it.
3. **Given** the transplant is complete, **When** the code is inspected, **Then** no chat intake provider drives the flow and `ChatService` has no pre-engine intake branch.

---

### Edge Cases

- **Off-script mid-routine**: user asks an unrelated question while a routine is active → the routine may pause/yield for that turn (answered normally) and resume, or be abandoned per policy; v1 policy is explicit and tested, not incidental.
- **Routine expiry**: an in-flight routine past its timeout (the contact flow's 15-min window becomes a routine-level TTL) is cleared; a later turn starts fresh.
- **Skill (tool) step fails**: the failing dispatch transitions along the failure edge (e.g. contact `submit` failed → a failure step), recorded distinguishably in the trace; the turn still produces a response.
- **No routine active and none triggered**: normal turn — the engine selects a terminal skill as today; routines add a stage, they don't replace selection.
- **Idempotent side effects**: a tool step's side effect (contact submit) must not double-fire on resume/retry; idempotency stays with the skill that owns the side effect.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved **and** the #516 engine-default cutover has soaked.
- Backend MUST be Node.js/TypeScript; PostgreSQL + `pgvector`. Routine *position + variables* are durable session-scoped state (new persistence) — see Data Model Direction.
- Backend development MUST follow TDD: the runtime's activation/resume/progression and the contact-transplant parity are test-first; contact parity tests pass before and after the transplant.
- Customer data MUST be least-privilege: a routine and its skill steps MUST honor the per-agent capability model; routine variables holding user data (email, message) follow existing data handling.
- Modular boundaries MUST hold: the **Routine runtime lives in the conversation engine/contract packages** and reaches behavior only through existing ports (Directives, skills). The pure engine MUST NOT import retrieval, EE, HTTP, or product modules. The EE contact Routine is **registered** by the EE module, not built into the engine.
- Composition owns replaceable wiring: routine definitions are registered at composition (like the skill catalog); the runtime is assembled under `backend/src/app/composition/`.
- Runtime prompts live under `backend/prompts/`. Next-step selection MUST be an LLM-returned **structured** decision (which transition condition is satisfied) or a settings rule — **never** an English keyword list/regex. Routines are multilingual.
- User-facing copy stays LLM/canned-owned: a step's `action` is an instruction that steers generation, not hard-coded conversational text.
- Contract review: routine state is new persisted session state — review worker/AMQP payloads and queue docs for any cross-service impact (expected: none; chat-internal).
- Documentation MUST describe Routines, activation, resume, projection-into-Directives, and skill steps (extending `docs/architecture/assistant-turn-spine.md`).

## Architecture Constraints *(mandatory)*

- **Routine-As-Graph Rule**: A Routine is an acyclic graph of **steps** (an `action` instruction + optional **skill** ref + metadata) and **transitions** (a source/target + an LLM-evaluated `condition`), with a root entry and terminal step(s). The engine holds the graph mechanism; a routine's domain meaning lives in its definition, not in engine branches.
- **Projection-Into-Directives Rule (the keystone)**: The current step MUST steer the turn by **projecting into a Directive** that joins the existing steering set the composer reads — not via a parallel steering channel. Routines reuse directive matching + steering merge.
- **Runtime-Owned-State Rule**: The engine owns the routine **position (node path)** and **variables** (captured slots), persisted per session and resumed across turns. **Skill (tool) steps are stateless dispatches**; only a side effect's idempotency/persistence (e.g. the contact submit row) stays skill-owned. This supersedes the contact flow's bespoke `skill_intake_states`.
- **Activation Rule**: A routine activates when a **trigger** matches — an explicit intent signal (`inputMetadata.method === "intent_click"` for the routine's skill) or a matched **Directive/intent condition** (the NL case) — or when the session already holds a non-terminal position for it (resume). No separate trigger engine; activation rides the directive/intent matcher.
- **Resume-First Rule**: When a session holds a non-terminal routine position, the engine resumes that routine **before** normal terminal-skill selection; a pending routine claims the turn.
- **Progression Rule**: Advancement is an LLM **next-step selector** evaluating the current step's outgoing transition conditions against the conversation (structured output: the satisfied condition + whether the step completed + captured variable). A skill step with a single success edge advances deterministically after the skill returns.
- **Dependency-Direction Rule**: `engine → contract`; routine definitions and skill executors are registered *into* the engine by product/EE composition. The engine MUST NOT import retrieval, EE, or HTTP. The contact Routine + its submit skill live in the EE module.
- **Parity Rule**: The contact transplant MUST reproduce today's human-contact behavior (prompts, pause-on-embedded-value, submitted row, idempotency, receipt) — migration, not redesign, of observable behavior.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The contract MUST define a Routine graph — `Routine` (id, triggers, root, steps), `RoutineStep` (action, optional skill ref, metadata, kind: chat/skill/terminal), `RoutineTransition` (source, target, condition) — in `@radioso/conversation-contract`, with the runtime in `@radioso/conversation-engine`.
- **FR-002**: The engine MUST persist, per session, the **active routine + node path + captured variables**, and load/resume it on the next turn from that state.
- **FR-003**: The engine MUST resume a non-terminal routine **before** normal terminal-skill selection (resume-first), passing the new user input to the next-step selector.
- **FR-004**: The engine MUST activate a routine when a trigger matches (explicit `intent_click` for the routine's skill, or a matched Directive/intent condition), and MUST NOT activate when none match (normal turn).
- **FR-005**: The current routine step MUST be **projected into a Directive** merged into the steering set the composer reads; routines MUST NOT introduce a parallel steering path.
- **FR-006**: The engine MUST advance a routine via an LLM next-step selector returning a **structured** decision (satisfied transition condition, step-completed, captured variable); no English keyword/regex selection. Any selection prompt lives under `backend/prompts/`.
- **FR-007**: A **skill (tool) step** MUST dispatch the named skill through the existing skill-executor port with routine variables as input, advance deterministically on its single success edge, and follow a failure edge on error (recorded distinguishably in the trace).
- **FR-008**: A completed/terminal routine MUST clear its session state; an expired (TTL) in-flight routine MUST be cleared and not resumed.
- **FR-009**: The contact flow MUST be re-expressed as a registered Routine (EE module); on completion, `registerChatIntakeProvider`, `ChainedChatIntakeProvider`, and the `ChatService` pre-engine intake loop MUST be removed (or reduced to a thin no-op), with contact behavior parity verified.
- **FR-010**: Selection and dispatch within a routine MUST honor the per-agent capability model; a routine/skill the agent is not authorized for is not activated/dispatched.
- **FR-011**: Documentation MUST describe Routines (graph, activation, resume, projection-into-Directives, skill steps) in `docs/architecture/assistant-turn-spine.md`.

### Key Entities *(include if feature involves data)*

- **Routine** — an authored graph: triggers, root, steps, transitions. Registered at composition. New.
- **Routine Step** — an `action` instruction (projected to a Directive) + optional **skill** ref + kind (chat/skill/terminal). New.
- **Routine Transition** — source→target + LLM-evaluated `condition`. New.
- **Routine State (session-scoped)** — active routine id, node path, captured **variables**, expiry. **New persisted state**; supersedes `skill_intake_states`. Keyed by conversation/session (+ routine id).
- **Next-Step Selector** — LLM port returning the satisfied transition + captured variable for the current step. New (one prompt).
- **Directive / SkillOutcome / SteeringRule** — existing (067/068); the projection target and the action mechanism, unchanged in shape.

## Data Model Direction

Unlike 068 (no new persistence), Routines require durable **session-scoped routine state**: the active routine, its node path, and captured variables, with an expiry. This generalizes the EE `skill_intake_states` table — preferred direction is a single generic routine-state store keyed by `(conversation_id, routine_id)` owned by the engine's session/store port, with the EE table retired on transplant. Routine *definitions* are code/registration, not data. The conversation/message event stream remains the record of observable turn output.

## API Direction

No new public REST endpoints; assistant chat request/response and streaming are preserved. The pill/`start_intent` action and `inputMetadata` already exist and are reused for activation. Internal contract types (Routine graph, routine-state store port, next-step selector port) are not public API but MUST be reflected in exported chat/skill contract types and reviewed against the OpenAPI/skill-contract registries. Headless `retrieval.*`/SDK/MCP surfaces are unchanged. No routine-authoring API in v1.

## Delivery Split

Each slice independently shippable; the parallel intake path survives until slice 4.

1. **Pause/resume substrate.** Routine-state store (session-scoped position + variables) + the resume-first stage in the engine. Additive, behavior-neutral (nothing registers a routine yet). Proven by a throwaway routine (US1/US2 tests).
2. **Declarative routine model + projection.** The `Routine`/step/transition contract types, activation via triggers, and step→Directive projection. The current step steers the turn through the existing steering set.
3. **LLM progression + skill steps.** The next-step selector prompt (structured transition selection + variable capture) and skill (tool) step dispatch with deterministic post-skill advancement.
4. **Transplant the contact flow + retire intake.** Re-express the human-contact flow as a registered EE Routine; verify parity; remove `registerChatIntakeProvider`/`ChainedChatIntakeProvider` and the `ChatService` pre-engine intake loop; retire `skill_intake_states`.

## Assumptions

- 066–068 (retrieval-as-skill, directives + steering set, capability-neutral spine) and #512/#516 (engine-native streaming; engine is the default/sole turn path) are merged and soaked.
- One active routine per session and no backtracking are acceptable for v1 (the contact pilot needs neither); both must remain expressible by the model, not necessarily implemented.
- The existing chat stream channel, activity trace, and `inputMetadata`/`start_intent` plumbing are sufficient; no new transport.
- Per-turn step-sourced traces are sufficient (a continuous routine trace depends on #517's trace-ownership cleanup and is a later enhancement).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A code-registered routine can be activated, advanced across ≥3 turns (including a skill step), and completed, with **zero** routine-identity branches in the engine (verified by the US1 test + diff inspection).
- **SC-002**: A session mid-routine resumes from the persisted position on the next turn rather than re-activating from the root (US2 test).
- **SC-003**: The human-contact flow runs as a Routine with behavior parity (prompts, pause, submitted row, idempotency, receipt), and `registerChatIntakeProvider` + the `ChatService` pre-engine intake loop are removed (US3 test + diff inspection).
- **SC-004**: The current routine step reaches the composer **only** through a projected Directive in the steering set; no parallel routine-steering path exists (verified by inspection).
- **SC-005**: Routine progression contains no English keyword lists/regexes; next-step selection is an LLM structured decision or a settings rule (verified against the no-keyword-lists rule).
- **SC-006**: Routine state (position + variables) is persisted/cleared correctly across activate → advance → complete/expire (focused tests), and `skill_intake_states` is retired.
- **SC-007**: Docs describe the Routine runtime (graph, activation, resume, projection-into-Directives, skill steps).
