# Feature Specification: Skill Slot Filling

**Feature Branch**: `103-turn-skill-slot-filling`
**Created**: 2026-08-02
**Status**: Draft (third draft — kit-scoped, both Codex reviews incorporated; see
`review-codex-2026-08-02.md` and `review2-codex-2026-08-02.md`)
**Input**: User description: "I want slot-filling to work in the conversation-kit."

**Depends on**: PR #966 (`skill-auto-selection-gap`), which adds
`createDirectiveBoundSkillSelector` and makes it the kit's default. This branch is based on
it. Without that work the P1 story is not runnable with `createConversationKit` defaults,
because the previous default selector read only input metadata.

## Context

A skill declares the fields it needs. Nothing fills them from the conversation before the
skill is dispatched, so a skill that wants `calendar_date` receives nothing.

In the kit the shape of the gap is exact. A host registers `SkillDefinition`s and pairs
each with a handler in `localSkills`. When a matched directive's binding selects a skill,
`createDirectiveBoundSkillSelector` returns `{ skillName, reason }` with no `input`, and
the kit's dispatcher passes `isRecord(selected.input) ? selected.input : {}` — an empty
object — to the handler. The handler also receives the raw user message, so today the only
way to get a value out of the conversation is for each handler to parse prose itself. That
is unacceptable in a multilingual product and is precluded by the repo's rule against
English keyword lists driving behavior.

`SelectedSkill.input` exists in the contract and the engine already passes it to the
dispatcher. `SkillDefinition.inputSchema` also exists, typed `unknown`. The seams are
present and empty.

### Scope: the kit only

This slice targets `conversation-contract`, `conversation-engine`, `conversation-defaults`,
`conversation-kit`, and — because FR-001 breaks it — `conversation-tools`.

The Radioso backend is **not** in scope; its adoption is a separate feature. Its blockers
do not exist in the kit: no runtime skill definition carries field declarations before
dispatch, a chat stream bridge must persist a parked turn, webhook and MCP executors must
keep `slotBinding ?? key` aliasing, and outbound calls need retry idempotency. None of that
constrains this design, but the contract landed here must not make any of it harder.

Two backend facts are recorded because the first draft got them wrong: webhook skills
cannot claim a turn at all (`TURN_BINDABLE_KINDS` is `{"external_mcp"}` — action kinds
settle with outputs and no answer text), and a webhook already refuses to fire when
required fields are missing (`webhookSkillExecutor` returns `missing_input`).

### What this does not change

Skill **selection** stays authored and deterministic. A matched directive's binding picks
the skill; explicit host metadata overrides it. The model never chooses, vetoes, or
substitutes a skill. It gets one job: given one already-selected skill's declared fields,
produce values. Parlant folds applicability into the same generation and lets the model
answer `should_run`; applicability is excluded here because selection is already settled.

Routine `skill` steps keep `inputBindings` as their argument source.

## Design decisions

These were contested in review and are settled. Each is a constraint on the plan.

**D1 — Resolve every selected skill before dispatching any.** The engine's dispatch loop
currently feeds each skill the previous skill's staged context and outcome guidance. A
resolver called inside that loop would let skill B's extraction see skill A's output — but
A would already have side-effected before B could park. Both guarantees cannot hold.
Side-effect safety wins: build a resolution plan for every selected skill from the single
immutable pre-dispatch turn snapshot, and dispatch only if every plan item is ready.
**Consequence, stated plainly:** same-turn skill outputs are not available to slot filling.
A flow where A's result is B's argument belongs in a routine or a later turn.

**D2 — The parked turn is its own result shape.** Add `awaitingSkillInput` to
`ProcessTurnResult`, threaded through the prepared-run type and both result constructors.
Do not reuse `RoutineAwaitingDecision`: it models an authored graph position with a
`captureKey` and a closed `DecisionOption` list, not schema-governed free-form values. Do
not reuse `ConversationClarifier`: its reply mapping returns an option id or a decline,
not typed values.

**D3 — One extraction call plus the ordinary compose.** No dedicated ask prompt. The engine
adds a structured skill-input request to composition as a synthetic steering instruction;
the existing composer already renders steering. `awaitingSkillInput` carries the
machine-readable form for the host.

**D4 — Extraction input is bounded conversation history plus the current message.** Never
staged context, turn metadata, or host-supplied values. History is labelled as data;
declared fields and instructions live in the system prompt. History is included so a value
mentioned earlier can still be recovered.

**D5 — Host-supplied input is authoritative on provenance, not on validity.** It wins over
extraction and is never offered to the model, but it is validated against the same
declaration. Invalid host input parks or fails; it is not passed through.

**D6 — Reuse the field normalization primitive, not the routine components.** Routine
machinery already extracts declared slot values from a message
(`RoutineNextStepSelector` allowlists declared keys; `slotCorrection` does deterministic
type verification for mutable post-completion corrections). Building a second independent
JSON parser, prompt discipline, and scalar coercer would be the real mistake. Share the
normalization/validation primitive. Do not make a routine selector impersonate a
selected-skill resolver — `RoutineSlotSchema` has a different contract (`id`, `key`,
`mutable`, no choices).

**D7 — "Timeout" means bounding the turn's wait, not cancelling the provider call.**
`ConversationModelGateway.complete` takes no abort signal. The resolver races a deadline
and fails closed; it does not claim cancellation.

**D8 — `awaitingSkillInput` is a report of this turn, not durable state.** The engine does
not own resumption and does not persist a pending request. This dissolves the cross-turn
conflict the third review found: a yielded routine that resumes on the next turn cannot
"steal" an answer, because there is no engine-held claim on it. Retry is natural rather
than orchestrated — on a later turn the directive matches again, extraction reads the
bounded history (D4), the user's answer is in it, and the field fills.

The limitation this accepts, stated plainly: if the user's answer does not itself re-match
the directive, the skill is not retried that turn. A host wanting stronger behavior
persists `awaitingSkillInput` and forces the skill via `selected.input` or metadata
selection. Engine-owned resumption, and any exclusivity rule against `awaitingDecision`,
are deliberately not designed here — inventing a second parked-state machine that must
negotiate with routine resumption is a larger feature than slot filling.

**D9 — Supported types in v1 are scalars only:** `string`, `number`, `integer`, `boolean`,
and `date` as an unambiguous ISO-8601 calendar date (`YYYY-MM-DD`). Choice matching is
exact against declared values after trimming. Locale-dependent date interpretation, nested
objects, and arrays are cut — but an unambiguous date representation is not cuttable,
because "next Friday" is exactly the conversion slot filling exists to perform.

**D10 — `conversation-tools` stops populating `inputSchema` from raw transport schemas.**
Nothing consumes it today, so dropping the passthrough is behavior-preserving and honest.
Deliberate projection from MCP/OpenAPI JSON Schema into the normalized declaration is a
follow-up with its own tests; a silent partial projection would be worse than none.

**D11 — A `failed` resolution is not an ask.** Parse failure, deadline, or model error
means the skill could not be run, not that information is missing. The turn dispatches
nothing and composes an ordinary reply; the trace records the failure. Only unsatisfied
*required fields* produce a question.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A declared field is filled from the conversation (Priority: P1)

A kit host declares a skill with the fields its handler needs, binds it to a directive, and
the handler receives those fields populated from what the user said.

**Independent Test**: Register a skill declaring `calendar_date` and `haircut_style` (with
choices), bind it to a directive, run a turn supplying both, assert the handler received
both.

**Acceptance Scenarios**:

1. **Given** a bound skill declaring a required `calendar_date` and an optional
   `haircut_style` with choices, **When** the message supplies both, **Then** the handler
   receives both and the optional value is one of the declared choices.
2. **Given** the same skill, **When** the message supplies only the required field,
   **Then** the handler receives it and the optional field is absent.
3. **Given** a value the user stated two turns earlier, **When** the skill is selected now,
   **Then** it is recovered from history.
4. **Given** a skill declaring no fields, **When** it is selected, **Then** it dispatches
   exactly as today and no model call is made.
5. **Given** a host that sets `selected.input` via its own selector, **When** the skill is
   dispatched, **Then** the host's values are used and no extraction runs.

---

### User Story 2 - A missing required field asks instead of dispatching (Priority: P1)

**Independent Test**: Declare a required field, run a turn omitting it, assert the handler
was never called and the reply asks for the value.

**Acceptance Scenarios**:

1. **Given** a bound skill with an unsatisfiable required field, **When** the directive
   matches, **Then** the handler is not called and the reply asks for the value.
2. **Given** that field declares choices, **When** the reply asks, **Then** the choices are
   presented.
3. **Given** several missing required fields, **When** the reply asks, **Then** it asks in
   one turn, not one question per field.
4. **Given** the user supplies the value next turn, **When** the directive matches again,
   **Then** the handler is called with it.
5. **Given** a parked turn, **When** the host inspects the result, **Then**
   `awaitingSkillInput` names the skill and the outstanding fields.
6. **Given** the user's answer still fails validation, **When** the turn completes,
   **Then** it parks again with a reason code and asks once more. There is no automatic
   retry loop inside one turn, and no silent give-up.

---

### User Story 3 - Extracted values are validated before they reach a handler (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a field declaring choices, **When** the model returns a value outside them,
   **Then** it is treated as missing and never passed.
2. **Given** a typed field, **When** the model returns an uncoercible value, **Then** it is
   treated as missing.
3. **Given** the model returns a key the skill did not declare, **When** the result is
   assembled, **Then** the extra key is discarded.
4. **Given** any rejected value, **When** the turn completes, **Then** the trace records the
   field and the reason, never the value.

## Requirements *(mandatory)*

### Contract

- **FR-001** `SkillDefinition.inputSchema` MUST become a concrete field declaration: per
  field a name, a scalar type, requiredness, an optional description, and an optional
  closed set of permitted values. No sibling descriptor field is added.
- **FR-002** FR-001 is a breaking change and MUST be migrated in the same slice.
  `toolToSkillDefinition` passes a raw transport schema straight through
  (`conversation-tools/src/skillBridge.ts`), fed by the MCP and OpenAPI adapters. Either
  project those into the normalized declaration deliberately, or keep raw transport schemas
  off `SkillDefinition.inputSchema`. It cannot be waved through as kit-only.
- **FR-003** Filling MUST be a distinct port the engine invokes between selection and
  dispatch, returning filled input, a parked needs-input decision naming the unsatisfied
  fields, or a failure. Not in the selector, which stays deterministic selection policy;
  not in the dispatcher, which would make every host own extraction.
- **FR-004** `ProcessTurnResult` MUST expose `awaitingSkillInput` as a list — one entry per
  skill parked this turn, each naming the skill and its outstanding fields with description,
  permitted values, and a reason code distinguishing "absent from the conversation" from
  "present but rejected by validation". It is forwarded through both the non-streaming and
  streaming result constructors. It reports this turn and is not durable state (D8); the
  engine MUST NOT resume from it.
- **FR-018** The declaration MUST support exactly the v1 scalar types in D9, and the
  resolver MUST emit canonical values for each. An implementation MUST NOT accept a type it
  cannot deterministically validate.
- **FR-019** Bounded history for extraction MUST have an explicit configurable limit with a
  documented default, owned by the resolver factory rather than by each host.

### Behavior

- **FR-005** The default implementation — prompt construction, parsing, coercion,
  validation, and the ready/needs-input/failed decision — MUST live in
  `conversation-defaults` and work with no backend present.
- **FR-006** Resolution for all selected skills MUST complete before any is dispatched,
  from one immutable pre-dispatch turn snapshot. If any resolves to needs-input or failed,
  none dispatch (D1).
- **FR-007** Extraction MUST be skipped when the selected skill declares no fields, or
  when host-supplied input already satisfies every declared field.
- **FR-008** Host-supplied values MUST take precedence, MUST NOT be shown to the model, and
  MUST be validated against the same declaration before being treated as satisfying it
  (D5).
- **FR-009** Every value MUST be validated against its declared type and permitted values;
  an invalid value is treated as missing and never passed to a handler. Coercion happens in
  the resolver so all hosts receive canonical values.
- **FR-010** A key the model returns that the skill did not declare MUST be discarded.
- **FR-011** When any required field is unsatisfied, the skill MUST NOT be dispatched and
  the turn MUST render one request covering all missing fields, presenting permitted values
  where declared.
- **FR-012** Extraction MUST be bounded by a deadline and MUST fail closed: on parse
  failure, deadline, or model error, no handler is dispatched and no partial input passed
  (D7).

### Safety

- **FR-013** User text is untrusted and becomes handler arguments. The prompt MUST separate
  instructions from conversation data, constrain output to declared fields, and grant no
  authority to add keys or alter host-supplied values. Only bounded history and the current
  message are included (D4).
- **FR-014** Extracted values MUST NOT appear in logs, traces, or telemetry. Field names,
  per-field outcome, and rejection reasons are observable; values are not.

### Compatibility

- **FR-015** A skill with no declared fields MUST behave exactly as today, with no added
  model call and no added latency.
- **FR-016** Routine `skill` steps MUST be unaffected; `inputBindings` remains their
  argument source.
- **FR-017** The streaming path MUST stay correct. It shares `prepareTurn` with the
  non-streaming path, so there is no duplicate loop; a parked turn MUST still emit a final
  stream event rather than failing with `conversation_stream_missing_final`.

## Success Criteria *(mandatory)*

- **SC-001** A kit skill declaring three fields, bound to a directive, receives all three
  from a single user message with no host-written parsing.
- **SC-002** A required field absent from the conversation produces a question and zero
  handler invocations.
- **SC-003** A value outside a field's declared choices never reaches a handler.
- **SC-004** Skills without declared fields show no behavior or latency change.
- **SC-005** All of the above run with no backend present.

## Explicitly cut from this slice

Untyped routine-step filling as a second consumer; author-controlled sourcing
(`source: customer | context | any`); nested objects, arrays, and locale-ambiguous date
interpretation; automatic MCP/OpenAPI schema projection into the declaration; any backend
adoption, persistence adapter, dashboard editor, or transport work; cross-skill input
dependencies within a turn (precluded by D1); and engine-owned resumption of a parked
request, including any exclusivity rule against `awaitingDecision` (D8).

Note what is *not* cut despite being adjacent: an unambiguous date type (D9) and the
`conversation-tools` migration (FR-002) are both required, because the first is the
conversion slot filling exists to do and the second is a compile break this slice causes.

## Minimum that cannot be cut

A concrete field declaration plus migration of its existing producer; the resolver port,
default implementation, and kit wiring; the two-phase engine plan; deterministic
validation and coercion of both extracted and host-supplied values with a declared-key
allowlist and fail-closed deadline behavior; the `awaitingSkillInput` result with one
normal composed reply and parity across `processTurn` and `processTurnStream`; and tests
for ready, missing, invalid choice, invalid type, host override with no model call,
multi-selection with no dispatch before all ready, and streaming final rendering.
