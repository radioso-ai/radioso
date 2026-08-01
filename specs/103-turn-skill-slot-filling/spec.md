# Feature Specification: Skill Slot Filling

**Feature Branch**: `103-turn-skill-slot-filling`
**Created**: 2026-08-02
**Status**: Draft (second draft — rescoped to the conversation kit after the first draft
was rejected; see `review-codex-2026-08-02.md`)
**Input**: User description: "I want slot-filling to work in the conversation-kit."

## Context

A skill declares the fields it needs. Nothing fills them from the conversation before the
skill is dispatched, so a skill that wants `calendar_date` receives nothing.

In `@radioso/conversation-kit` the shape of the gap is exact. A host registers
`SkillDefinition`s and pairs each with a handler in `localSkills`. When a matched
directive's binding selects a skill, `createDirectiveBoundSkillSelector` returns
`{ skillName, reason }` with no `input`, and the kit's dispatcher passes
`isRecord(selected.input) ? selected.input : {}` — an empty object — to the handler
(`packages/conversation-kit/src/defaultPorts.ts`). The handler also receives the raw user
message, so today the only way to get a value out of the conversation is for each handler
to parse prose itself. That is unacceptable in a multilingual product and is precluded by
the repo's rule against English keyword lists driving behavior.

`SelectedSkill.input` exists in the contract and the engine already passes it to the
dispatcher. `SkillDefinition.inputSchema` also exists, typed `unknown`, and is never
populated. The seams are present and empty.

### Scope: the kit only

This slice targets `conversation-contract`, `conversation-engine`, `conversation-defaults`
and `conversation-kit`. A kit host passes skill definitions in directly, so the field
declaration is available at the selection boundary by construction.

The Radioso backend is **not** in scope, and its adoption is a separate feature. The
backend's blockers are host-integration concerns that do not exist in the kit: no runtime
skill definition carries its field declarations before dispatch (`AgentSkillSpine` has
neither `exposedPayload` nor `exposedParams`, and transport executors re-query their own
stores at dispatch time); a chat stream bridge must render a parked turn; webhook and MCP
executors must keep their `slotBinding ?? key` aliasing; and outbound calls need
idempotency on retry. None of that constrains the kit design, but the contract this slice
lands must not make any of it harder.

Two backend facts remain worth recording, because the first draft got them wrong and they
explain why the backend is a separate effort: webhook skills cannot claim a turn at all
(`TURN_BINDABLE_KINDS` is `{"external_mcp"}` — action kinds settle with outputs and no
answer text, which would render a blank reply), and a webhook already refuses to fire when
required fields are missing (`webhookSkillExecutor` returns `missing_input` before
resolving a destination).

### What this does not change

Skill **selection** stays authored and deterministic. A matched directive's binding picks
the skill; explicit host metadata overrides it. The model never chooses, vetoes, or
substitutes a skill. This feature gives the model one job: given one already-selected
skill's declared fields, produce values for them. Parlant folds applicability and argument
inference into a single generation and lets the model answer `should_run`; applicability is
deliberately excluded here because selection is settled before this runs.

Routine `skill` steps keep `inputBindings` as their argument source. Filling an *untyped*
routine step's declared fields with the same resolver is a natural second consumer and is
called out in Open Questions, not specified here.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A declared field is filled from the conversation (Priority: P1)

A kit host declares a skill with the fields its handler needs, binds it to a directive, and
the handler receives those fields populated from what the user said.

**Why this priority**: This is the feature. Without it a declared field is unreachable and
the handler must parse prose.

**Independent Test**: Register a skill declaring `calendar_date` and `haircut_style` (with
choices), bind it to a directive, run a turn whose message supplies both, and assert the
handler received both values.

**Acceptance Scenarios**:

1. **Given** a bound skill declaring a required `calendar_date` and an optional
   `haircut_style` with choices, **When** the message supplies both, **Then** the handler
   receives both and the optional value is one of the declared choices.
2. **Given** the same skill, **When** the message supplies only the required field,
   **Then** the handler receives the required field and the optional field is absent.
3. **Given** a skill declaring no fields, **When** it is selected, **Then** the handler is
   dispatched exactly as it is today and no model call is made.
4. **Given** a host that sets `selected.input` through its own selector, **When** the skill
   is dispatched, **Then** the host's values are used and no extraction runs.

---

### User Story 2 - A missing required field asks instead of dispatching (Priority: P1)

When the conversation does not contain a required value, the turn asks for it rather than
running the handler with a hole.

**Why this priority**: A handler is a side effect the kit does not control. Dispatching one
with missing required data is worse than not dispatching. Ships with US1.

**Independent Test**: Declare a required field, run a turn whose message omits it, and
assert the handler was never called and the reply asks for the value.

**Acceptance Scenarios**:

1. **Given** a bound skill with an unsatisfiable required field, **When** the directive
   matches, **Then** the handler is not called and the reply asks the user for the value.
2. **Given** that field declares choices, **When** the reply asks, **Then** the choices are
   presented.
3. **Given** several missing required fields, **When** the reply asks, **Then** it asks in
   one turn, not one question per field.
4. **Given** the user supplies the value on the next turn, **When** the directive matches
   again, **Then** the handler is called with the value.
5. **Given** a turn parked for missing input, **When** the host inspects the result,
   **Then** the parked state is observable on `ProcessTurnResult` rather than inferable
   only from the absence of an outcome.

---

### User Story 3 - Extracted values are validated before they reach a handler (Priority: P1)

A value that does not fit the declaration never reaches the handler.

**Why this priority**: The output triggers a host side effect. US1 cannot safely ship
without this, so it is P1 rather than a follow-on.

**Acceptance Scenarios**:

1. **Given** a field declaring choices, **When** the model returns a value outside them,
   **Then** the value is treated as missing and never passed.
2. **Given** a typed field, **When** the model returns a value that cannot be coerced to
   that type, **Then** the value is treated as missing.
3. **Given** the model returns a key the skill did not declare, **When** the result is
   assembled, **Then** the extra key is discarded.
4. **Given** any rejected value, **When** the turn completes, **Then** the trace records
   the field and the reason, and never the value.

## Requirements *(mandatory)*

### Contract and boundary

- **FR-001** `SkillDefinition.inputSchema` MUST become a concrete, typed field
  declaration rather than `unknown`: per field a name, a type, requiredness, an optional
  description, and an optional closed set of permitted values. No sibling descriptor field
  is added, and no transport-specific data belongs in it.
- **FR-002** Filling MUST be a distinct port invoked by the engine after selection and
  before dispatch, returning one of: filled input, a parked "needs input" decision naming
  the unsatisfied fields, or a failure. It MUST NOT live in the selector, which stays
  deterministic selection policy, nor in the dispatcher, which would make every host
  implementation own extraction.
- **FR-003** The default implementation — prompt construction, response parsing,
  coercion, validation, and the ready/needs-input/failed decision — MUST live in
  `conversation-defaults` and be usable with no backend present.
- **FR-004** Coercion to the declared type MUST happen in the resolver, so every host
  receives canonical values and cannot diverge on dates, numbers, and booleans.

### Behavior

- **FR-005** Extraction MUST be skipped entirely when the selected skill declares no
  fields, or when every declared field is already satisfied by host-supplied
  `selected.input`.
- **FR-006** Host-supplied `selected.input` values MUST take precedence over extracted
  values and MUST NOT be presented to the model as fillable.
- **FR-007** An extracted value MUST be validated against its declared type and permitted
  values. An invalid value MUST be treated as missing, never passed to a handler.
- **FR-008** A key the model returns that the skill did not declare MUST be discarded.
- **FR-009** When any required field is unsatisfied after extraction and validation, the
  skill MUST NOT be dispatched, and the turn MUST render a request for the missing values,
  presenting permitted values where declared and covering all missing fields in one turn.
- **FR-010** When a turn selects more than one skill, all extraction and validation MUST
  complete before any skill is dispatched. A skill parked for missing input MUST NOT be
  preceded by dispatching a different skill in the same turn.
- **FR-011** Extraction MUST be bounded by a timeout and MUST fail closed: on parse
  failure, timeout, or model error no handler is dispatched and no partially filled input
  is passed.
- **FR-012** The parked state MUST be exposed on `ProcessTurnResult` alongside the
  existing `awaitingDecision`, so a host can persist it rather than infer it.

### Safety

- **FR-013** User text is untrusted input that becomes a handler's arguments. The
  extraction prompt MUST separate instructions from conversation content, MUST constrain
  output to the declared fields, and MUST NOT grant the model authority to add keys or to
  alter host-supplied values.
- **FR-014** Extracted values MUST NOT appear in logs, traces, or telemetry. Field names,
  outcome per field, and rejection reasons are observable; values are not.

### Compatibility

- **FR-015** A skill with no declared fields MUST behave exactly as it does today, with no
  added model call and no added latency.
- **FR-016** Routine `skill` steps MUST be unaffected; `inputBindings` remains their
  argument source.
- **FR-017** The engine's streaming path MUST remain correct: a turn parked for missing
  input MUST NOT leave a stream consumer with no rendered reply.

## Success Criteria *(mandatory)*

- **SC-001** A kit skill declaring three fields, bound to a directive, receives all three
  populated from a single user message, with no host-written parsing.
- **SC-002** A required field absent from the conversation produces a question to the user
  and zero handler invocations.
- **SC-003** A model-returned value outside a field's declared choices never reaches a
  handler.
- **SC-004** Skills without declared fields show no behavior or latency change.
- **SC-005** All of the above run with no backend present.

## Open Questions

1. **Is the parked turn one model call or two?** Rendering the request for missing fields
   is a generation. The composer already runs at the end of a turn and could render it from
   the parked decision as steering, making it one extraction call plus the normal compose.
   Confirm the composer path is sufficient rather than adding a dedicated ask prompt.
2. **Does the resolver see conversation history or only the current message?** History
   makes multi-turn slot capture work (the user said the date two turns ago) and enlarges
   the injection surface.
3. **Untyped routine steps as a second consumer.** 090 specced model-filled untyped steps
   and they were never built; an untyped step currently passes the whole variable bag. Same
   resolver, second call site. In this slice or the next?
4. **Author-controlled sourcing.** Parlant's `source: "customer" | "context" | "any"`
   prevents the model inventing a value that must come from the user. Deferred from this
   slice on the review's recommendation; confirm that deferral.
5. **Re-asking policy.** If the user answers the question with something that still fails
   validation, does the turn ask again, ask differently, or give up?
