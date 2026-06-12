# Feature Specification: Routines as Data (User-Authored Flows)

**Feature Branch**: `082-routines-as-data`
**Created**: 2026-06-09
**Status**: Approved (2026-06-09; implementation sequenced after PR #664 merges)
**Input**: Issue radioso-ai/radioso#665. Design one-pager: `.context/routines-as-data-design.md`. Builds on 069 (conversation-routines runtime) and 079 (agent-settings-as-data: data-of-record pattern). **Depends on PR #664** (routine×directive co-composition + directive scope tags) merging. See those specs and the "Dependencies & Verified Substrate" section for what is and isn't already built.

**Scope Note**: 069 made Routines a runtime — a graph of steps + transitions the engine activates, persists, advances per turn, and projects into Directives — but a Routine is authored in **TypeScript and registered at composition** (`contactRoutine`). This spec makes Routines **data a non-engineer authors**. The author works in a **token-aware structured document** (numbered steps with typed variable / action / handoff tokens); a **compiler** translates that document into the 069 runtime graph; the engine runs the compiled graph and the graph appears only in traces. The decisive design choice: *the graph is a compilation target and a trace artifact, never an authoring canvas.* This spec adds the **definition data model**, the **compiler**, the **authoring surface**, and three runtime capabilities the data model needs that 069 lacks — **fast-forward traversal**, a **typed slot schema**, and **condition-gated action references**. It does **not** add whole-turn autonomous (ReAct) agency, a node-and-edge canvas, or free-form prose authoring; those are anti-goals.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Author A Routine As Data And Run It (Priority: P1)

As a workspace operator (non-engineer), I want to author a multi-step flow — declared variables plus numbered steps — save it to my agent, and have the engine run it in conversations, without writing code or registering anything at composition.

**Why this priority**: This is the core capability. Without authoring → compile → run, there is no data-driven routine; everything else refines it.

**Independent Test**: Author a two-slot, two-step routine (collect `name`, collect `topic`, then complete) through the definition API. Assert (a) it compiles to a valid 069 routine graph with stable step/slot ids, (b) saving an invalid draft (a step with no reachable terminal, or a variable referenced but not declared) is rejected with an author-facing validation error, (c) a conversation activates the routine via its declared trigger, collects both slots across turns, and completes — with **zero** routine-identity branches in the engine.

**Acceptance Scenarios**:

1. **Given** a saved, valid routine definition with a declared trigger, **When** a conversation turn matches the trigger, **Then** the engine activates the compiled routine and steers the reply from the first step.
2. **Given** a draft whose authored document fails validation (dangling reference, unreachable step, no terminal), **When** the author saves it, **Then** the save is rejected and the failure is reported in author terms (which step/variable, what is wrong), not as a graph error.
3. **Given** an active authored routine, **When** the user supplies a requested value, **Then** the typed slot is captured and the engine advances, identical in observable behavior to a code-registered routine.

---

### User Story 2 - Skip Ahead When The User Pre-Provides Data (Priority: P1)

As an end user, when I state several facts at once ("track order 12345 for jane@example.com"), I want the agent to use them immediately instead of asking for each one in turn.

**Why this priority**: "Explicit graph is too rigid" is the central objection this feature answers. A rigid one-edge-per-turn walk re-asks for data the user already gave; fast-forward is what makes authored routines feel adaptive rather than scripted.

**Independent Test**: Author a routine whose first two steps collect `order_number` and `email`. Drive a single turn in which the user provides both. Assert the engine fills both typed slots and advances **past both collection steps in that one turn** (fast-forward), reaching the step whose preconditions are now satisfied — without emitting the intermediate "what's your email?" prompt.

**Acceptance Scenarios**:

1. **Given** an active routine at its first collection step, **When** one user message satisfies the preconditions of several downstream steps, **Then** the engine advances through all satisfied steps in a single turn and steers from the first step that still needs input or action.
2. **Given** a partial pre-provision (order number but not email), **When** the turn runs, **Then** the engine captures what was given and asks only for what is still missing.

---

### User Story 3 - Reference A Deterministic Action, Branch On Its Outcome, And Hand Off (Priority: P1)

As an author, I want a step to call a specific integration action (e.g. order lookup) with collected variables, branch on the result (found / not-found / error), retry a bounded number of times, and **hand off to a human** when it can't be resolved.

**Why this priority**: Real flows are not pure data collection — they call backends and must handle failure deterministically. Condition-gated actions, outcome branches, bounded retries, and handoff are what separate a usable routine from a happy-path demo.

**Independent Test**: Author a routine that, after collecting `order_number` + `email`, references an `order_lookup` action; on "not found" it asks for an alternate email and retries; after 2 failed attempts it routes to a **handoff** terminal. Drive (a) a success path, (b) a not-found-then-recover path, (c) two failures → handoff. Assert the action is invoked with the collected variables, the engine — not the routine — decides the call, the attempt counter is enforced by a structured guard (not LLM counting), and the handoff terminal is reached and recorded distinguishably in the trace.

**Acceptance Scenarios**:

1. **Given** a step with a condition-gated action reference, **When** the gating condition is satisfied, **Then** the action becomes available and the engine invokes it with the routine's collected variables, advancing along the matched outcome edge.
2. **Given** an authored attempt limit, **When** the limit is reached, **Then** a structured counter guard (not an LLM judgement) forces the fallback transition.
3. **Given** a handoff terminal, **When** it is reached, **Then** the routine ends in escalate-to-human state, distinct from a side-effect action terminal, and the trace records the handoff.

---

### User Story 4 - Edit And Re-Version A Routine Without Breaking Live Conversations (Priority: P2)

As an author, I want to edit a published routine while conversations are mid-flow, without orphaning those conversations or corrupting historical traces.

**Why this priority**: Authoring implies iteration. Every edit recompiles; stable identity + versioning is what keeps in-flight sessions and past traces coherent. Without it, the first edit after launch breaks production.

**Independent Test**: Start a conversation that reaches step 2 of a published routine v1. Publish an edited v2 (a changed step-3 prompt + a new slot). Assert the in-flight conversation continues on the version it started (v1, pinned by its routine state) and completes coherently, while a new conversation activates v2; historical traces of v1 runs still resolve their step/slot ids.

**Acceptance Scenarios**:

1. **Given** a conversation mid-routine on version N, **When** version N+1 is published, **Then** that conversation continues on N (its routine state pins the version) per the configured migrate-vs-finish policy.
2. **Given** an edit that preserves a step's identity, **When** recompiled, **Then** the step keeps its stable id so traces and in-flight positions remain valid.

---

### User Story 5 - Export And Import A Routine (Priority: Deferred — post-v1)

> **Deferred per decision:** export/import is not in 082 v1 (no existing 079 mechanism to reuse). Retained here for continuity; it ships when the shared 079 import/re-binding mechanism is built.


As an operator, I want to export a routine definition and import it into another agent/workspace, with its references (actions, shared guidelines) re-bound to the target.

**Why this priority**: Routines are reusable operating procedures; portability is a core promise of "settings as data". **Caveat (verified):** 079 built the data-of-record *pattern* but NOT the export/import surface or reference re-binding (deferred "Option A"), so there is no existing mechanism to ride — this story either builds the shared import/re-binding mechanism (which 079 would then reuse) or descopes to a later release. It is P2, not P1, for that reason.

**Independent Test**: Export a routine referencing an `order_lookup` action and a shared guideline. Import into a target agent. Assert the round-trip reproduces the definition and that unresolved references are surfaced for re-binding (not silently dropped), consistent with the 079 reference-re-binding contract.

**Acceptance Scenarios**:

1. **Given** an exported routine, **When** imported into a target with the referenced action available, **Then** the reference re-binds and the routine is runnable.
2. **Given** an import whose referenced action is absent in the target, **When** imported, **Then** the missing reference is reported for resolution; the routine cannot be activated until resolved.

---

### Edge Cases

- **Ambiguous / multiple activatable routines** on one turn → activation arbitration policy (priority/specificity) is explicit and tested, not incidental; ties resolve deterministically.
- **Routine × directive co-composition** → an authored routine turn must still allow directive matching where the design requires it (today routine turns short-circuit before directives — this blocker must be addressed or explicitly scoped out).
- **Author references a conversational skill** (which is turn-engine-picked) instead of a deterministic action → validation distinguishes the two and guides the author; routines do not enumerate conversational skills.
- **Slot extracted but never used / used but never declared** → validation catches both before publish.
- **Action permissioning** → an authored routine referencing an action the agent/operator is not permitted to invoke is rejected at publish, not at runtime.
- **Compiler non-determinism** → the same authored document must compile to the same graph (stable ids); a compile that changes structure without an authoring change is a defect.
- **Off-script mid-routine** (user asks something unrelated) → inherits 069's pause/yield-and-resume policy; unchanged by this spec.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved; 069's runtime slices it depends on MUST be merged and soaked.
- Backend MUST be Node.js/TypeScript; frontend authoring UI MUST be React. Database MUST be PostgreSQL with `pgvector`.
- LLM integrations (the compiler's parse pass, next-step selection, fast-forward evaluation) MUST use GPT-5.2 as the default provider.
- User-facing conversational copy MUST remain LLM/canned-owned: an authored step's instruction steers generation; it is not hard-coded application response text. Routine content authored by operators is data, not application strings.
- Backend development MUST follow TDD: the definition model, compiler (incl. validation failures), fast-forward, condition-gated actions, and versioning are test-first.
- Frontend user-visible authoring behavior MUST prefer Playwright coverage; frontend unit tests stay on non-visual logic (token model, draft validation adapters), not markup/design assertions.
- Routine progression, activation, and compile-time classification MUST NOT use English keyword lists/regexes; Radioso is multilingual. Use LLM structured output, typed slot schemas, or settings rules. Structural parsing of the authoring token grammar (identifiers, references) is acceptable as format parsing, not product vocabulary.
- Modular boundaries MUST hold: the **compiler is a distinct seam**; the **engine consumes the compiled 069 graph and never the authoring document**; the pure engine MUST NOT import the authoring/definition/product modules.
- Customer data MUST be least-privilege: authored routines and their action references honor the per-agent capability and action-permission model; collected slots holding user data follow existing data handling.
- Contract review: authored routine definitions are new persisted, exportable state and new authoring APIs — review SDK/MCP/OpenAPI/connector and worker/AMQP payloads for cross-service impact (expected: chat + settings internal; export/import via 079).
- Documentation MUST cover authoring routines as data, the compile/validation model, fast-forward, condition-gated actions, handoff, and versioning.

## Architecture Constraints *(mandatory)*

- **Compiler-As-Seam Rule**: A dedicated compiler module translates the authored document → a 069 `Routine` graph + slot schema. The compiler is the only component that understands the authoring document; the engine consumes the compiled graph only. The compiler lives outside the pure engine (product/composition side).
- **Graph-Is-Internal Rule**: The compiled graph is a runtime/trace artifact, never an authoring surface. No node-and-edge canvas is exposed; the authoring surface is a token-aware structured document.
- **Definition-As-Data Rule**: Routine definitions are relational data of record (per 079): a versioned `routine_definition` with child rows for slots, steps, transitions, and references. References (actions, shared guidelines) re-bind on import. This supersedes the code-registered const.
- **Stable-Identity Rule**: Steps and slots carry stable ids that survive recompiles; a routine carries a monotonic version; a live `routine_state` pins the version it started on. The same authored document compiles deterministically to the same ids. Stable step ids additionally anchor any **directive scoped to a step** (`step:<routineId>:<stepId>`, per #664): recompiling MUST preserve step ids so scoped directives don't orphan, and orphaned scope tags MUST be surfaced on edit.
- **Typed-Slot Rule**: Variables are a declared, typed schema (key, type, required, description), replacing 069's untyped `Record<string, unknown>`. Extraction targets the schema; "filled" is well-defined per slot.
- **Fast-Forward Rule**: Traversal MUST advance through every step whose preconditions are already satisfied within a single turn (using pre-provided slots / action outcomes), rather than one edge per turn. The 069 single-edge selector is generalized, not replaced wholesale.
- **Condition-Gated-Action Rule**: A routine **references** a deterministic integration action; the reference's gating condition controls *availability*; the **engine decides invocation**. Conversational skills remain turn-engine-picked by intent and are NOT enumerated by routines. Bounded retries and outcome branches use **structured guards** (slot-filled / action-outcome / counter), not LLM counting.
- **Declarative-Activation Rule**: Activation is authored data (an NL trigger condition + a gate/permission reference), compiled into the trigger 069 evaluates. No registered `activates()` closure. Multi-routine activation resolves through an explicit arbitration policy.
- **Validation-In-Author-Terms Rule**: Compile/validation failures are surfaced against the authored document (which step/variable/reference), not as internal graph errors; an invalid routine cannot be published or activated.
- **Dependency-Direction Rule**: frontend authoring → backend definition store + compiler → engine consumes compiled graph. The engine and contract packages MUST NOT import authoring/definition/product modules. Composition assembles the store, compiler, and action registry.
- **Anti-Goals**: no whole-turn ReAct agency; no graph canvas; no free-form prose authoring; do not let routines own conversational-skill dispatch policy; do not encode product behavior in English keyword lists.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST persist a **versioned routine definition** (per agent) as relational data — declared trigger/activation, typed slot schema, authored steps, transitions/guards, action references, and terminals (complete / handoff / side-effect action) — with stable step/slot ids.
- **FR-002**: Operators MUST be able to create, edit, validate, and publish a routine definition through an authoring API/UI without code or composition registration.
- **FR-003**: A **compiler** MUST translate a published definition into a valid 069 `Routine` graph + slot schema, deterministically (same document → same ids/structure), and MUST reject definitions that fail validation.
- **FR-004**: Validation MUST detect and report — in author terms — unreachable steps, missing terminals, dangling action/variable references, undeclared-but-referenced or declared-but-unused slots, attempt limits without a fallback terminal, and references to actions the agent is not permitted to invoke.
- **FR-005**: The engine MUST activate a compiled routine via its **declared (data) trigger**; when multiple routines are activatable, a defined **arbitration policy** selects one deterministically.
- **FR-006**: Variables MUST be a **typed slot schema**; extraction targets declared slots and per-slot "filled" is well-defined; collected slots persist in routine state and are logged/exposed for the action references that consume them.
- **FR-007**: Traversal MUST **fast-forward**: within one turn, advance through every step whose preconditions are already satisfied by pre-provided slots or action outcomes, steering from the first step still needing input/action.
- **FR-008**: A step MUST be able to **reference a deterministic action**; the reference's gating condition controls availability, the engine decides invocation with the collected variables, and the engine advances along the matched **outcome** edge. Conversational skills remain turn-engine-picked and are not enumerated by routines.
- **FR-009**: Outcome branching, bounded retries, and attempt limits MUST be enforced by **structured guards** (slot-filled / action-outcome / counter), never by asking the LLM to count.
- **FR-010**: **Handoff** MUST be a first-class terminal (escalate to human), distinct from a side-effect action terminal, and recorded distinguishably in the trace.
- **FR-011**: Editing a definition MUST produce a new **version**; in-flight routine states MUST pin and continue on the version they started, per an explicit migrate-vs-finish policy; historical traces MUST keep resolving their step/slot ids. Recompiling MUST preserve step ids so that **directives scoped to a step** (`step:<routineId>:<stepId>`, per #664) do not orphan; an edit that removes/renames a scoped step MUST surface the now-orphaned directive scope tag rather than silently dropping it.
- **FR-012** *(Deferred — post-v1)*: Routine definitions SHOULD be **exportable/importable** following the 079 data-of-record/portability pattern, with reference re-binding (and unresolved-reference reporting) on import. **Not in v1** — there is no 079 mechanism to reuse; ships when the shared import/re-binding infrastructure is built.
- **FR-013**: Activation, action invocation, and publish MUST honor the per-agent capability model (existing, for skills) **and a new per-action-type permission gate (net-new — actions today have only an agent-level toggle, no per-action registry/gate).**
- **FR-014**: Documentation MUST describe authoring routines as data, the compile/validation model, fast-forward, condition-gated actions, handoff, and versioning.

### Key Entities *(include if feature involves data)*

- **Routine Definition (versioned)** — per-agent, relational of record: activation/trigger, slot schema, steps, transitions, action references, terminals; monotonic version. New (supersedes the code const).
- **Slot Schema** — declared typed variables (key, type, required, description). New (replaces 069 untyped variables).
- **Authored Step / Transition (guard)** — a step block (kind: chat / tool / action) with a prose instruction; transitions carry prose or structured guards. New (authoring-side; compiles to 069 step/transition).
- **Action Reference** — a condition-gated reference to a deterministic integration action, with outcome edges. New.
- **Terminal** — complete / handoff / side-effect action. Handoff is new as a first-class kind.
- **Compiler** — definition → 069 graph + slot schema, deterministic, with author-facing validation. New seam.
- **Routine Definition Version** — the pinned unit a live routine state references. New.
- **Routine State (session-scoped)** — existing 069 entity; extended to pin a definition version and hold typed slots.
- **069 Routine / RoutineStep / RoutineTransition / Directive** — existing; the compile target and steering mechanism, consumed unchanged in shape (with the fast-forward/typed-slot/action-reference extensions this spec adds to the runtime).

## Data Model Direction

Routine **definitions** become relational data of record per 079: a versioned `routine_definition` parent with child tables for slots, steps, transitions, and references — not a JSON blob — so they are queryable, validatable, and round-trippable on export/import with reference re-binding. The **compiled** 069 graph is a derived artifact (recomputed from a published version; may be cached) and is never edited directly. 069's session-scoped `routine_state` is extended to **pin a definition version** and to hold the **typed slot** values. Definitions and their compiled graphs are agent-scoped; the conversation/message event stream remains the record of observable turn output. The EE contact flow (today a code const under 069) becomes the pilot authored definition; the const is retired once parity holds.

## API Direction

New **authoring** surfaces (per-agent routine definitions): create / read / update / validate / publish, plus list versions — admin/operator-authenticated, behind the existing settings/auth model; reuses 079 export/import. The **chat runtime** request/response and streaming are unchanged; the engine simply consumes compiled routines. Headless `retrieval.*` / SDK / MCP answering surfaces are unchanged. Authoring contract types (definition, slot schema, action reference, validation result) are reviewed against the OpenAPI/SDK/MCP/connector and 079 registries. No public end-user routine-execution API beyond existing chat.

## Delivery Split

Each slice independently shippable; the code-registered contact routine survives until the pilot slice.

1. **Definition data model + compiler + validation.** Versioned `routine_definition` (+ child tables), the compiler to a 069 graph, and author-facing validation. Proven by authoring a slot+chat-step routine via API and running it on the existing 069 runtime (no new runtime behavior yet). (US1)
2. **Typed slots + fast-forward traversal.** Generalize 069 variables to a typed schema and the single-edge selector to fast-forward over satisfied preconditions. (US2)
3. **Condition-gated action references + outcome branches + structured guards + handoff terminal.** (US3)
4. **Versioning + stable identity across edits + in-flight pinning policy.** (US4)
5. **Authoring UI** — the token-aware structured editor (step blocks, variable/action/handoff chips, guideline references) with validation surfaced in author terms (Playwright-covered). (US1/US3 UX)
6. **Pilot.** Re-express the contact flow as an authored definition and retire the code const, with behavior parity (high value, no external dependency). (pilot)

*Deferred (post-v1): export/import round-trip with reference re-binding (US5/FR-012), gated on the shared 079 import/re-binding mechanism.*

## Dependencies & Verified Substrate

Verified against the codebase 2026-06-09 (read-only investigation):

- **069 routine runtime — PRESENT and relied upon.** Activation, resume-first, step→Directive projection, skill/action steps, and the session-scoped `routine_states` store are merged and live; the contact flow already runs as a routine and the old intake paths (`registerChatIntakeProvider`, `skill_intake_states`) are gone (`packages/conversation-engine/src/routineRunner.ts`, migrations `071`/`072`/`073`). 082's compiler targets this runtime. *(069's own status line lags — it reads "slice 4 soak-gated" but slice 4 is merged.)*
- **Action-vs-skill distinction — PRESENT, no need to introduce.** `RoutineStep.kind: "action"` is a fire-and-forget outbox (`actionType` → `RoutineActionRequest` → `ActionHandlerRegistry`, idempotent enqueue) and is structurally distinct from `kind: "skill"` (executor dispatch with outcome branching) (`packages/conversation-contract/index.d.ts`, `backend/src/modules/chat/services/actions/actionDispatcher.ts`). 082 reuses this; it does **not** redefine it.
- **079 data-of-record PATTERN — PRESENT and to be followed.** The `agent_directives` child table + the `AgentConfig` serializer with a per-field portability map (`secret`/`ref`/`portable`) exist (`migrations/076`, `backend/src/modules/agents/agentConfig.ts`). 082's `routine_definition` + child tables follow this precedent.
- **079 export/import + reference re-binding — NOT BUILT (deferred "Option A").** There is no export/import HTTP surface and no re-binding logic. **Therefore 082 cannot "reuse" an import mechanism — it is net-new work shared with 079.** This re-scopes US5/FR-012 (see below).
- **Action-permission model — PARTIAL.** Conversational skills are gated by `requiredCapabilities[]` + `CapabilityPolicy`; actions have only an agent-level toggle (`contactRequestsEnabled`), no per-action-type registry or invocation gate. 082 must **build** the action-permission gate; it is not a reused substrate.
- **Routine × directive co-composition — ADDRESSED by PR #664 (open).** The previous short-circuit (`processTurn`/`processTurnStream` early-return skipping `prepareTurn`'s directive matching) is removed there: `DefaultRoutineRunner.resume` takes a `steeringResolver` that merges directive steering into the routine step's projected steering, and a `directive_steering` trace stage is emitted on routine turns. PR #664 also adds **directive scope tags** — `routine:<id>` / `step:<routineId>:<stepId>`, gated by `isDirectiveEligibleForTurn` against `turnContext.activeRoutineId`/`activeStepId` (untagged = global) — and `DefaultSteeringResolver` (priority order + dedup). **082 depends on #664 merging** and **reuses its scope-tag model + resolver** rather than inventing a parallel one. *Note: #664 adds migration `082_agent_directive_scope_tags.sql`, so 082's own migrations start at `083+`.*
- **Scope-tag ↔ recompile interaction (new requirement, from #664).** A directive scoped `step:<routineId>:<stepId>` references a routine step id. When 082 recompiles an edited routine, changed step ids would **orphan** such directives. 082's Stable-Identity rule therefore must protect directive scope-tag references too (not just routine state + traces), and 082 must validate/surface orphaned scope tags on edit (the "directive orphan observability" follow-up #664 defers).

## Decisions & Assumptions

- **DECIDED — routine × directive co-composition is handled upstream by PR #664** (open, `evaluate-workbench → main`). 082 sequences after #664 merges and reuses its scope-tag model + steering resolver. Until #664 lands, the interim constraint (a routine turn doesn't co-run directives) holds, which the contact pilot does not need.
- **DECIDED — export/import is OUT OF SCOPE for 082 v1.** 082 ships authoring + compiler + runtime + the contact pilot, following the 079 data-of-record/portability *pattern* but **not** building the export/import surface. Portability (the shared 079 import/re-binding mechanism) is a separate, later release. US5 below is retained as **Deferred (post-v1)** for continuity, not v1 scope.
- One active routine per session remains acceptable for v1; a multi-routine arbitration policy is defined even if only one activates.
- **DECIDED — clarification deferred (arbitration-only v1).** "Ask the user when candidates are too close" — the **Clarification** capability (a.k.a. disambiguation in the literature; distinct from slot-filling) — is a separate cross-cutting feature (it also serves retrieval-sense ambiguity, e.g. a corpus term with two senses — not just routines); see `.context/clarification-generic.md`. v1 only preserves the seam: multi-routine activation returns a ranked candidate set and picks the top (no first-match short-circuit), so clarification drops in later without rework.
- Per-turn step-sourced traces are sufficient; a continuous routine trace is a later enhancement.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A non-engineer can author a routine (slots + steps) via the authoring surface, publish it, and have it run in a conversation to completion, with **zero** routine-identity branches in the engine (US1 test + diff inspection).
- **SC-002**: Saving an invalid definition (unreachable step, dangling/undeclared reference, missing terminal, over-permission action) is rejected with an **author-facing** message naming the offending step/variable/reference (validation tests).
- **SC-003**: A single user message providing N facts advances the routine past all N satisfied steps in that turn (fast-forward), emitting no prompt for already-provided data (US2 test).
- **SC-004**: A routine referencing a deterministic action invokes it with collected slots, branches on its outcome, enforces a bounded retry via a structured counter guard, and reaches a handoff terminal after the limit — with the action call decided by the engine, not the routine (US3 test).
- **SC-005**: Editing and republishing a routine does not break an in-flight conversation (it continues on its pinned version) and does not corrupt historical traces (US4 test).
- **SC-006**: *(conditional on the shared import/re-binding mechanism)* A routine exports and imports across agents with references re-bound, and unresolved references reported rather than silently dropped (US5 test). If the mechanism is descoped, this SC moves with US5 to a later release.
- **SC-007**: The same authored document compiles deterministically to the same graph ids/structure across repeated compiles (compiler determinism test).
- **SC-008**: No routine activation/progression/compile path contains English keyword lists or regexes encoding product vocabulary (verified against the no-keyword-lists rule).
- **SC-009**: The contact flow runs as an **authored data** routine with behavior parity, and the code-registered const is retired (pilot test + diff inspection).
- **SC-010**: Docs describe authoring-as-data, compile/validation, fast-forward, condition-gated actions, handoff, and versioning.
