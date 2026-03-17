# Feature Specification: Assistive Rewrite Guardrails

**Feature Branch**: `013-rewrite-guardrails`  
**Created**: 2026-03-16  
**Status**: Draft  
**Input**: User description: "Treat LLM query rewrite as assistive, not authoritative, by requiring structured rewrite output, validating rewritten retrieval against raw retrieval and trusted active subject state, and preventing rewrite output from alone changing subject continuity state."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Safe Referential Follow-Up Retrieval (Priority: P1)

As a chat user asking a referential or elliptical follow-up question, I want the
system to reuse the correct subject when justified so that retrieval answers my
actual question instead of drifting to a plausible but wrong interpretation.

**Why this priority**: Preventing silent semantic drift is the core user value.
If this fails, retrieval can confidently answer the wrong question.

**Independent Test**: Can be fully tested by submitting follow-up questions that
depend on prior grounded context and confirming the selected context stays tied
to the intended subject without requiring explicit repetition from the user.

**Acceptance Scenarios**:

1. **Given** a prior turn grounded on subject A, **When** the user asks a
   referential follow-up about that same subject, **Then** retrieval may use a
   rewritten standalone query but MUST keep the follow-up anchored to subject A
   unless stronger evidence in the current turn indicates otherwise.
2. **Given** a prior turn grounded on subject A, **When** the rewrite proposes a
   different subject unsupported by prior trusted state or retrieval evidence,
   **Then** the system MUST reject that subject shift for continuity decisions.
3. **Given** rewrite assistance is enabled, **When** the structured rewrite
   repeats the raw query's subject and intent without adding clarifying value,
   **Then** rewritten retrieval MUST NOT run and the turn MUST use raw retrieval
   only.

---

### User Story 2 - Preserve Ambiguity and Relation Intent (Priority: P2)

As a chat user asking relation, comparative, or ambiguous follow-up questions, I
want the system to preserve that uncertainty or relationship framing so that it
does not collapse my question into a simpler but incorrect subject switch.

**Why this priority**: Many continuity failures come from the model overcommitting
when the user asked something relational or ambiguous.

**Independent Test**: Can be fully tested by sending relation and ambiguous
follow-up prompts and confirming the system either keeps the existing trusted
subject or marks the turn unresolved rather than inventing certainty.

**Acceptance Scenarios**:

1. **Given** a user asks a relation question involving the carried subject and a
   second named entity, **When** the rewrite is produced, **Then** the system
   MUST keep the main subject and related entity distinct.
2. **Given** the user message is ambiguous and does not clearly establish a new
   main subject, **When** the rewrite or evidence remains inconclusive, **Then**
   the system MUST treat the turn as unresolved instead of promoting a new
   active subject.
3. **Given** the current turn names one entity explicitly while mentioning other
   entities only as relation targets, **When** the turn is classified, **Then**
   only the explicitly centered entity may be proposed as the active subject
   unless the user expressly recenters on another entity.

---

### User Story 3 - Explainable Continuity Decisions (Priority: P3)

As an operator or developer investigating retrieval quality, I want structured
rewrite interpretation and validation diagnostics so that I can see whether a
turn was trusted, rejected, or left unresolved and why.

**Why this priority**: Silent drift is hard to debug unless the decision path is
captured in a structured way.

**Independent Test**: Can be fully tested by reviewing diagnostics emitted for
rewritten turns and confirming they record the rewrite proposal, validation
result, and whether trusted subject state changed.

**Acceptance Scenarios**:

1. **Given** raw retrieval and rewritten retrieval materially disagree, **When**
   the turn completes, **Then** diagnostics MUST record the disagreement and the
   continuity decision taken.

### Edge Cases

- The current turn names a new explicit subject while also containing pronouns
  that refer to the previous subject.
- The rewrite returns malformed, partial, or overconfident structured data.
- The rewrite introduces a subject not present in the current turn, prior
  trusted state, or retrieved evidence.
- The rewrite turns an unresolved or comparative user message into a single,
  confident subject claim.
- Raw retrieval and rewritten retrieval each find plausible but different
  subject clusters.
- A multilingual follow-up mixes languages while preserving the same subject.
- A comparative question refers to two entities but does not identify which one
  should become the active subject afterward.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Transport remains in HTTP route and app wiring modules,
  orchestration remains in the retrieval pipeline, rewrite proposal generation
  remains in a focused rewrite service or gateway, continuity trust rules live
  in dedicated retrieval-domain services, and any persistence changes remain in
  repositories or additive diagnostics storage only.
- **Encapsulation Rule**: `backend/src/modules/retrieval/services/retrievalPipelineService.ts`
  MUST remain an orchestrator that composes search, rewrite, validation, and
  prompt assembly rather than owning subject-trust policy itself.
- **Encapsulation Rule**: `backend/src/modules/retrieval/services/queryRewriteService.ts`
  MUST remain responsible for obtaining and normalizing rewrite proposals and
  MUST NOT become the sole authority for active-subject changes.
- **New Seams Required**: Introduce an explicit structured rewrite result type,
  a focused validation decision seam that compares raw retrieval, rewritten
  retrieval, and prior trusted subject state, and a dedicated continuity policy
  seam that decides whether subject state is retained, updated, or left
  unresolved.
- **Anti-Goals**: Do not keep heuristic subject extraction from prior raw user
  text as a fallback continuity authority. Do not let rewrite output alone
  replace trusted active subject state. Do not bury disagreement handling inside
  opaque prompt text or route handlers.

## Scope Boundaries

- In scope: structured rewrite proposals, retrieval-side validation, continuity
  trust rules, safe fallback behavior, and additive diagnostics for continuity
  decisions.
- Out of scope: new user-facing controls, a general conversation-memory
  redesign, replacing the retrieval stack, or allowing rewrite output to author
  subject continuity state by itself.

## Decision Definitions

- **Material disagreement** means at least one of the following is true:
  raw retrieval and rewritten retrieval center different primary subjects,
  rewritten retrieval introduces a primary subject absent from the last trusted
  subject and the current turn, rewrite changes a relation question into a new
  main-subject question, or rewrite changes an ambiguous turn into a resolved
  subject claim without supporting evidence.
- **Materially different standalone query** means the rewrite changes the
  subject reference, resolves ellipsis or pronouns into named entities, or adds
  necessary standalone context that could change retrieval results. Surface
  cleanup, wording polish, translation-only normalization that keeps the same
  grounded subject, or paraphrases that do not change retrievable meaning do not
  qualify.
- **Explicit subject** means the entity the current user turn directly centers
  as the main thing being asked about. A named entity that appears only as a
  comparison target, relation target, example, or constraint is a related entity
  and MUST NOT become the active subject by default.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST ask the rewrite layer to return structured output
  that includes a standalone retrieval query, turn classification, candidate
  active subject, related entities, unresolved status, and confidence.
- **FR-002**: The system MUST treat rewrite output as a proposal for retrieval
  interpretation and MUST NOT treat it as authoritative conversation state on
  its own.
- **FR-003**: The system MUST continue to run retrieval using the raw user query
  whenever rewrite assistance is enabled.
- **FR-004**: The system MUST run rewritten retrieval only when the structured
  rewrite proposes a materially different standalone query.
- **FR-005**: The system MUST compare raw retrieval evidence, rewritten
  retrieval evidence, and the last trusted active subject before deciding
  whether a carried subject remains valid.
- **FR-006**: The system MUST prefer an explicit subject stated in the current
  turn over any carried subject from prior turns.
- **FR-007**: The system MUST keep related entities separate from the proposed
  main subject for relation or comparative turns.
- **FR-008**: The system MUST preserve ambiguity by marking the turn unresolved
  or retaining the prior trusted subject when the rewrite proposal and evidence
  do not materially agree.
- **FR-009**: The system MUST prevent rewrite output from becoming the sole
  reason a new active subject is trusted or persisted.
- **FR-010**: The system MUST remove or demote fallback behavior that derives a
  continuity subject directly from prior raw user text without structured
  validation.
- **FR-011**: The system MUST reject structured rewrite proposals that introduce
  named subjects, relations, or certainty not grounded in the current turn, the
  last trusted subject, or retrieval evidence.
- **FR-012**: The system MUST record diagnostics for rewritten turns that show
  the rewrite proposal, whether rewritten retrieval was run, whether raw and
  rewritten evidence converged, and whether trusted subject state changed.
- **FR-013**: The system MUST fall back safely to raw-query behavior when the
  rewrite output is unavailable, malformed, or unusable.
- **FR-014**: The system MUST preserve existing behavior for standalone queries
  that already identify their subject clearly in the current turn.
- **FR-015**: The system MUST preserve ambiguous, comparative, and relation turn
  types in the structured rewrite output and MUST NOT coerce them into fresh
  subject turns without grounding evidence.
- **FR-016**: The system MUST define rewrite retrieval eligibility from the
  structured rewrite itself and skip rewritten retrieval when the proposal is
  not materially different, is unresolved, or fails the hallucination guard.
- **FR-017**: The system MUST treat an explicit current-turn subject as higher
  priority than any related entity named in the same turn unless the turn
  explicitly recenters on that related entity.

### Key Entities *(include if feature involves data)*

- **Structured Rewrite Result**: The rewrite layer's proposal for interpreting
  the current turn, including standalone query text, turn kind, candidate main
  subject, related entities, unresolved flag, and confidence.
- **Rewrite Eligibility Decision**: The decision that determines whether the
  structured rewrite is different and grounded enough to justify rewritten
  retrieval.
- **Trusted Active Subject**: The last subject the system is willing to reuse
  for continuity because prior evidence supported it.
- **Rewrite Validation Decision**: The outcome of comparing raw retrieval,
  rewritten retrieval, and prior trusted subject state to determine whether the
  subject should be retained, updated, or left unresolved.
- **Retrieval Evidence Snapshot**: The subject-bearing signals drawn from raw
  and rewritten retrieval results that support or reject the rewrite proposal.

## Assumptions

- This feature is backend-only unless existing diagnostics contracts require
  additive response fields.
- The system may keep using rewrite assistance for multilingual and elliptical
  follow-ups, but only within the validation guardrails defined above.
- The feature does not introduce a broader conversation-memory redesign beyond
  trusted active-subject continuity for retrieval.
- Any persistence changes are limited to additive diagnostics or continuity
  support already allowed by the active technology notes.
- Retrieval evidence can be evaluated using the subject clusters already implied
  by retrieved context and does not require a separate user-visible entity model.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In the approved regression suite for referential follow-ups, at
  least 90% of turns retrieve supporting context for the intended subject
  without requiring the user to restate that subject explicitly.
- **SC-002**: In the ambiguity and relation regression suite, 100% of turns that
  lack converging evidence avoid promoting an unsupported new active subject.
- **SC-003**: In 100% of turns where rewrite assistance is attempted,
  diagnostics show whether rewrite was proposed, whether rewritten retrieval was
  executed, and whether the trusted subject was retained, updated, or left
  unresolved.
- **SC-004**: Existing regression coverage for explicit standalone subject
  queries continues to pass without behavior changes attributable to this
  feature.
