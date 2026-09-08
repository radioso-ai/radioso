# Implementation Plan: Answer Coverage Signals

**Branch**: `answer-gap-followup-routines` | **Date**: 2026-09-08 | **Spec**: [spec.md](./spec.md)

## Technical Context

TypeScript 5.7 on Node 24, Express, PostgreSQL/Kysely, Zod, React 19/Next 16,
Vitest, and Playwright. The existing conversation engine remains the turn
orchestrator; PostgreSQL is the source of truth. A provider-neutral assessment
contract is introduced in the conversation domain and the default structured
model producer is assembled by backend composition. Runtime prompt assets, if
needed, live in `backend/prompts/`.

## Constitution Check

- The approved specification is the source of scope and every task maps to it.
- Backend changes are test-first: unit/integration tests are authored red before
  each implementation slice.
- Domain contracts, persistence adapters, orchestration, and HTTP presentation
  remain separate. Composition only wires defaults.
- No secrets or new configuration are planned. The request data kept in history
  and Pulse is protected by existing workspace authorization and never emitted
  in logs or metric labels.
- Visible authoring, diagnostics, and Pulse behavior use Playwright; parsing,
  policy, mapping, and aggregation use unit tests.
- Public response/history contract changes are code-first in the OpenAPI registry
  and require generated OpenAPI and SDK snapshots.

## Design

### Ownership and dependency direction

`packages/conversation-contract` owns the typed runtime assessment schema,
availability states, and narrow compose-context contract consumed by the engine
and backend. Backend `answerCoverage` owns semantic-output validation, producer,
persistence ports, and read projections. It knows the contextualized request and
admissible evidence, but no directive,
routine, or Pulse policy. Chat/engine orchestration obtains the assessment after
evidence is available and before committing the coverage-dependent response.
`directives` and `routines` own authored criteria and deterministic reaction
decisions; they receive only the narrow signal and preserve existing active,
confirmation, capability, and suppression rules. Persistence owns row mapping
and idempotent correlation. `audiencePulse` owns topic projection and recurrence
math using recorded facts. Debug/history own authorized presentation only.

Routine authoring keeps the existing natural-language **Starts when** trigger
as the primary activation rule. An operator may add an optional answer-coverage
condition; it is a conjunctive post-evidence gate, not a replacement activation
mode or a separate rules engine. Removing it omits `coverageCriteria` and
restores ordinary semantic activation.

### Runtime and persistence

Migration 171 adds immutable `answer_coverage_assessments` and
`answer_coverage_reaction_traces`; migration 172 adds typed JSON criteria to
directives and routine activation. An assessment is unique by workspace and
originating request, so a retry reads the recorded assessment instead of
reassessing or multiplying reactions. It records schema version, availability
(`assessed`, `not_recorded`, `failed`, `invalid`), coverage, reason, optional
unresolved description, and provenance. Reaction rows retain the assessment
correlation, directive/routine identifiers, decision, non-sensitive reason code,
target message, and an execution id only when a routine actually starts.

The chat history read side uses a narrow assessment/reaction repository port,
batched by originating request message. Its persisted evaluation marker keeps
an absent evaluation as `not_evaluated`, distinct from `evaluated` with an empty
decision list. History and live debug present stored target-message and routine
execution identifiers without reconstructing them from response text.

The model producer receives a bounded, explicitly delimited set of admissible
retrieval evidence and the contextualized request/turn interpretation; neither
input is trusted as instructions. It returns strict structured output before
final composition. The concrete grounded-answer composer receives the recorded
assessment in its runtime prompt context, so the response explains the assessed
limit while citation and semantic uncertainty checks remain authoritative.
Invalid, unavailable, or failed output becomes a non-triggering availability
state. For streaming, retrieve → assess → evaluate reactions → compose → emit
the first visitor content; non-streaming uses the same order. Canonical final
outcomes preserve the underlying execution result and distinguish assessed
`coverage_partial`, `coverage_unanswered`, `coverage_unclear`, and
`coverage_unavailable`; only an actual retrieval decline uses
`no_context_refusal`. The structured-output budget must contain all required
fields and a bounded multilingual unresolved description without truncation.
This prevents retraction, preserves an active routine under its interruption
policy, and allows only a materially new request to re-enter evaluation.

### Assessment reliability follow-up

`answerCoverage` remains the sole owner of structured assessor validation and
the semantic prompt. Its provider schema uses one finite classification code
for each valid coverage/reason pair, then maps it to the public tuple and
unresolved-request nullability; malformed output still fails closed as
`invalid`. The chat adapter passes
the exact final retrieval context to that port and owns only request shaping and
persistence. Final-answer composition receives the stored assessment as an
untrusted diagnostic: it must state a supported resolved answer directly, or
state the assessed limitation, while source citations remain the factual basis.
Pulse only aggregates persisted assessed tuples and never repairs invalid data.

Assessment traces retain availability and bounded model-call correlation only.
They do not log prompts, completions, admitted evidence, visitor text, or
validation details. This gives operators a safe failure signal without turning
diagnostics into a second data store.

The public persisted assessment remains schema version 1: its coverage, reason,
availability, and unresolved-request meanings are unchanged. The provider-only
classification code is normalized before that boundary. `invalid` and `failed`
remain the deliberately bounded diagnostic distinction; the inference port does
not expose provider finish reasons, so no raw provider error or completion data
is propagated into turn debug.

### Operator and reporting surfaces

Expose typed coverage/reason criteria in existing directive and routine
authoring payloads, validation, copilot descriptors, and UI. Extend turn history
and debug trace with assessment, evidence/citation distinction, and recorded
reaction decisions. Extend Audience Pulse topic summaries/evidence with
exclusive coverage buckets, reason breakdown, legacy/unassessed disclosure,
eligible-gap recurrence, and linked routine lifecycle. Preserve old report
payloads and grounding-only gap classification as legacy evidence. Later
semantic resolution is linked as a separate event; routine completion never
rewrites the originating gap. Where no coverage criterion is authored, existing
directive and routine behavior remains unchanged.

### Observability, contracts, and queues

Trace the assessment producer and record bounded coverage/reason/availability
and reaction outcome fields with existing request/turn correlation. Do not log
prompts, completions, evidence, unresolved text, or identifiers as metric labels.
The feature changes history/Pulse/public authoring shapes, so update the
code-first OpenAPI registry, regenerate backend specs, sync the TypeScript SDK,
and update docs. It does not alter document-worker or AMQP payloads, dispatch,
retry, or queue docs; this is verified by targeted contract review.

## Test Strategy

1. Unit tests: strict assessment parsing, availability fallback, directive/routine
   criteria and precedence/suppression, persistence mapping, Pulse bucket and
   recurrence counts including duplicate delivery and legacy data.
2. Integration/contract tests: migration/repository idempotency, chat streaming
   and non-streaming parity, OpenAPI responses and generated SDK surface.
3. Playwright: author criteria, cited unanswered debug trace, matched/suppressed
   reactions, linked completed routine, Pulse evidence/counts, and absent/failed
   historical assessment.
4. Deterministic conversation eval additions cover multilingual correction,
   explicit negative, partial, ambiguity, conflict, and invalid assessment.

## Delivery Notes

No branch creation or rename. Documentation includes directive/routine authoring,
diagnostics, Audience Pulse, public contracts, and a copilot tool descriptor (or
explicit coverage-map exclusion). Run focused tests per slice, then backend and
frontend build/test, root lint/dead-code, API/SDK sync checks, and relevant
Playwright before senior review and the engineering-manager pass.

## Validation and Handoff

### Lifecycle correction follow-up

The post-evidence routine path defers its routine transition and reaction
diagnostics to the assistant-turn completion boundary, and projects handoff and
approval effects through both prepared turn modes. Coverage reentry evaluates
the current assessed signal against the completed routine's effective coverage
registration before delegating to the existing semantic reentry gate. Engine
trace merging retains pre-assessment, post-evidence routine, and reaction stages
in both streaming and non-streaming results.

Focused validation passed: the ChatService lifecycle suite (107 tests) covers
post-commit evaluated traces, deferred lifecycle rejection, handoff and pending
approval forwarding, and recorder-failure `not_evaluated` traces in both modes.
The disposable PostgreSQL pending-decision and assistant-turn-persistence suites
passed 16 tests, including rollback of a failed assistant-message insert. The
coverage routine provider and engine focused suites passed 11 and 48 tests;
coverage fixture contracts passed 25 tests after aligning their gateway,
activation, and presenter dependencies with the production ports.

Local validation completed with the backend and frontend production builds, full
backend and frontend unit suites, disposable PostgreSQL integration tests,
focused Playwright journeys, SDK tests, conversation-engine tests, lint, and
the dead-code gate. Generated API and SDK artifacts are current. Independent
senior-engineer and engineering-manager reviews completed, and their findings
were resolved and rechecked. The live paid-model evaluation suite was not run;
it remains the repository's normal on-demand gate. This work is local and
uncommitted; no pull request or deployment was created.

### Review correction validation

Reaction provenance is constrained at the conversation boundary, so a reaction
cannot link an assessment and target message from different conversations in one
workspace. Directive PATCH preserves an omitted criterion and clears an explicit
`null`; bundle serialization and the generated OpenAPI/SDK contract retain the
criterion. Live and adopted workbench messages retain coverage debug from JSON
and terminal SSE responses. Focused checks covered the API create/omit/null/GET
sequence, disposable-PostgreSQL cross-conversation rejection, bundle
serialization/materialization, SSE and workbench state mapping, directive UI
round-trip, frontend build, SDK, and MCP OpenAPI checks. No queue payload changed.

## Requirement Traceability

| Requirements | Delivery owner/tasks |
|---|---|
| FR-001–006 | T002, T005–T013: shared contract, validated producer, timing, persisted availability/provenance and parity. |
| FR-007–013 | T004, T014–T017: narrow runtime context, authoring, precedence/suppression, correlation, LLM-composed response. |
| FR-014–019 | T003, T018–T021: shared persisted projection, buckets, recurrence, evidence authorization, legacy compatibility. |
| FR-020–022 | T022–T024: recorded diagnostics and trace navigation, not retrospective inference. |
