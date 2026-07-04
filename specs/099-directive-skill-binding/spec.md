# Feature Specification: Directive Skill Binding

**Feature Branch**: `099-directive-skill-binding`
**Created**: 2026-07-03
**Status**: Approved (requestor approved in session 2026-07-03 after Codex spec review was addressed)
**Input**: User description: "Directives gain an optional skill binding: when a matched directive names a skill, the turn skill selector routes the turn to that skill if it is enabled for the agent. Backend slice only: persistence, authored directive schema, agent config export/import, conversation contract, selector consumption with conflict and fall-through rules, trace/observability, OpenAPI/SDK regen, docs."

## Context

Directives today only contribute steering to reply composition: matched directives
render as plain-text steering in the answer prompt. They cannot express "when the user
asks about X, use skill Y" —
the natural middle ground between a prose directive and a full routine. This feature
adds an optional skill binding to directives so a matched directive can route the turn
to a named skill. The agreed delivery plan (including follow-up slices that are out
of scope here) lives in `.context/directive-skill-binding-plan.md`.

Related existing behavior this feature does not change: directives already run during
routine turns (matched per landed step) and can already be scoped to a routine or a
specific routine step via `routine:<id>` / `step:<routineId>:<stepId>` tags. Steering a
turn *into* a routine (a routine-targeted binding) is a known follow-up; this slice
reserves room for it in the binding's shape but does not implement it.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Bind a skill to a directive (Priority: P1)

An agent builder authors a directive such as "when the visitor asks about order status"
and binds it to the agent's order-lookup skill. From then on, when a visitor message
matches that directive's condition, the turn is handled by the bound skill instead of
whichever skill the default selection would have picked, and the directive's action text
still steers the reply.

**Why this priority**: This is the entire point of the feature — closing the gap where
steering a turn toward a capability required authoring a full routine.

**Independent Test**: Create a directive with a contextual condition and a skill binding
via the directives API, send a matching message through the chat pipeline, and observe
that the bound skill handled the turn while a non-matching message is handled by default
selection.

**Acceptance Scenarios**:

1. **Given** an agent with an enabled turn-selectable skill and a directive binding that
   skill, **When** a user message matches the directive's condition, **Then** the bound
   skill handles the turn and the directive's action text is applied to the reply.
2. **Given** the same agent, **When** a user message does not match the directive's
   condition, **Then** turn handling is unchanged from today's default selection.
3. **Given** a directive with a binding, **When** the author creates or updates it naming
   a skill the agent does not have (or a skill that cannot handle whole turns), **Then**
   the request is rejected with a clear validation error.

---

### User Story 2 - Predictable behavior under conflict and unavailability (Priority: P2)

An agent builder with several bound directives, or with a binding whose skill was later
disabled, gets deterministic, non-breaking behavior: one well-defined winner when
multiple bound directives match, and a graceful fall-through (normal answer plus the
directive's text steering) when the bound skill is unavailable at turn time.

**Why this priority**: Without defined conflict and fall-through rules the feature is
untrustworthy in exactly the multi-directive setups it is meant to serve.

**Independent Test**: Author two bound directives whose conditions both match one
message and verify the winner follows the documented rule; disable a bound skill and
verify the turn still completes normally.

**Acceptance Scenarios**:

1. **Given** two matched directives bound to different skills, **When** the turn is
   selected, **Then** the directive with higher priority wins; on equal priority the
   higher matcher confidence wins; the losing binding is recorded in the turn trace.
2. **Given** a matched directive bound to a skill that is disabled or no longer exists
   on the agent, **When** the turn runs, **Then** the binding is ignored, the directive's
   text steering still applies, the turn completes normally, and the skipped binding is
   recorded in the turn trace and operational logs.
3. **Given** a turn that is inside an active routine, **When** directives match, **Then**
   skill bindings have no effect on that turn (routine control flow is untouched).

---

### User Story 3 - Diagnosable and portable bindings (Priority: P3)

An operator inspecting a conversation can see from the turn trace that a skill was
chosen because of a specific directive (or that a binding was skipped and why). An agent
builder exporting an agent's settings and importing them elsewhere gets identical
binding behavior on the imported agent.

**Why this priority**: Trace visibility is how builders debug steering, and settings
portability is an existing product guarantee that must not silently exclude the new
field.

**Independent Test**: Run a bound-directive turn and inspect its trace for the selection
reason; export the agent config, import it into a fresh agent with the same skills, and
verify the binding round-trips.

**Acceptance Scenarios**:

1. **Given** a turn where a binding determined skill selection, **When** the turn trace
   is inspected, **Then** it names the directive that caused the selection.
2. **Given** an agent config export containing bound directives, **When** it is imported,
   **Then** bindings are preserved by skill name and behave identically when the target
   agent has those skills enabled.

---

### Edge Cases

- Binding on an `always` directive: valid; the bound skill is preferred on every
  non-routine turn, subject to the same conflict and availability rules.
- Matched directive below the matcher confidence threshold: not a match, so its binding
  has no effect (unchanged matcher semantics).
- Two matched directives bound to the same skill: no conflict; selection reason names the
  higher-ranked directive.
- Skill deleted or disabled after the directive was authored: runtime fall-through per
  US2; authoring-time validation only guards create/update.
- Import into an agent that lacks the bound skill: import succeeds (binding preserved as
  data); runtime fall-through applies until the skill is enabled.
- Directive excluded via another directive's `excludes` relationship: an excluded
  directive contributes neither steering text nor its skill binding.
- Skill binding combined with routine/step scope tags (`routine:<id>` / `step:...`):
  the scope tag makes the directive eligible only during routine turns, where bindings
  do not apply, so the binding is inert. The combination is accepted but MUST be called
  out as inert in the documentation.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Backend MUST be implemented in Node.js; database is PostgreSQL (no new storage).
- Backend development MUST follow TDD: tests written and failing before implementation.
- User-facing reply text remains LLM-generated; this feature adds no hard-coded
  conversational copy.
- No new runtime LLM prompts are introduced; the directive matcher prompt is explicitly
  unchanged (bindings are consumed after matching, not during).
- HTTP contract changes MUST go through the code-first OpenAPI registry
  (`backend/src/app/http/openapi/document.ts`); `openapi.yaml`/`openapi.json` are
  regenerated, never hand-edited; the TypeScript SDK is updated via its sync chain.
- Message-queue impact review: **none** — selection happens in-turn within the chat
  pipeline; no worker dispatch, AMQP payload, or retry semantics are touched.
- Documentation parity: directive product docs and API reference MUST be updated in the
  same change.
- No secrets or configuration changes are involved.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: The directive *contract* (new optional binding field) lives in
  `packages/conversation-contract`. Authoring validation and persistence mapping live in
  the agents module (`backend/src/modules/agents/`). Binding resolution at selection
  time lives in `ChatTurnSkillSelector` (`backend/src/modules/chat/services/
  turnSkillSelector.ts`) — which is where a `TurnSkill` is actually chosen — via a
  named pure helper it consumes; `TurnSelectionStrategy` remains candidate/reason
  policy only. Nothing moves into the engine loop, the matcher, or route handlers.
- **Encapsulation Rule**: The directive matcher (`conversation-defaults` matchers and
  `backend/prompts/chat/directive-match.md`) MUST remain unchanged — it continues to see
  only directive name + condition. The engine orchestration
  (`packages/conversation-engine/src/index.ts`) already passes directive matches to the
  selector before selection; the engine's ordering and responsibilities MUST NOT change.
- **New Seams Required**: None structural — this feature consumes the existing
  matches→selector seam. Binding resolution (winner picking + availability
  fall-through) MUST be a named, unit-testable pure module consumed by the selector
  rather than inline selector logic.
- **Anti-Goals**:
  - Do not add a `prefer|require` mode enum, weights, or any binding DSL — one semantic
    only in this slice.
  - Do not implement routine-targeted bindings: the binding shape reserves a target
    kind for them, but validation and runtime MUST accept only skill targets here.
  - Do not modify the matcher prompt, matcher inputs, or matching thresholds.
  - Do not touch steering rendering, token budgets, or top-k capping (that is follow-up
    slice 3).
  - Do not add frontend authoring UI (follow-up slice 2); the field ships API-first.
  - Do not encode skill routing via keyword lists or query heuristics anywhere —
    activation is solely the existing LLM directive matcher.
  - Do not let routine activation or routine step logic read bindings.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A directive MAY declare at most one optional binding target, expressed as
  a discriminated object (target kind + skill name; exact field names chosen at
  planning). In this slice the only supported target kind is a skill; the binding
  persists with the directive, and its persisted and API shape MUST accommodate a
  future target kind (e.g. routine) without a data migration.
- **FR-002**: Creating or updating a directive with a binding MUST validate that the
  named skill exists on the agent, is enabled, and has a turn-capable invocation mode
  (routine-only skills are rejected), with a descriptive error naming the offending
  skill. Import (FR-009) is exempt from this validation by design.
- **FR-003**: On a non-routine turn, when a matched directive carries a binding and the
  bound skill resolves to a registered runtime turn skill for the agent, turn skill
  selection MUST route to that skill.
- **FR-004**: When multiple matched directives carry bindings, selection MUST pick a
  single deterministic winner ordered by: directive priority descending (unset priority
  ranks at the existing default of 50), then matcher confidence descending
  (deterministic `always` matches rank as certain), then directive name ascending as
  the final tie-breaker. Multiple directives bound to the same skill are not a
  conflict; the selection reason names the highest-ranked one. Non-winning bindings
  MUST appear in the turn trace.
- **FR-005**: When the bound skill is unavailable at turn time — disabled, removed from
  the agent, no longer turn-capable, or lacking a registered runtime turn skill — the
  binding MUST be ignored, the directive's text steering MUST still apply, and the skip
  MUST be recorded in the turn trace and as a warn-level operational log carrying
  workspace, agent, conversation, directive name, skill name, and skip reason — never
  message content.
- **FR-006**: Turns handled by routine control flow MUST be unaffected by bindings:
  routine-scoped matched directives may still contribute steering text to step replies,
  but their bindings are never evaluated because routine turns do not run terminal
  skill selection.
- **FR-007**: The directive matcher MUST continue to receive only directive name and
  condition; bindings MUST NOT influence whether a directive matches.
- **FR-008**: The engine conversation trace (the system of record from which
  presentation surfaces read) MUST record binding outcomes per turn: for each bound
  matched directive, the directive name, bound skill name, and outcome
  (selected / lost conflict / skipped) with reason; binding-driven selections MUST
  carry a selection reason that names the directive.
- **FR-009**: Agent settings export MUST include bindings, and import MUST restore them
  by skill name (round-trip fidelity), independent of whether the target agent currently
  has the skill; import intentionally bypasses FR-002 authoring-time validation, and
  runtime fall-through (FR-005) governs until the skill is enabled.
- **FR-010**: The public directives API (list/create/update responses) MUST expose the
  binding field; OpenAPI artifacts MUST be regenerated and the TypeScript SDK types
  synced.
- **FR-011**: Directive product documentation and the API reference MUST describe the
  binding, its conflict rule, and its fall-through behavior — at minimum
  `docs/architecture/conversational-directives.md` and
  `docs-portal/content/api/agents-and-skills.mdx` (or the docs-portal page that owns
  the directives API if review finds a better fit).

### Key Entities

- **Directive**: existing authored entity (condition, action, priority, relationships);
  gains one optional skill-binding attribute referencing a skill by name.
- **Directive Match**: existing per-turn result of the matcher (directive + confidence);
  carries the binding through to selection unchanged.
- **Turn Selection Trace**: existing per-turn diagnostics; gains the binding-driven
  selection reason and skipped/losing-binding records.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A builder can go from "directive exists" to "matching messages are handled
  by the bound skill" using only the directives API — verified end-to-end on a live
  chat turn, with non-matching messages unaffected.
- **SC-002**: 100% of authoring attempts naming an invalid skill are rejected with an
  error message that names the offending skill.
- **SC-003**: 100% of turns whose bound skill is unavailable still produce a normal
  reply (no user-visible failure), and every such turn is diagnosable from its trace.
- **SC-004**: Agent settings export/import preserves bindings with 100% round-trip
  fidelity.
- **SC-005**: Turns without bound directives show no behavior change (existing directive,
  selection, and routine test suites stay green).

## Assumptions

- The binding references skills by the agent-skills spine `skillName`, which is the
  stable, portable identifier used by export/import (per the agreed plan; the exact
  API field name, e.g. `skillName`, is chosen at planning).
- "Turn-capable skill" means a skill the turn selector can dispatch for a whole turn
  (per the unified-skills invocation modes); routine-only skills are not bindable.
- Single semantic ("route to the bound skill when available") is intentional; a
  prefer/require distinction is deferred until evidence demands it.
- The binding is modeled as a target with a kind discriminator (only `skill` accepted
  in this slice) so that routine-targeted bindings can be added later as a validation
  and runtime change rather than a schema migration.
- Frontend authoring UI, steering-scale guardrails, routine-targeted bindings, and
  richer structural conditions (routine/step scope as first-class fields, visitor
  context variables feeding the matcher) are explicitly follow-up slices tracked in
  `.context/directive-skill-binding-plan.md`.
