# Feature Specification: Turn Skill Slot Filling

**Feature Branch**: `103-turn-skill-slot-filling`
**Created**: 2026-08-02
**Status**: Draft — NOT approved. Codex spec review (2026-08-02) rejected the first
draft; the Context section below is corrected, but the scope fork in Open Question 6 is
unresolved and the release blockers in "Deferred to the rewrite" are not yet written as
requirements.
**Input**: User description: "A skill declares the fields it needs. At turn level nothing fills them from the conversation, so a declared field like `calendar_date` is dropped and the webhook fires with an empty body. Fill declared skill fields from the conversation with a single model call. Mechanics belong in the kit packages; the backend does the calling and receiving."

## Context

A skill already declares the fields it expects. Webhook skills store them as
`exposedPayload` — a map of field name to `{ description?, slotBinding?, required }` —
and external MCP skills store the parallel `exposedParams`. Authors write these through
the dashboard or the API; there is no function signature to derive them from, and there
will not be one, because a skill can be a webhook declared entirely through the UI.

At turn level those declarations are never shown to a model. They are used as a lookup
filter against a fixed four-key envelope built from the prepared session — `query`,
`message`, `pageContext`, `context`. A declared field whose name is not one of those four
resolves to `undefined` and is silently omitted from the dispatch payload. An author who
declares `calendar_date`, `person_gender` and `haircut_style` gets none of them.

`SelectedSkill.input` exists in the conversation contract and the engine already passes it
to the dispatcher, but no selector populates it and the backend dispatcher discards it
(`conversationEngineChatTurn.ts:159-166`, and again on the stream path at `:242-249`).

### Two corrections to the first draft, verified against the code

The first draft motivated this with a webhook skill firing an empty request body. That is
wrong twice over, and the corrections narrow the problem:

1. **Webhook skills cannot claim a turn today.** `TURN_BINDABLE_KINDS` is
   `{"external_mcp"}` (`agentSkillTurnSkillProvider.ts:47-54`). Action kinds — webhook,
   slack, email, notify — are deliberately excluded because they settle with outputs and
   no answer text, which would render a blank reply through the generic outcome renderer.
   Turn-level slot filling is therefore only *reachable* today on the MCP path.
2. **A webhook never fires with missing required fields.** `webhookSkillExecutor` builds
   the payload, checks `missingInputs`, records the destination `skipped`, and returns
   `missing_input` before resolving a destination or constructing a request
   (`webhookSkillExecutor.ts:69-81`). The block-before-fire guard this spec proposes as
   US2 already exists for webhooks at the executor level. The unguarded empty-input call
   is the MCP path.

The consequence is that "fill declared fields" and "let an action skill claim a turn" are
two separate features, and the first draft conflated them. This spec covers the first.
Whether the second is a prerequisite for shipping value is Open Question 6.

A third finding is load-bearing for the design: the field declaration is not available at
the runtime skill-definition boundary at all. `runtimeSkillDefinitionForAgentSkill` builds
a definition from `AgentSkillSpine`, which carries no `exposedPayload` or `exposedParams`;
each transport executor re-queries its own store by name at dispatch time
(`webhookSkillExecutor.ts:60-69`, `mcpSkillExecutor.ts:106-123`). Nothing that runs before
dispatch can see what fields a skill wants. That plumbing is a prerequisite for any
extractor, whatever its scope.

Routines are not affected. A routine `skill` step already resolves authored
`inputBindings` (literal / routine variable / turn context variable) through
`resolveSkillArguments`, and that path stays as it is.

### What this feature deliberately does not change

Skill **selection** stays authored and deterministic. A matched directive's binding picks
the skill; the model never chooses, vetoes, or substitutes a skill. This feature gives the
model exactly one job: given one already-chosen skill's declared fields, produce values
for them. Parlant folds applicability and argument inference into a single generation and
lets the model answer `should_run`; we deliberately keep applicability out, because
selection is already settled before this runs.

Out of scope, tracked separately: re-firing and call deduplication across turns, directive
lifecycle interaction with bindings, capability policy as a contract port, and unifying
the two stored declaration shapes into one persisted schema.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A declared field is filled from the conversation (Priority: P1)

An agent builder declares a webhook skill with the fields their endpoint needs, binds it
to a directive, and the fields arrive populated from what the visitor said.

**Why this priority**: This is the entire feature. Without it, every declared field beyond
the four envelope names is dropped and the skill is effectively uncallable.

**Independent Test**: Declare a webhook skill with a required `calendar_date` field, bind
it to a directive, send a message stating a date, and assert the delivered payload
contains the date.

**Acceptance Scenarios**:

1. **Given** a bound skill declaring `calendar_date` (required) and `haircut_style`
   (optional, with choices), **When** a visitor message supplies both, **Then** the
   dispatch payload contains both values and the optional value is one of the declared
   choices.
2. **Given** the same skill, **When** the visitor supplies only the required field,
   **Then** the skill is dispatched with the required field and the optional field absent.
3. **Given** a skill whose declared fields are all satisfied by author-fixed values
   (`boundPayload`), **When** the skill is selected, **Then** no extraction call is made.
4. **Given** a skill declaring no fields, **When** the skill is selected, **Then** no
   extraction call is made.

---

### User Story 2 - A missing required field asks instead of firing (Priority: P1)

When the conversation does not contain a required value, the turn asks the visitor for it
rather than calling the endpoint with a hole in the payload.

**Why this priority**: Firing a side-effecting call with missing required data is worse
than not firing. This is a correctness guard, not a nicety, and it ships with US1.

**Independent Test**: Declare a required field, send a message that does not supply it,
and assert the skill was not dispatched and the reply asks for the value.

**Acceptance Scenarios**:

1. **Given** a bound skill with a required field the conversation does not supply,
   **When** the directive matches, **Then** the skill is not dispatched and the reply asks
   the visitor for that value.
2. **Given** that field declares choices, **When** the reply asks for it, **Then** the
   choices are presented to the visitor.
3. **Given** several required fields are missing, **When** the reply asks, **Then** it asks
   about them in one coherent turn rather than emitting one question per field.
4. **Given** a visitor supplies the value on the following turn, **When** the directive
   matches again, **Then** the skill dispatches with the value.

---

### User Story 3 - Extracted values are validated against the declaration (Priority: P2)

A value the model produces that does not fit the declared shape never reaches the
endpoint.

**Why this priority**: An unvalidated value is the failure mode that makes operators
distrust the feature; it is separable from US1 only because US1 is testable without it.

**Acceptance Scenarios**:

1. **Given** a field declaring choices, **When** the model returns a value outside them,
   **Then** the value is rejected and treated as missing rather than sent.
2. **Given** a typed field, **When** the model returns a value that cannot be coerced to
   that type, **Then** the value is rejected and treated as missing.
3. **Given** a rejected value, **When** the turn continues, **Then** the trace records the
   field, the rejected value, and the reason.

---

### User Story 4 - The author controls what the model may invent (Priority: P3)

Some fields must come from the visitor and must never be guessed; others are supplied by
the host from session context.

**Acceptance Scenarios**:

1. **Given** a field marked as visitor-supplied, **When** the conversation does not state
   it, **Then** it is treated as missing rather than inferred.
2. **Given** a field marked as context-supplied, **When** the turn runs, **Then** its value
   comes from turn context and it is never offered to the model for extraction.

## Requirements *(mandatory)*

### Functional

- **FR-001** A skill field declaration MUST carry, in addition to today's name,
  description and required flag: a type, and an optional closed set of permitted values.
- **FR-002** The system MUST render a selected skill's field declarations into an
  extraction prompt, one entry per field, including the permitted values where declared.
- **FR-003** Extraction MUST run as a single model call per turn covering the selected
  skill's fields. It MUST NOT ask the model whether the skill should run.
- **FR-004** Extraction MUST be skipped entirely when the selected skill declares no
  fields the model needs to fill.
- **FR-005** Author-fixed values MUST take precedence over extracted values, and a
  context-supplied field MUST NOT be offered to the model.
- **FR-006** An extracted value MUST be validated against its declared type and permitted
  values; an invalid value MUST be treated as missing, never dispatched.
- **FR-007** When any required field is unfilled after extraction and validation, the
  skill MUST NOT be dispatched, and the turn MUST ask the visitor for the missing values.
- **FR-008** The ask MUST present the permitted values for a missing field that declares
  them, and MUST cover multiple missing fields in a single turn.
- **FR-009** Filled values MUST reach the skill in place of the fixed envelope, and the
  existing envelope keys MUST remain available to skills that declare them.
- **FR-010** Extraction outcome MUST be observable per turn: which fields were requested,
  filled, rejected (with reason), and missing. Field values are conversation content and
  MUST NOT be logged.
- **FR-011** Routine skill steps MUST be unaffected; `inputBindings` remains their
  argument source.
- **FR-012** A skill with no declared fields MUST behave exactly as it does today.

### Boundary

- **FR-013** Extraction mechanics — the declaration shape, prompt construction, response
  parsing, validation, and the missing-field decision — MUST live in the conversation
  packages and be usable by the standalone kit with no backend dependency.
- **FR-014** The backend MUST supply the declaration data and perform the transport
  (webhook call, MCP call) through the existing ports.
- **FR-015** The webhook and external-skill stored declaration shapes MUST both map into
  one shared field descriptor that the extractor consumes. Their persistence may stay
  separate; the shared descriptor is the boundary.

### Non-functional

- **NFR-001** A turn that selects a skill with no fillable fields MUST NOT incur added
  model latency.
- **NFR-002** The extraction call MUST NOT be made before skill selection has settled.

## Success Criteria *(mandatory)*

- **SC-001** A webhook skill declaring three fields, bound to a directive, receives all
  three populated from a single visitor message.
- **SC-002** A required field absent from the conversation produces a question to the
  visitor and zero outbound calls to the endpoint.
- **SC-003** No skill without declared fields changes behavior or latency.
- **SC-004** The standalone kit can fill a declared field with no backend present.

## Open Questions

1. **Where the declaration lives in the contract.** `SkillDefinition.inputSchema` exists
   but is typed `unknown` and is never populated on the Radioso path. Does the shared
   descriptor replace it, or sit beside it?
2. **Whether the ask is a first-class turn outcome.** The engine has a clarification
   concept already; is a missing required field a clarification, or a distinct outcome the
   composer renders?
3. **Whether type coercion belongs in the extractor or the transport.** Returning all
   values as strings and coercing after validation is simpler to prompt for, but pushes
   date and number parsing into a shared helper.
4. **Whether MCP-derived skills auto-populate the descriptor** from the tool's published
   JSON Schema in this slice, or whether this slice covers hand-declared webhook fields
   only and MCP follows.
5. **UI scope.** Authors need somewhere to enter type and permitted values. Is that in
   this slice or a follow-up?
6. **Which invocation sites does slice 1 wire?** Slot filling is a property of the skill
   input contract, not of a transport. Its consumers are every site that dispatches a
   skill: turn skills (no filling mechanism at all) and routine `skill` steps in untyped
   mode (specced as model-filled in 090, never implemented — an untyped step passes the
   routine's whole variable bag instead). The mechanics are identical; only the wiring
   differs. Does slice 1 wire the turn site, the routine site, or both?

## Deferred to the rewrite

The Codex review (`.context/spec-103-codex-review.md`) identified release blockers this
draft does not yet state as requirements. They are recorded here so the rewrite cannot
silently drop them:

- **Streaming.** The stream composer takes `outcomes[0]` unconditionally
  (`conversationEngineChatTurn.ts:258-264`); a turn that asks for input and dispatches
  nothing would render nothing or throw. Stream and non-stream must persist identical
  pending state.
- **Multiple selected skills.** `SelectedSkill[]` is a list and the engine dispatches each
  in sequence. All validation must complete before *any* side effect — never fire skill A
  then discover skill B lacks a required field.
- **Non-binding selection.** A skill selected by host override or `forced_turn_skill` must
  get the same input contract, extraction, validation and block-before-fire behavior.
  Extraction keys off the selected skill, not off binding metadata.
- **Extraction failure.** Bounded timeout, cancellation, and a fail-closed outcome. No
  outbound call on parse failure, timeout, model outage, or cancellation.
- **Prompt injection.** Visitor text is untrusted and the extracted result becomes an
  outbound HTTP/MCP body. Schema-constrained output, no model authority to add keys or
  alter author-fixed values, an allowlisted input view, and no blanket inclusion of the
  resolved context snapshot in the prompt.
- **Idempotency.** A retried turn must not double-fire a side-effecting skill.
- **Authored aliases.** The extractor returns canonical field names; both transports must
  keep their `slotBinding ?? key` mapping or FR-009 quietly breaks existing aliases.

US3 (validation) moves to P1 in the rewrite: US1 cannot safely ship without it when the
output triggers an outbound side effect.
