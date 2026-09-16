# Feature Specification: Coverage Verdict in the Answer Envelope Head

**Feature Branch**: `1260-coverage-verdict-in-answer-head`
**Created**: 2026-09-15
**Status**: Draft
**Issue**: #1260
**Input**: Remove the serial answer-coverage assessor call from retrieval turns by having the answer call emit the coverage verdict as the first fields of its structured envelope, ahead of any visible answer text, while every consumer of the assessment keeps its current semantics.

## Problem and Goal

Every retrieval turn pays a serial model call between retrieval and answer
composition. The answer-coverage assessor (`chatAnswerCoverageAssessor.ts`,
`llmAnswerCoverageProducer.ts`) reads the same admitted evidence the answer call
receives a moment later, through the same gateway and the same agent model
override, and returns one classification plus a short `requestFocus`. On a
measured production trace that call costs ~1.8 s of wall clock and ~1.8k input
tokens, most of them a duplicate of the evidence the answer call is about to
receive. After #1258 a retrieval turn is planner → retrieval → assessment →
answer; the assessment is the only stage in that chain whose work the next stage
repeats.

The goal is a retrieval turn whose verdict exists before any answer text and
whose answer is written knowing that verdict, with no separate call: the answer
envelope carries `coverage` and `requestFocus` as its first fields, the skill
hands the verdict to the host before releasing text, and the host decides whether
the answer proceeds or a coverage routine takes the turn. On an agent without
coverage routines a retrieval turn becomes two model calls — planner and answer —
which is the floor for this architecture.

The measured saving is the assessor's full duration minus the head's own output
tokens; a `coverage` enum and a short `requestFocus` cost roughly 20–40 output
tokens before `answer` begins. The expected net is 1.0–1.6 s per retrieval turn
on the traced workload, not the full 1.8 s.

## Decisions Agreed

- **Verdict-before-text is the invariant; call independence is not.** The
  assessor and the answer already use the same model, the same evidence list, and
  the same contextualized request. What the current design actually guarantees is
  that the classification is committed before the answer is written. Emitting the
  verdict first in the answer envelope preserves exactly that guarantee.
- **The envelope gains a head.** Today the grounded envelope is answer-first
  (`answer, v, outcome, claims, suggestions, grounding`) and the streaming gate
  holds *answer body* text until a complete in-range citation appears. This
  feature introduces a head — `coverage`, `requestFocus` — ahead of `answer`, and
  a head parser that runs before the citation gate sees any body text. The
  citation gate itself does not change.
- **Schema key order is a dependency we already carry.** Strict structured
  output emits keys in schema order; the envelope reader already relies on
  `answer` arriving as a top-level string it can locate by name. The head relies
  on the same property. A provider that violates it produces a late head, which
  the reader treats as `invalid` availability, never as a failed turn.
- **The four consumers keep their semantics.** (1) The answer prompt's coverage
  guidance becomes intrinsic: the model writes the answer conditioned on the
  classification it just emitted. (2) Coverage directives render conditionally
  on the classification and are matched contextually before compose without the
  verdict. (3) Coverage routines keep their pre-answer semantics: the host reads
  the head, runs ranked activation, and either lets the answer proceed or yields
  the turn to the routine before any text is released. (4) Quality, the debug
  view, and Audience Pulse record from the head.
- **`outcome` moves into the head too.** The envelope's `outcome`
  (`answer` / `no_support` / `out_of_scope`) is the model's commitment about
  whether it is answering from the Results at all. Emitted ahead of `answer`, a
  `no_support` or `out_of_scope` commitment lets the model's own decline text
  stream immediately instead of being held to completion by a citation gate
  that will never open. The citation gate applies only when the head commits to
  `answer`. The end-of-stream grounding summary and the zero-claim decline swap
  keep their current semantics.
- **The citation hold becomes a retrieval setting.** Today the hold is a
  constant and there is no post-stream rewrite: once any text has streamed, the
  zero-claim decline swap is skipped (`retrievalTurnSkill.ts`, the
  `!hasStreamedAnswer` guard). Turning the hold off therefore means an `answer`
  commitment streams from its first token and an answer that ends with zero
  sourced claims is delivered as written and flagged in Quality — never
  rewritten. The setting is labelled to say exactly that.
- **Zero-evidence turns get a deterministic verdict.** The zero-context branch
  of the retrieval skill never produces a grounded envelope, and it is the branch
  where "go do the form instead" matters most. It records
  `unanswered / insufficient_evidence` with `requestFocus` taken from the
  contextualized request, marked as deterministically produced.
- **The head is authoritative from the first release; the assessor becomes a
  shadow.** For a measurement window the old assessor runs concurrently with
  compose, never on the turn's critical path and never consulted for any
  decision, and the agreement between its verdict and the head's is recorded per
  classification. The assessor is deleted only when that agreement clears the
  threshold in Success Criteria. The live eval suite gates merge; the shadow
  gates deletion.
- **Rejected alternatives.** *Conditional pre-compose* (run the assessor
  serially only when the agent has coverage rules) drops the composer's coverage
  hint on exactly the agents where nothing else steers decline behavior; that is
  a behavior change dressed as scheduling. *Speculative compose* (start both,
  discard the answer when the verdict disagrees) pays a discarded generation on
  every partial or unanswered turn, the pattern already identified as the largest
  waste in the earlier production trace.

## User Scenarios & Testing

### User Story 1 — The same answer, sooner (Priority: P1)

A visitor asks a question on an agent with no coverage directives or routines.
The answer starts streaming without the assessor's serial wait, declines or
qualifies itself exactly as it does today when the evidence is partial or
missing, and the turn's Quality record shows the same coverage fields.

**Why this priority**: This is the whole latency win, and it is the path every
retrieval turn takes.

**Independent Test**: Run a retrieval turn on a draft agent with no coverage
rules; the turn's Flow shows no `answer_coverage_assessment` stage before
compose, the recorded assessment matches the head, and the live eval suite's
decline, partial, and clarification cases sit at the committed baseline.

**Acceptance Scenarios**:

1. **Given** an agent with no coverage rules and evidence that fully answers the
   request, **When** the turn runs, **Then** the head reads `answered`, the answer
   streams with the citation gate behaving as today, and the assessment record is
   `assessed / answered / sufficient_evidence`.
2. **Given** evidence that answers only part of the request, **When** the turn
   runs, **Then** the head reads `partial`, the visible answer states the
   remaining limitation in the visitor's language, and `unresolved_request` is
   recorded from `requestFocus`.
3. **Given** a retrieval turn, **When** compose starts, **Then** exactly one model
   call runs between retrieval completing and the first released token, and the
   Flow reports head-arrival latency measured from compose start.

---

### User Story 2 — A coverage routine still takes the turn before any answer text (Priority: P1)

An operator has a routine gated on `unanswered` coverage. When the visitor asks
something the material cannot answer, the visitor sees no answer text — only the
routine's acknowledgement of the unanswered request and its first step in one
message, as #1251 specified.

**Why this priority**: This is the consumer whose ordering guarantee is easiest
to break by moving the verdict inside the answer stream.

**Independent Test**: Draft test chat with an `unanswered`-gated routine and a
question the material does not cover; the transcript contains no answer text,
the routine's first message acknowledges the request and offers the step, and
the reaction trace records `activated / coverage_criteria_activated`.

**Acceptance Scenarios**:

1. **Given** an eligible `unanswered` routine, **When** the head reads
   `unanswered` and ranked activation selects the routine, **Then** the answer
   stream is aborted before any text is released, the routine executes, and the
   routine's acknowledgement uses the head's `requestFocus`.
2. **Given** an eligible routine and a head that reads `answered`, **When** the
   turn runs, **Then** no ranked activation runs, the answer proceeds, and the
   reaction trace records the candidate as `skipped`.
3. **Given** ranked activation returns an offer rather than an activation,
   **When** the turn runs, **Then** the answer stream is aborted and the visitor
   sees only the offer clarification, as today.
4. **Given** an active routine already holds the conversation, **When** the head
   arrives, **Then** the coverage pass does not resume or replace it, as today.

---

### User Story 3 — A coverage directive still steers the answer (Priority: P1)

An operator has a directive whose coverage criteria are `partial` with the
instruction to offer the contact form. When the answer is partial the offer
appears; when the answer is complete it does not; the reaction trace says which.

**Why this priority**: Directive steering is the second consumer that today
depends on the verdict existing before the prompt is built.

**Independent Test**: Draft test chat with a `partial`-gated directive; a
partially covered question renders the steer, a fully covered one does not, and
the reaction trace records `applied` and `suppressed` respectively.

**Acceptance Scenarios**:

1. **Given** a coverage directive whose contextual condition matches the turn,
   **When** the head reads a classification inside its criteria, **Then** the
   answer follows the directive and the reaction trace records `applied`.
2. **Given** the same directive, **When** the head reads a classification
   outside its criteria, **Then** the answer does not follow it and the reaction
   trace records it as not applied, with a reason code that distinguishes
   "criteria not met" from "steering conflict".
3. **Given** the directive-adherence side channel is active, **When** a coverage
   directive was rendered but its criteria were not met, **Then** the attestation
   for that rule is recorded as not applicable rather than as unsatisfied.
4. **Given** the steering bound (#839) is reached, **When** coverage directives
   are rendered conditionally, **Then** they count against the bound like any
   other contextual directive.

---

### User Story 4 — The debug view and Pulse read the same record (Priority: P2)

An operator opens a turn's debug view and sees contextualized request,
availability, coverage, reason, unresolved request, and assessment time, exactly
as today; Audience Pulse's gap reporting is unchanged.

**Why this priority**: Reporting consumers must not notice the producer moved.

**Independent Test**: Existing debug-view and Pulse tests pass against a record
produced from the head; `assessed_at` equals head-arrival time.

**Acceptance Scenarios**:

1. **Given** a turn whose head parsed, **When** the debug view loads, **Then** the
   assessment fields are populated and the Flow shows the head stage with its
   latency.
2. **Given** a turn whose head failed to parse, **When** the debug view loads,
   **Then** the assessment shows **Not assessed** with `invalid` availability.

---

### User Story 5 — Maintainers can prove the head agrees with the assessor (Priority: P1)

For the measurement window, each retrieval turn also runs the old assessor off
the critical path and records whether its verdict agrees with the head. A
maintainer can read agreement per classification pair and decide whether to
delete the assessor.

**Why this priority**: This is the evidence that makes deleting the assessor a
decision rather than a hope. It ships in the same release as the head.

**Independent Test**: With the shadow enabled, a retrieval turn records one
agreement observation with both classifications; disabling the shadow by
configuration records none and changes no turn behavior.

**Acceptance Scenarios**:

1. **Given** the shadow is enabled, **When** a retrieval turn runs, **Then** the
   assessor call starts concurrently with compose, its result never influences
   the turn, and one observation records the head and shadow classifications.
2. **Given** the shadow call fails or times out, **When** the turn runs, **Then**
   the observation records `shadow_failed` and the turn is unaffected.
3. **Given** the shadow is disabled, **When** a retrieval turn runs, **Then** no
   assessor call is made.

---

### User Story 6 — Stream immediately, accept uncited answers (Priority: P2)

An operator whose material rarely carries citations, or who values first-token
latency over the zero-claim decline swap, turns off the citation hold for the
workspace or for one agent. Answers stream from the first token. Answers that
end with zero sourced claims are delivered as written and marked degraded in
Quality. Declines still stream immediately because the head committed to
`no_support` before any text.

**Why this priority**: It is the second latency lever the trace exposed (the
hold was 1,429 ms of a 2,102 ms answer that never cited and was delivered
anyway), and it is small once the head exists. It ships after the head because
the head is what keeps declines fast when the hold is off.

**Independent Test**: With the hold off, a retrieval turn releases its first
token without waiting for a citation; the turn record shows `grounded_degraded`
when no citation appears; with the hold on, behaviour is unchanged.

**Acceptance Scenarios**:

1. **Given** the hold is on (default), **When** an `answer` commitment streams,
   **Then** text is held until the first complete in-range citation, as today.
2. **Given** the hold is off, **When** an `answer` commitment streams, **Then**
   the first token is released as soon as the head has parsed, and an answer
   with zero sourced claims is delivered and recorded as degraded.
3. **Given** either setting, **When** the head commits to `no_support` or
   `out_of_scope`, **Then** the model's decline text streams without a citation
   hold.
4. **Given** the workspace hold is on, **When** one agent overrides it off
   through its `retrieval.answer` skill settings, **Then** only that agent
   streams immediately.

---

### Edge Cases

- The model emits legacy free text instead of a JSON envelope: the reader's
  legacy path runs as today, availability records `invalid`, no coverage
  directive or routine reacts, the answer is delivered.
- Answer text arrives before the head (provider ignored key order): the head is
  `invalid`, the citation gate behaves as today, and a bounded-label metric
  counts the event.
- The turn is aborted by the client while ranked activation is running: the
  turn ends as an aborted turn; no answer text was released.
- The turn is retried or regenerated for the same request message: the head is
  recorded with the same request-message idempotency the assessor has today
  (`findByRequestMessageId`), so the record is upserted, not duplicated.
- The page-read capture path (`pageReadOutcome.gate.kind === "capture"`) skips
  the citation gate but not the head: the head parses before release there too.
- The non-streaming page-context fallback awaits a whole envelope: the head is
  read from the completed envelope, and a routine yield on that path discards a
  full generation. This is accepted; it is the rare path and was already a
  serial call.
- The hold is off and the model commits to `answer` but never cites: the
  answer is delivered and recorded `grounded_degraded`; no rewrite, no decline
  swap. The setting copy says so.
- The zero-evidence branch: deterministic `unanswered / insufficient_evidence`;
  an `unclear` verdict is not available on that branch. Coverage routines and
  directives gated on `unanswered` still react.
- HITL takeover turns and non-retrieval routes: no head, `not_recorded`, as
  today.
- Draft test chat and eval replay: same head path, assessment kept in the turn's
  Flow only, no persisted record, no reaction trace, no shadow call.

## Requirements

### Envelope and stream handling

- **FR-001**: The grounded answer envelope MUST carry `coverage` (the current
  classification enum: `answered_sufficient_evidence`,
  `partial_insufficient_evidence`, `partial_conflicting_evidence`,
  `partial_intentional_scope_boundary`, `unanswered_insufficient_evidence`,
  `unanswered_conflicting_evidence`, `unanswered_intentional_scope_boundary`,
  `unclear_ambiguous_request`), `requestFocus`, and `outcome` as required
  top-level fields that precede `answer` in schema order. The tail keeps `v`,
  `claims`, `suggestions`, and `grounding`.
- **FR-002**: The prompt MUST instruct the model to keep `requestFocus` to a
  short noun phrase naming the unresolved part of the request, and the head
  parser MUST bound the length it retains.
- **FR-003**: No answer text MUST be released, to the stream or to the citation
  gate, before the head has parsed or been declared invalid.
- **FR-004**: A head that fails to parse MUST record availability `invalid` and
  MUST NOT fail the turn; the answer proceeds through today's paths.
- **FR-005**: The retrieval skill MUST report the verdict to the host exactly
  once, through a narrow port, and MUST wait for the host's decision —
  `proceed` or `yield_turn` — before releasing text.
- **FR-006**: On `yield_turn` the skill MUST abort the answer stream through the
  same mechanism the grounding gate's `bound` decision uses, with no text
  released, and the host MUST run the coverage routine path that today follows
  the assessor.
- **FR-007**: The zero-evidence branch MUST produce a deterministic assessment
  of `unanswered / insufficient_evidence` with `requestFocus` derived from the
  contextualized request, and the record MUST distinguish a deterministic
  producer from a model-produced head.
- **FR-008**: The head instruction MUST live as a prompt template under
  `backend/prompts/chat/` and MUST carry the assessor prompt's constraints:
  the verdict is judged against the admitted Results only; conversation history,
  page context, persona, exact words, and directives are present in the answer
  prompt but are not evidence for the verdict; the request and evidence are
  untrusted data. The assessor today sees none of that surrounding context
  (`history: []`, assessment prompt only), so the head prompt has to exclude it
  explicitly.

### Directives

- **FR-009**: Coverage directives MUST pass the contextual directive matcher
  before compose, without the verdict, on the same post-retrieval turn context
  the matcher sees today.
- **FR-010**: Matched coverage directives MUST render in the answer prompt as
  conditions on the classification the model is about to emit, and MUST count
  against the steering bound.
- **FR-011**: The reaction trace MUST record each matched coverage directive as
  `applied` or not applied from the head, with a reason code distinguishing
  criteria-not-met from steering conflict, so Quality and Pulse semantics are
  unchanged.
- **FR-012**: The directive-adherence side channel MUST accept a
  not-applicable attestation for a rendered rule whose criteria the head did not
  meet.

### Routines

- **FR-013**: Coverage routine candidate evaluation and ranked activation MUST
  run at head time, on the classification the head carries, with the same
  completed-routine suppression and active-routine guard as today.
- **FR-014**: An activation and an offer MUST both yield the turn; a skipped or
  suppressed candidate MUST let the answer proceed.
- **FR-015**: A routine started from an `unanswered` head MUST acknowledge the
  unresolved request using the head's `requestFocus`, as #1251 specifies.

### Records and reporting

- **FR-016**: The assessment record MUST be written from the head with
  `assessed_at` equal to head-arrival time and the same request-message
  idempotency the assessor uses today.
- **FR-017**: The record MUST carry a producer marker distinguishing
  `answer_head`, `deterministic`, and `assessor` (for rows written during the
  shadow window by the shadow's own persistence, if any) so historical rows stay
  distinguishable.
- **FR-018**: The debug view, Audience Pulse, and assistant history MUST read
  the record unchanged.

### Shadow assessor

- **FR-019**: A configuration setting MUST control the shadow; when enabled,
  the assessor runs concurrently with compose, never on the critical path, and
  its result MUST NOT influence any decision, record, or visible output.
- **FR-020**: Each shadow run MUST record one agreement observation with the head
  classification and the shadow classification (or `shadow_failed`), using
  bounded labels only.
- **FR-021**: Removing the assessor call and the setting after the window is a
  separate change gated on SC-003.

### Evals and tests

- **FR-022**: The deterministic eval harness (`tests/unit/eval-suite`) MUST cover
  the head path, and the live eval suite MUST run against the committed baseline
  before merge with the decline, partial, and clarification cases as the named
  acceptance. The live set MUST include partial-evidence cases on an agent
  whose persona and directives push toward helpfulness, because that is the
  pressure the separate assessor never felt.
- **FR-023**: Eval replay and draft test chat MUST assess coverage through the
  same head path so operators can try coverage-gated rules on a draft.

### Citation hold setting

- **FR-025**: A workspace retrieval setting `citationHoldEnabled` (default
  `true`) MUST control whether an `answer` commitment is held until its first
  complete in-range citation; it MUST be overridable per agent through the
  `retrieval.answer` skill settings the same way `rerankEnabled` is.
- **FR-026**: When the hold is off, text MUST still not be released before the
  head has parsed; after that, release is immediate; the zero-claim decline
  swap does not apply and the grounding summary records the outcome.
- **FR-027**: When the head commits to `no_support` or `out_of_scope`, the
  citation hold MUST NOT apply regardless of the setting.
- **FR-028**: The setting MUST ship with its settings doc under
  `docs/settings-docs/retrieval/`, the OpenAPI schema and TypeScript SDK
  snapshot, and the workspace settings UI control next to the other retrieval
  toggles, labelled *Hold the answer until it cites a source* with the off-state
  consequence stated in one line.

### Documentation

- **FR-024**: `docs/answer-coverage-signals.md` and the portal guides that
  describe when the assessment happens MUST describe the head-time verdict; the
  product-docs corpus MUST be re-synced.

### Key Entities

- **Envelope head**: `coverage` classification and `requestFocus`, emitted before
  `answer`; parsed by the skill; never itself visible to the visitor.
- **Coverage verdict port**: the one call from skill to host carrying the head,
  returning `proceed` or `yield_turn`. The skill knows nothing about routines;
  the host knows nothing about envelopes.
- **Assessment record**: today's `answer_coverage_assessments` row plus a
  producer marker.
- **Agreement observation**: head classification × shadow classification, one
  per shadowed turn, bounded-label metric plus a trace attribute.

## Architecture Constraints

- **What each part knows.** The envelope reader knows JSON field order and
  nothing about coverage semantics beyond the enum. The retrieval skill knows
  how to parse the head and where to hand it off; it never learns what the host
  does with it. The engine owns the decision — directive reaction recording,
  routine ranking, yield — and never sees an envelope. Composition wires the
  port implementation and the shadow.
- **Ports.** One new port in `packages/conversation-contract`: the coverage
  verdict sink the skill calls at head time. The existing
  `ConversationCoverageAssessor` port survives only as the shadow producer and
  is removed with it.
- **Dependency direction.** Engine → contract ← skill; composition assembles.
  The engine's post-evidence stage (`packages/conversation-engine/src/index.ts`,
  coverage assessment through reaction recording) moves from before skill
  execution to the sink implementation, invoked from inside the skill's stream.
  The engine still owns the stage order and the trace stages it emits.
- **Streaming.** The head parser sits beside `GroundedAnswerEnvelopeReader`;
  the `BoundedGroundingStreamGate` keeps its citation semantics and only ever
  sees text released after the head.
- **Prompts.** The assessor prompt's constraints fold into a new template under
  `backend/prompts/chat/`; `answer-coverage-response-guidance.md` and
  `answer-coverage-composition-context.md` are rewritten for a verdict the model
  emits rather than one it receives.
- **Contract review.** The skill port change is a cross-package contract in
  `packages/conversation-contract`; no queue payload, worker contract, or
  public REST contract changes. If debug-view fields change shape, the OpenAPI
  snapshot and TypeScript SDK sync in the same change.
- **Setting.** `citationHoldEnabled` lives in workspace `retrieval_settings`
  with the agent-level override in the `retrieval.answer` skill settings; the
  skill reads the resolved value where it builds `requiresIndexedSourceGate`
  today.
- **Migration.** The producer marker is one nullable column with a CHECK on
  `answer_coverage_assessments`; both DB snapshots regenerate.

## Observability and Privacy

- Trace stage `answer_coverage_head` on the turn spine: head-arrival latency
  from compose start, parse outcome (`parsed`, `invalid`, `deterministic`), and
  the host decision (`proceed`, `yield_turn`). The existing
  `answer_coverage_assessment` stage is emitted only by the shadow, flagged
  `shadow`, until the shadow is removed.
- Metrics with bounded labels: head parse outcome; host decision; shadow
  agreement (`head_classification`, `shadow_classification`), both drawn from
  the eight-value enum plus `shadow_failed`.
- Existing usage metering: the assessor's `answer_coverage_assessment`
  operation disappears from the critical path; the shadow reports under a
  distinct operation so its cost is visible and attributable.
- No `requestFocus`, contextualized request, evidence, prompt, or answer text in
  logs or metric labels. `requestFocus` is conversation data under history
  authorization, as `unresolved_request` is today.

## Success Criteria

- **SC-001**: On the traced production workload, time from retrieval completion
  to first released answer token on agents without coverage routines drops by
  at least 1.0 s at p50.
- **SC-002**: The live eval suite's decline, partial, and clarification cases
  are at or above the committed baseline before merge.
- **SC-003**: Over at least 500 shadowed production turns, head and shadow
  agree on the coverage level (`answered` / `partial` / `unanswered` /
  `unclear`) on at least 90% of turns, and on at least 85% of turns whose head
  is `partial` or `unanswered`. Deletion of the assessor is gated on this.
- **SC-004**: A retrieval turn on an agent without coverage routines makes
  exactly two model calls on its critical path: planner and answer.
- **SC-005**: An end-to-end test proves no answer text reaches the client on a
  turn where a coverage routine activates or is offered.
- **SC-006**: Debug view, assistant history, and Audience Pulse tests pass
  unchanged against head-produced records.
- **SC-008**: With the hold off, first-token release on an `answer` commitment
  trails head arrival by no more than one stream chunk; with the hold on,
  `groundingGateWaitMs` behaviour is unchanged. The gate's own clock starts on
  the first chunk it receives, which is the first chunk after the head
  resolves, not the turn's first raw provider chunk — so `groundingGateWaitMs`
  measures from head resolution, not stream start.
- **SC-007**: Among shadowed turns the shadow classifies `partial` or
  `unanswered`, the head classifies `answered` on no more than 5%. This is the
  disagreement direction that lets a partially supported answer be padded with
  general knowledge after the first citation opens the gate; SC-003's overall
  agreement does not bound it on its own. Deletion of the assessor is gated on
  this as well.

## Scope Boundaries

- The classification taxonomy, criteria authoring, and Pulse reporting are
  unchanged.
- No historical reassessment.
- Planner output size and the planner's own latency are a separate
  conversation.
- Coverage directives' contextual matching remains a pre-compose matcher call
  on turns where such directives exist; making that call cheaper is out of
  scope.

## Assumptions

- Strict structured output emits keys in schema order on the providers in use;
  the envelope reader already depends on this for `answer`.
- The assessor and the answer call share model, evidence, and contextualized
  request today (`chatAnswerCoverageAssessor.ts`), so folding the verdict into
  the answer call does not change which model judges coverage.
- The latency and token numbers come from the production trace analysed
  alongside #1258; the shadow window and SC-001 re-measure them.
