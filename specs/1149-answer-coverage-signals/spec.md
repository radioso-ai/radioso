# Feature Specification: Answer Coverage Signals

**Feature Branch**: `answer-gap-followup-routines`  
**Created**: 2026-09-08  
**Status**: Approved  
**Input**: Formalize the agreed requirements for accurate answer coverage, generic directive and routine consumption, and Audience Pulse reporting.

## Problem and Goal

An agent can retrieve related material, cite accurate background facts, and still
leave the visitor's actual question unanswered. Radioso currently allows that
turn to appear as a grounded success. Operators need to distinguish evidence
being found, statements being supported, and a question being answered.

Introduce a shared answer-coverage assessment that records whether the available
evidence resolves the contextualized request. Directives and routines receive
that signal so operators can design the interaction. Turn diagnostics and
Audience Pulse consume the same assessment.

For example, a visitor asks whether they can attend for one day to meet a
visiting teacher. The agent finds related courses but cannot confirm attendance
rules. That is an unanswered request caused by insufficient evidence, even if
the answer cites those courses. An operator may choose to explain the gap,
ask a clarification, offer a routine, or start an eligible routine under its
existing activation and confirmation rules.

## Decisions Agreed

- Answer coverage is separate from retrieval evidence availability, citation
  validity, execution success, and follow-up progress.
- Coverage is evaluated against the request in conversation context. Related
  background facts do not constitute a partial answer unless they resolve an
  actual part of that request.
- Directives and routines consume a generic signal. Contact collection,
  consultation, and human handoff are operator-authored uses of that signal.
- Operator rules can react within the turn where the gap is discovered.
- Audience Pulse uses the shared assessment in its existing topic experience.
  Follow-up success leaves the originating knowledge gap visible.
- Existing conversations and saved reports without the assessment remain
  distinguishable from assessed data. Historical reassessment is outside scope.

## User Scenarios & Testing

### User Story 1 — See Whether the Question Was Answered (Priority: P1)

As an operator, I can distinguish an answered question from a cited response
that leaves the requested information missing.

**Why this priority**: Accurate classification is the basis for automation and
reporting.

**Independent Test**: Run a controlled conversation with related documents that
lack the requested attendance rule; inspect the recorded assessment and status.

**Acceptance Scenarios**:

1. **Given** related courses are retrieved but attendance rules are absent,
   **when** the agent cites the courses and explains the limitation, **then**
   coverage is `unanswered`, the reason is `insufficient_evidence`, and the turn
   is not presented as fully answered.
2. **Given** a visitor asks for a date and an attendance rule, **when** evidence
   answers only the date, **then** coverage is `partial` and identifies the
   attendance rule as unresolved.
3. **Given** evidence explicitly says one-day attendance is prohibited,
   **when** the agent conveys that rule with valid support, **then** coverage is
   `answered`; an unfavorable answer is still an answer.
4. **Given** a visitor corrects a name in a follow-up message, **when** coverage
   is assessed, **then** the correction is interpreted in conversation context
   rather than assessed as an unrelated definition request.
5. **Given** the assessment is missing or invalid, **when** the turn is shown,
   **then** coverage is identified as not assessed rather than inferred as
   answered from citations or successful execution.

### User Story 2 — Design the Response Through Directives and Routines (Priority: P1)

As an operator, I can author how my agent responds to a coverage signal using
directives and routines, including offering a flow or entering an eligible flow.

**Why this priority**: The response to missing information depends on the
operator's service and authored interaction.

**Independent Test**: Configure two agents with different directives and routines
for the same coverage signal and verify that each follows its own configuration.

**Acceptance Scenarios**:

1. **Given** a directive matches unanswered requests with insufficient evidence,
   **when** retrieval exposes that signal, **then** the directive can steer the
   response in that same turn.
2. **Given** a routine's authored activation criteria match the signal,
   **when** the signal becomes available, **then** activation can consider it
   within the same turn while preserving routine eligibility and confirmation.
3. **Given** the operator configures an offer that requires visitor acceptance,
   **when** the visitor accepts, **then** the configured routine starts; merely
   detecting the gap does not execute the routine's external action.
4. **Given** another operator configures a clarification or support-request flow,
   **when** the same signal is produced, **then** that configuration controls the
   interaction without contact-specific application logic.
5. **Given** no applicable operator rule exists, **when** a gap is detected,
   **then** the agent explains the limitation and records accurate coverage.
6. **Given** an offer was declined or a routine is already handling the request,
   **when** the same signal is encountered again, **then** it does not cause a
   duplicate offer, routine activation, or external action.

### User Story 3 — Understand Gaps in Audience Pulse (Priority: P1)

As an operator, I can see which topic questions remain unanswered, why they
remain unanswered, and how my configured interactions handled them.

**Why this priority**: Reporting must measure the same behavior that operators
observe and configure in conversations.

**Independent Test**: Analyze a fixed population containing full answers, partial
answers, evidence gaps, clarification needs, and completed follow-up routines.
Compare the topic counts and evidence details with the recorded assessments.

**Acceptance Scenarios**:

1. **Given** assessed questions in a topic, **when** its details are opened,
   **then** the operator sees exclusive counts for Answered, Partly answered,
   Unanswered, and Needs clarification, with unassessed records distinguished.
2. **Given** a recurring insufficient-evidence gap meets the recurrence policy,
   **when** Pulse generates the report, **then** the topic qualifies for a content
   recommendation even when those responses have citations.
3. **Given** unresolved requests arise only from ambiguity, execution failure, or
   an intentional scope boundary, **when** Pulse generates recommendations,
   **then** those reasons alone do not qualify the topic as a content gap.
4. **Given** a gap triggered a routine that completed successfully, **when** the
   operator opens the question evidence, **then** the original gap and the
   linked routine progress are both visible. Completion does not rewrite the
   original coverage as answered.
5. **Given** several gap events belong to the same originating question,
   **when** Pulse aggregates it, **then** the question contributes once to its
   coverage bucket and gap occurrence count.
6. **Given** a saved report lacks coverage assessments, **when** it is opened,
   **then** the interface preserves its existing data and explains that the new
   assessment was not recorded.

### User Story 4 — Explain the Turn in the Debug View (Priority: P1)

As an operator inspecting a turn, I can see why it received its coverage status
and how that signal affected directive matching and routine activation.

**Why this priority**: Operators need to diagnose both the assessment and their
authored reaction when a cited response leaves a question unanswered.

**Independent Test**: Open the existing turn debug view for an evidence gap with
a matching directive and routine, then compare the displayed decisions with the
persisted assessment and execution trace.

**Acceptance Scenarios**:

1. **Given** related evidence was retrieved but the question remains unanswered,
   **when** the operator opens the debug view, **then** it shows evidence found,
   citation support, `unanswered` coverage, `insufficient_evidence`, and the
   unresolved request as distinct facts, and explains the resulting turn status.
2. **Given** coverage-dependent directives or routines were evaluated, **when**
   the operator inspects the trace, **then** it identifies the signal they
   received, the matching directive/routine, and the applied, offered, activated,
   skipped, or suppressed decision with its recorded reason.
3. **Given** a routine completed after an evidence gap, **when** the operator
   inspects the originating turn, **then** the gap remains visible alongside
   linked routine progress and any separately recorded later resolution.
4. **Given** an older turn or failed assessment has no coverage value, **when**
   the debug view is opened, **then** it distinguishes not recorded from
   assessment failure and does not reconstruct a semantic verdict from citations.

## Requirements

### Shared Assessment

- **FR-001**: The system MUST produce a structured semantic assessment against
  the visitor's contextualized request. Its coverage values MUST be `answered`,
  `partial`, `unanswered`, and `unclear`.
- **FR-002**: `answered` MUST mean the request is resolved by the available
  evidence; `partial` MUST mean an actual part is resolved; `unanswered` MUST
  mean the requested information remains unresolved; `unclear` MUST mean the
  request requires clarification before its answerability can be established.
- **FR-003**: The assessment MUST include a typed reason and, when information
  remains missing, a brief description of the unresolved request. Reasons MUST
  distinguish at least sufficient evidence, insufficient evidence, conflicting
  evidence, ambiguous request, and an intentional scope boundary. Assessment
  availability and execution failure MUST remain separately identifiable.
- **FR-004**: Semantic assessment MUST use structured model output and validation.
  Application code MUST NOT infer coverage or route interactions using English
  phrase matching, citation counts, or retrieval similarity alone.
- **FR-005**: The assessment MUST be associated with its originating request and
  recorded with provenance sufficient to identify the assessed turn and schema
  version. Supported streaming and non-streaming paths MUST have equivalent
  semantics. Structural grounding checks remain authoritative for citation
  validity; semantic coverage cannot bypass them to produce a green status.
- **FR-006**: Missing, invalid, or failed assessments MUST be represented as not
  assessed. They MUST NOT create a semantic gap trigger or imply a full answer.

### Operator-Controlled Interaction

- **FR-007**: Directive matching and routine activation MUST receive the shared
  coverage signal through typed runtime context after evidence is available and
  before the coverage-dependent response is committed to the visitor.
- **FR-008**: Operators MUST be able to author coverage- and reason-dependent
  criteria through the existing directive and routine authoring surfaces. The
  criteria MUST be inspectable and validated; this feature MUST NOT require
  operators to modify runtime code or infer coverage from response text. A
  routine keeps its existing semantic activation trigger; an optional coverage
  condition is conjunctive with that trigger and can be removed to restore the
  routine's ordinary activation behavior.
- **FR-009**: Directives MUST steer and routines MUST carry their authored flows.
  The signal MUST NOT prescribe a built-in contact, email, consultation, or
  handoff interaction. Existing permissions, capability availability, action
  confirmation, and routine activation policies MUST remain enforced.
- **FR-010**: Coverage-dependent processing MUST have bounded evaluation and
  deterministic precedence. An active routine keeps control under existing
  interruption rules. Re-evaluation MUST NOT create recursive activation,
  duplicate side effects, or repeated offers for the same unresolved request.
  A materially new request remains eligible for evaluation.
- **FR-011**: The system MUST retain correlation between the originating
  assessment, applicable directives, and offered or activated routines. Routine
  progress and outcomes MUST use generic lifecycle information. An offered
  routine MUST be distinguishable from an activated or completed routine.
- **FR-012**: Follow-up progress MUST NOT overwrite the originating evidence-gap
  assessment. If later interaction actually resolves the question, that resolution
  MUST be linked and distinguishable from the earlier gap. Routine completion
  alone MUST NOT establish semantic resolution.
- **FR-013**: Conversational explanations, clarification questions, and offers
  MUST be generated by the LLM in the visitor's language using operator guidance.

### Consistent Reporting and Audience Pulse

- **FR-014**: Turn status, diagnostics, and Audience Pulse MUST consume the same
  persisted assessment. They MUST distinguish semantic coverage from retrieval
  availability, citation support, execution success, and follow-up progress.
- **FR-015**: Audience Pulse MUST aggregate coverage and typed reasons within its
  existing topic experience. Each assessed eligible question MUST contribute to
  exactly one coverage bucket; unassessed questions MUST remain visible as such.
- **FR-016**: For assessed records, recurring content-gap eligibility MUST include
  `partial` or `unanswered` requests whose unresolved information results from
  insufficient or conflicting evidence. Ambiguity, intentional scope boundaries,
  and technical failures alone MUST NOT establish content-gap eligibility.
- **FR-017**: Preserve the recurrence threshold: at least
  `max(2, ceil(0.10 * topicQuestionCount))` eligible gap questions across at least
  two distinct conversations. Preserve the existing eligible question population,
  topic membership, and question/conversation count units. A gap occurrence
  describes failure to answer from available evidence, not proof that no relevant
  document exists anywhere in the workspace.
- **FR-018**: Topic evidence MUST let the operator inspect the originating
  question, assessment and unresolved information, applicable directives, and
  linked routine progress. Evidence access MUST preserve workspace authorization
  and existing privacy boundaries. Counts MUST come from recorded data rather
  than model-generated narrative.
- **FR-019**: Older records MUST retain their existing grounding classification
  and gap eligibility, clearly identified as legacy evidence rather than a newly
  measured coverage value. Saved reports without the new fields MUST remain
  readable. Refreshing a report MUST NOT manufacture assessments for older turns;
  mixed reports MUST disclose which questions have semantic coverage measured.

### Debug View

- **FR-020**: The existing turn debug view MUST display the contextualized request,
  coverage, typed reason, unresolved information when present, assessment
  availability, and provenance. It MUST distinguish those fields from retrieval
  evidence availability, citation validation, execution outcome, and follow-up
  progress, and make the derivation of the displayed turn status inspectable.
- **FR-021**: The debug trace MUST expose coverage-dependent directive and routine
  evaluation in execution order, including the assessment consumed, evaluated
  directive/routine identities, recorded match and application decisions, and
  reasons for skipping or suppressing a reaction. An absent evaluation MUST be
  distinguishable from an evaluation that found no match. Display recorded
  structured decisions rather than generating a retrospective model explanation.
- **FR-022**: Debug inspection MUST retain navigation between the originating
  assessment and linked routine execution or later resolution. Assessment failure
  and historical absence MUST have explicit states. Streaming and non-streaming
  turns MUST expose equivalent diagnostic information within existing authorized
  debug/history access; this does not authorize additional sensitive payloads in
  operational logs or metrics.

### Key Entities

- **Answer coverage assessment**: Coverage, typed reason, unresolved-request
  description, originating request/turn references, and assessment provenance.
- **Coverage-dependent interaction**: The association between an assessment,
  matched directives, and a routine offer or activation, including lifecycle state.
- **Topic coverage summary**: Exclusive assessed-question counts, unassessed
  population, reason breakdown, gap recurrence, and authorized evidence references.

## Architecture Constraints

- **Knowledge ownership**: The assessment producer understands the contextualized
  request and available evidence. It does not know an operator's consultation,
  contact, or other business workflow. Directives and routines own the authored
  reaction. Audience Pulse owns aggregation and recommendations, not runtime
  interaction decisions.
- **Ports**: Define one shared, provider-neutral assessment contract for runtime
  consumers and persistence. Expose narrow context to directive matching and
  routine activation, and a read-only projection to history and Audience Pulse.
  Avoid duplicated structural types across those boundaries.
- **Dependency direction**: Conversation orchestration depends on those contracts;
  concrete adapters implement them. Application composition assembles the default
  producer and consumers. Domains do not depend on application composition.
- **Responsibility limits**: ChatService and turn assembly remain orchestration
  surfaces. Semantic parsing, trigger eligibility, persistence mapping, and Pulse
  aggregation belong in focused owners. Generic retrieval and transport code do
  not absorb routine-specific behavior.
- **Timing**: The plan MUST resolve assessment timing for streaming and final
  answer validation without sending an answer that coverage-dependent processing
  then attempts to retract. This requirement does not mandate a separate model
  call; the authoritative assessment and emitted answer must remain consistent.
- **Persistence**: PostgreSQL remains the system of record. Correlation and report
  projections must support retries without multiplying question counts or actions.

## Constitution and Delivery Constraints

- Follow `.specify/memory/constitution.md`, including spec approval before planning
  or implementation, backend TDD, React frontend, PostgreSQL, modular ownership,
  prompt ownership under `backend/prompts/`, and existing model configuration.
- Cover visible operator authoring, turn diagnostics, and Pulse journeys with
  Playwright; reserve unit tests for semantic parsing, policy, mapping, and counts.
- Review conversation-engine, history, authoring, and Pulse contract changes.
  Regenerate code-first OpenAPI artifacts and the TypeScript SDK snapshot whenever
  exposed contracts change.
- Review message-queue effects, including any asynchronous report or follow-up
  handoff and retry behavior. No document-ingestion or AMQP payload change is
  presumed; the implementation plan must record the actual impact.
- Ship corresponding copilot tool descriptor coverage for operator-facing changes,
  or a stated coverage-map exclusion in the same change.
- Update relevant directive/routine authoring, diagnostics, Audience Pulse, and
  public-contract documentation with implementation. Update local module briefs
  where ownership or public entry points change.

## Observability and Privacy

Record assessment availability, coverage/reason, interaction decision, and failure
or suppression reason with existing request/turn correlation. Trace any added
model calls and latency. Use bounded metric labels; do not put request, conversation,
or workspace identifiers in metric dimensions. Existing audit requirements for
operator configuration and routine actions continue to apply.

Raw prompts, completions, document content, retrieved chunks, email addresses,
credentials, and unresolved-request text MUST NOT enter operational logs or
metrics. The unresolved-request description is conversation data: minimize it,
protect it with history authorization, and apply existing Pulse privacy handling
before including it in reporting artifacts.

## Edge Cases

- Related cited facts leave the only requested fact unanswered.
- Evidence supplies an explicit negative answer or answers only one of several parts.
- Sources disagree on the requested fact.
- A short correction, multilingual follow-up, or ambiguous referent changes what
  the visitor is asking.
- The model assessment is malformed, unavailable, or inconsistent with the answer.
- A matching routine is disabled, unavailable, already active, awaiting confirmation,
  declined, interrupted, or retried after an external-action failure.
- More than one directive or routine matches the signal.
- A routine completes an action without answering the originating question.
- A later answer resolves a gap without erasing its earlier occurrence.
- A topic contains both assessed records and older grounding-only records.
- Several unanswered questions occur in one conversation and do not satisfy the
  two-conversation recurrence threshold.

## Success Criteria

- **SC-001**: All controlled acceptance cases for related-but-insufficient evidence
  remain classified as unanswered despite citations; genuine partial and full
  answers retain their distinct classifications.
- **SC-002**: Two differently configured agents can react differently to the same
  signal through directives and routines, with no workflow-specific runtime change.
- **SC-003**: Streaming and non-streaming versions of the same controlled cases
  produce equivalent assessment, interaction eligibility, and recorded outcomes.
- **SC-004**: Fixed-population Pulse tests reproduce exact coverage and recurrence
  counts, including threshold boundaries, mixed historical data, and duplicate
  event delivery. Routine success never removes the originating gap occurrence.
- **SC-005**: Operators can follow a topic example to its question, coverage reason,
  applicable directives, and routine progress through the existing evidence flow.
- **SC-006**: Deterministic tests and multilingual conversation-quality eval cases
  cover the attendance example, contextual corrections, explicit negative answers,
  partial requests, ambiguity, conflict, and assessment failure. Live evaluation
  follows the repository's existing on-demand gate and does not require a new
  per-PR live-model gate.

- **SC-007**: Playwright coverage verifies the debug view for a cited unanswered
  request, a matched directive and routine reaction, a suppressed duplicate,
  later routine completion, and absent or failed assessment. Displayed coverage
  and decisions MUST agree with the persisted assessment and trace in every case.

## Scope Boundaries

This feature does not introduce a dedicated consultation flow, a general event
automation builder, historical model reassessment, a replacement topic-clustering
algorithm, or automatic factual document creation. It does not redesign existing
routine action permissions. The implementation plan determines the schema and
runtime seams needed to deliver the behavior above.
