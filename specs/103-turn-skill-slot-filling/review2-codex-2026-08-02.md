# Review: 103 Turn Skill Slot Filling (kit-only rewrite)

## Verdict

**Do not approve unchanged.** The rescope correctly removes the backend blockers from
this feature, and the kit has the right raw seams.  But the spec currently describes a
directive-bound kit selector that does not exist, and FR-010 cannot be satisfied by
inserting a resolver at the stated point in the present loop.  It needs an explicit
two-phase resolve-then-dispatch plan and a first-class, skill-specific parked-result
type.  Those are kit work, not backend work.

## 1. Prior objections: resolved vs. surviving

### Genuinely resolved by the rescope

The following findings in the rejected draft were backend-host concerns and should not
be re-raised as blockers for this kit slice:

- Webhook skills not being directive-bindable, their blank action-turn reply, their
  `missing_input` short circuit, and the webhook/MCP alias mapping are all out of scope.
  A kit local handler is called directly by `createDefaultConversationSkillDispatcher`
  at `packages/conversation-kit/src/defaultPorts.ts:155-160`; there is no backend
  executor or transport mapping in this path.
- The backend's missing runtime join from `AgentSkillSpine` to persisted field
  declarations is gone.  The kit receives `SkillDefinition[]` directly in
  `CreateConversationKitOptions` (`packages/conversation-kit/src/composition.ts:79-83`)
  and passes those definitions to the engine (`:174-189`).  The selected name can be
  resolved back to that definition in the engine (`packages/conversation-engine/src/index.ts:563-576`).
- Backend chat-bridge persistence/rendering and direct-turn webhook idempotency are not
  requirements for an engine-plus-local-handler feature.  The engine does not introduce
  a handler retry loop today.  A host that makes its local handler externally
  side-effecting remains responsible for its own idempotency, exactly as before.
- Validation, missing-input, timeout/fail-closed behavior, prompt-boundary rules, and
  redacted tracing are now explicit P1 requirements (FR-007 through FR-014).  That fixes
  the first draft's attempt to ship unvalidated extraction by itself.

### Objections that survive at kit scope

1. **The Context has a factual error about kit selection.** It says
   `createDirectiveBoundSkillSelector` chooses a directive binding.  No such symbol
   exists in the listed kit/default/engine packages.  The kit's actual default selector
   reads only `input.turn.inputEvent.metadata.skillName` / `selectedSkills`
   (`packages/conversation-kit/src/defaultPorts.ts:36-42,81-100`).  Directive bindings
   are part of the contract (`packages/conversation-contract/index.d.ts:86-97,132-135`),
   and directive matches are passed to the selector (`:549-555`), but the kit supplies no
   selector which consults them.  Therefore the stated “bound to a directive” P1 story is
   not currently runnable with `createConversationKit` defaults.  Either add the
   directive-bound selector to this slice, or change the acceptance tests and Context to
   use a host-provided selector/metadata selection.  Do not claim it already exists.

2. **FR-002 has a real injection seam, but not the one-line implementation the wording
   implies.** `prepareTurn` has both `skill` and `selected` after selection
   (`packages/conversation-engine/src/index.ts:561-576`) and before dispatch
   (`:577-583`).  However, there is no resolver port in `ProcessTurnInput`
   (`packages/conversation-contract/index.d.ts:1086-1116`) and no resolver wiring in kit
   composition (`packages/conversation-kit/src/composition.ts:124-189`).  More
   importantly, inserting a resolver immediately before `:579` would violate FR-010;
   see section 3.

3. **“Host input already satisfies the field” is unsafe unless it means
   deterministically validated.** `SelectedSkill.input` is `unknown`
   (`packages/conversation-contract/index.d.ts:269-274`) and the local dispatcher passes
   any record through verbatim (`packages/conversation-kit/src/defaultPorts.ts:155-160`).
   FR-005/006 permit no model call for supplied input, but FR-007 only explicitly
   validates *extracted* values.  Define that host input wins on provenance, not on
   validation: validate it locally against the same declaration before calling it
   satisfied; never send it to the model; park/fail rather than dispatch if it is invalid.

4. **The parked result needs its own discriminant and must travel through both final
   result constructors.** `awaitingDecision` is currently routine-specific
   (`RoutineAwaitingDecision` has `stepId`, `options`, and `captureKey` at
   `packages/conversation-contract/index.d.ts:631-635`), and `ProcessTurnResult` merely
   forwards that type (`:1173-1192`).  A missing date or several arbitrary fields is not
   an external choice among `DecisionOption`s.  Add, for example,
   `awaitingSkillInput?: AwaitingSkillInput`, with `{ skillName, fields: [{ name,
   description?, permittedValues? }] }` (an array of per-skill requests if multi-select
   remains supported).  Thread it through `PreparedTurnRun`
   (`packages/conversation-engine/src/index.ts:314-320`) and both calls to
   `createProcessTurnResult` (`:1124-1131,1191-1201`).

5. **The timeout requirement lacks a cancellable gateway contract.**
   `ConversationModelGateway.complete` accepts only messages/system prompt/metadata
   (`packages/conversation-contract/index.d.ts:423-429`), not an abort signal or deadline.
   The resolver can race a timeout and fail closed, but cannot stop the provider call.
   That is acceptable for v1 only if FR-011 means “bound the turn's wait and never
   dispatch after timeout”; do not claim cancellation until the model port supports it.

## 2. FR-002 and streaming

The engine call site is suitable **after a small structural change**: selection ends at
`packages/conversation-engine/src/index.ts:536-559`; each selected item is resolved to a
`SkillDefinition` at `:563-576`; dispatch starts at `:577-583`.  The resolver belongs in
that section, not in the selector or the dispatcher.

`processTurnStream` does **not** duplicate selection/dispatch.  Both non-stream and
stream paths call `prepareTurn` (`packages/conversation-engine/src/index.ts:1105` and
`:1147`), which owns the selection-to-dispatch loop.  They only diverge when rendering:
`processTurn` calls `composer.compose` at `:1106-1112`; streaming calls
`composer.stream` at `:1153-1176`.  So FR-017 is not a duplicate-path trap.  It still
needs tests: the parked state must be forwarded to each final result, and the stream
composer must emit a response/final event rather than hit
`conversation_stream_missing_final` (`:1174-1176`).

## 3. FR-010 conflicts with the current sequential data flow

This is a real conflict, not a theoretical one.  Today the loop dispatches skill A,
pushes its outcome, and then gives skill B a different turn:

- B's `stagedContext` includes A's output via `mergeStagedContext(outcomes)` at
  `packages/conversation-engine/src/index.ts:572-575`.
- B's steering includes A's outcome guidance after it is appended at `:585-592`.

If the resolver is simply called inside that loop, extraction for B can see A's dispatch
output, but A has already side-effected before B can park.  That violates FR-010.  If all
resolution runs first, B cannot see same-turn A output/steering.  Both guarantees cannot
hold in one turn.

**Recommendation: FR-010 wins.** Build a resolution plan for every selected skill from
the same immutable pre-dispatch `selectedTurn` snapshot (`:529-533`), validate every
merged input, and only dispatch if every plan item is ready.  If any is needs-input or
failed, dispatch none.  State explicitly that same-turn skill outputs are unavailable to
slot filling; a flow that needs A's result as B's argument belongs in a routine or a
subsequent turn.  This is the only interpretation that meets the side-effect safety the
requirement claims.

## 4. The parked “needs input” turn and Open Question 1

Use `ProcessTurnResult.awaitingDecision` as the **result-shape precedent**, not as the
data model and not by reusing routine machinery.  `DefaultRoutineRunner` parks an authored
`await` graph step by storing `status: "suspended"`, rendering that step, and returning a
`RoutineAwaitingDecision` (`packages/conversation-engine/src/routineRunner.ts:713-752`).
That model requires a routine, a graph position, and a `captureKey`; it does not model
schema-governed free-form values for a selected turn skill.  Reusing it would distort the
domain.

**Open Question 1 — pick one model call plus normal composition.** No dedicated
missing-input prompt is needed.  The existing `ConversationTurnComposer` receives the
composed turn, outcomes, and selection decision
(`packages/conversation-contract/index.d.ts:593-605`); the kit's model composer includes
`turn.steering` in its system prompt (`packages/conversation-kit/src/defaultPorts.ts:195-217`)
and then generates the reply (`:220-244`).  Have the engine add a narrowly structured
skill-input request to composition (a synthetic steering instruction is sufficient for
this version, while `awaitingSkillInput` carries the machine-readable data).  It can
instruct the composer to ask for all missing fields and render closed choices.  The
resolver makes one extraction call; normal compose/stream makes the ordinary one reply
generation call.  `ConversationClarifier` is not sufficient: its
`phraseQuestion`/`mapReply` types accept `ClarificationCandidate[]` and return an option
id/decline/unrelated (`packages/conversation-contract/index.d.ts:435-442,511-531`), not
typed arbitrary values.

## 5. Existing machinery: reuse the semantics, not the component unchanged

The repository already has substantial routine slot work:

- `RoutineNextStepSelector` tells the model to extract every declared slot from the
  latest message in one pass (`packages/conversation-defaults/src/routineNextStepSelector.ts:32-42`),
  parses the `variables` object (`:87-104`), and allowlists declared slot keys
  (`:110-130`).  The runner explicitly invokes that selector as an extraction-only pass
  for a slot-collection step when deterministic transitions otherwise would not call the
  model (`packages/conversation-engine/src/routineRunner.ts:418-460`).  So yes: routine
  machinery already extracts declared typed-slot *values* from a message.
- It is not the required resolver.  Initial routine capture is only key-sanitized there;
  it does not coerce/validate each captured value.  The deterministic type validation is
  instead in `verifySlotCorrection` and is restricted to mutable post-completion
  corrections (`packages/conversation-engine/src/slotCorrection.ts:77-93`).
- `RoutineSlotCorrector` is narrower still: it detects one correction to a mutable slot,
  asks the model to normalize it, then lets the engine verify it
  (`packages/conversation-defaults/src/routineSlotCorrector.ts:62-115`).  Its
  confirm/reject prompts do establish useful redaction and re-ask patterns
  (`:117-152`), but it is not general initial filling.
- `DefaultClarifier` renders a lead-in plus a code-built option list and maps replies to
  candidate IDs (`packages/conversation-defaults/src/clarifier.ts:236-274`).  It cannot
  capture field values.

The mistake would be to create a second independent JSON parser, prompt discipline, and
scalar coercer.  Extract the shared *field normalization/validation* primitive (or make
the new resolver own it and migrate routine correction to it in a later dedicated
refactor), but do not make a routine selector impersonate a selected-skill resolver:
`RoutineSlotSchema` has a different contract (`id`, `key`, `mutable`, no choices at
`packages/conversation-contract/index.d.ts:737-747`).

## 6. Open questions — decisions

1. **One extraction call plus normal composition; no dedicated ask prompt.** Add a
   skill-input request to the compose turn and an `awaitingSkillInput` result field, as
   described above.  Do not overload `ConversationClarifier`.
2. **Use bounded conversation history plus the current message, never staged context,
   metadata, or host values.** This matches the existing defaults' conversation input
   pattern (`routineNextStepSelector.ts:19-22`), enables a value supplied earlier to be
   recovered, and keeps the prompt's untrusted-data surface explicit.  Label history as
   data and keep declared fields/instructions in the system prompt.
3. **Defer untyped routine skill steps.** They already have a separate argument contract:
   `RoutineStep.inputBindings` and `ConversationRoutineSkillDispatcher`
   (`packages/conversation-contract/index.d.ts:650-675,820-834`).  A second caller makes
   this slice materially larger and risks conflating two lifecycle models.
4. **Defer author-controlled sourcing.** V1 extracts only conversation history/current
   user text.  Host-supplied selected input is immutable to the model and is not included
   as a fillable field.  No `stagedContext` or arbitrary resolved context enters the
   extraction prompt.
5. **Re-ask on every selected invocation with an invalid/missing required value; do not
   dispatch and do not silently give up.** Return `awaitingSkillInput` with all remaining
   fields and a reason code, render one new question, and let the host apply any product
   retry/abandonment policy.  There is no automatic loop within a single turn.

## 7. Make the slice shippable

Cut now:

- untyped routine-step filling (Open Question 3);
- author-controlled context sourcing;
- complex/nested objects, arrays, locale-ambiguous date interpretation, and automatic
  MCP/OpenAPI JSON-Schema projection;
- any backend adoption, persistence adapter, dashboard/editor, or transport work;
- changing ordinary multi-skill sequencing semantics beyond the safe FR-010 resolution
  plan.  Do not promise cross-skill input dependencies in this slice.

The minimum that cannot be cut is:

1. a concrete, normalized field declaration and migration of its existing producer;
2. a `ConversationSkillInputResolver` port, default implementation, kit composition
   wiring, and a two-phase engine plan;
3. deterministic validation/coercion of both extracted and host-supplied values, an
   allowlist of declared keys, and fail-closed timeout/error behavior;
4. a distinct `awaitingSkillInput` result plus one normal composed reply, with parity in
   `processTurn` and `processTurnStream`;
5. focused tests for ready, missing, invalid choice/type, host override/no model call,
   multi-selection/no dispatch before all ready, and streaming final rendering.

## 8. FR-001 is a breaking contract change

**Yes.** The sole bridge that writes a tool schema onto `SkillDefinition` passes an
arbitrary `unknown` through unchanged:

- `toolToSkillDefinition` sets `inputSchema: tool.inputSchema` at
  `packages/conversation-tools/src/skillBridge.ts:130-153`.
- Its source type is `inputSchema?: unknown` at
  `packages/conversation-tools/src/types.ts:17-24`.
- Dynamic MCP and OpenAPI adapters populate that source with raw transport schemas at
  `packages/conversation-tools/src/mcpAdapter.ts:185-196` and
  `packages/conversation-tools/src/openApiAdapter.ts:241-253`.

Changing `SkillDefinition.inputSchema?: unknown` (`packages/conversation-contract/index.d.ts:201-208`)
to a concrete kit field declaration will therefore fail type checking at the bridge and
make existing MCP/OpenAPI schemas invalid, even though the backend is out of scope.  The
slice must either migrate `conversation-tools` to a deliberate normalized projection or
keep raw transport schemas out of `SkillDefinition.inputSchema` via a separately versioned
compatibility design.  FR-001's “no sibling descriptor” rule means the former is the
honest path; it cannot be waved away as a kit-only non-breaking change.

## Required spec edits before approval

1. Correct the nonexistent `createDirectiveBoundSkillSelector` claim and explicitly
   include its implementation or narrow P1 to host-selected skills.
2. Specify the resolver's contract and two-phase resolution algorithm, including the
   immutable turn snapshot and all-selected-skills failure/park behavior.
3. Define `AwaitingSkillInput`, result/compose propagation, and host persistence
   responsibility; do not reuse `RoutineAwaitingDecision` or clarification mapping.
4. State host-input validation, v1 supported scalar types, timeout semantics, and the
   `conversation-tools` migration required by FR-001.
