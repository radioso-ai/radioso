# Feature Specification: Assistive Rewrite Guardrails

**Feature Branch**: `013-rewrite-guardrails`  
**Created**: 2026-03-16  
**Status**: Implemented  
**Input**: User description: "Treat LLM query rewrite as assistive, not authoritative, by requiring structured rewrite output, preventing rewrite output from alone changing subject continuity state, and keeping rewrite useful for multilingual and elliptical follow-ups without adding noisy expansions."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Safe Referential Follow-Up Retrieval (Priority: P1)

As a chat user asking a referential or elliptical follow-up question, I want the
system to reuse the correct subject when justified so that retrieval answers my
actual question instead of drifting to a plausible but wrong interpretation or
rewriting my question into abstract meta-language.

**Why this priority**: Preventing silent semantic drift is the core user value.
If this fails, retrieval can confidently answer the wrong question.

**Independent Test**: Can be fully tested by submitting follow-up questions that
depend on prior grounded context and confirming the selected context stays tied
to the intended subject without requiring explicit repetition from the user.

**Acceptance Scenarios**:

1. **Given** a prior turn grounded on subject A, **When** the user asks a
   referential follow-up about that same subject, **Then** retrieval may use a
   rewritten standalone query and MAY reuse a bounded carry-forward snippet from
   the immediately previous assistant answer to keep the rewrite concrete.
2. **Given** a prior turn grounded on subject A, **When** the rewrite proposes a
   different subject unsupported by the user turn, **Then** the system MUST NOT
   let that proposal author continuity state by itself.
3. **Given** rewrite assistance is enabled, **When** the structured rewrite is
   abstract, meta-linguistic, or otherwise unusable for retrieval, **Then** the
   system MUST fall back to raw-query retrieval instead of issuing the noisy
   rewrite.

---

### User Story 2 - Preserve Ambiguity and Relation Intent (Priority: P2)

As a chat user asking relation, comparative, or ambiguous follow-up questions, I
want the system to preserve that uncertainty or relationship framing so that it
does not collapse my question into a simpler but incorrect subject switch or
broad search agenda.

**Why this priority**: Many continuity failures come from the model overcommitting
when the user asked something relational or ambiguous.

**Independent Test**: Can be fully tested by sending relation and ambiguous
follow-up prompts and confirming the system either keeps the existing trusted
subject or marks the turn unresolved rather than inventing certainty.

**Acceptance Scenarios**:

1. **Given** a user asks a relation question involving the carried subject and a
   second named entity, **When** the rewrite is produced, **Then** the system
   MUST keep the main subject and related entity distinct in the structured
   interpretation even if retrieval still runs on the rewritten query.
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
rewrite diagnostics so that I can see whether a turn was rewritten, fell back,
or remained unresolved and why.

**Why this priority**: Silent drift is hard to debug unless the decision path is
captured in a structured way.

**Independent Test**: Can be fully tested by reviewing diagnostics emitted for
rewritten turns and confirming they record the rewrite proposal, validation
result, and whether trusted subject state changed.

**Acceptance Scenarios**:

1. **Given** a turn uses rewrite assistance, **When** the turn completes,
   **Then** diagnostics MUST record the rewrite proposal, whether rewrite ran,
   and the continuity annotation that was kept for that turn.

### Edge Cases

- The current turn names a new explicit subject while also containing pronouns
  that refer to the previous subject.
- The rewrite returns malformed, partial, or overconfident structured data.
- The rewrite introduces a subject not present in the current turn, prior
  trusted state, or retrieved evidence.
- The rewrite turns an unresolved or comparative user message into a single,
  confident subject claim.
- A follow-up pricing or availability question depends on a concrete title that
  only appeared in the immediately prior grounded assistant answer.
- A multilingual follow-up mixes languages while preserving the same subject.
- A comparative question refers to two entities but does not identify which one
  should become the active subject afterward.
- A rewrite broadens a simple visit/purchase question into a checklist or
  research agenda that the user did not ask for.

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
  remains in a focused rewrite service or gateway, and continuity annotations
  remain additive diagnostics rather than persisted conversation state.
- **Encapsulation Rule**: `backend/src/modules/retrieval/services/retrievalPipelineService.ts`
  MUST remain an orchestrator that composes rewrite, one active semantic search
  path, lexical retrieval, reranking, and prompt assembly rather than owning
  detailed prompt policy itself.
- **Encapsulation Rule**: `backend/src/modules/retrieval/services/queryRewriteService.ts`
  MUST remain responsible for obtaining and normalizing rewrite proposals and
  MUST NOT become the sole authority for active-subject changes.
- **New Seams Required**: Introduce an explicit structured rewrite result type,
  bounded carry-forward context for rewrite, and focused prompt/usability rules
  that reject abstract or over-broadened rewrites before retrieval uses them.
- **Anti-Goals**: Do not let rewrite output alone replace trusted conversation
  state. Do not turn simple user questions into checklists or research agendas.
  Do not bury rewrite noise handling inside route handlers.

## Scope Boundaries

- In scope: structured rewrite proposals, bounded carry-forward rewrite hints,
  active-query selection for retrieval, safe fallback behavior, anti-noise
  rewrite rules, dedicated rerank model configuration, and additive diagnostics
  for rewrite outcomes.
- Out of scope: new user-facing controls, a general conversation-memory
  redesign, replacing the retrieval stack, dual raw-vs-rewritten semantic
  retrieval comparison, or allowing rewrite output to author subject continuity
  state by itself.

## Decision Definitions

- **Materially different standalone query** means the rewrite changes the
  subject reference, resolves ellipsis or pronouns into named entities, or adds
  necessary standalone context that could change retrieval results. Surface
  cleanup, wording polish, translation-only normalization that keeps the same
  grounded subject, or paraphrases that do not change retrievable meaning do not
  qualify.
- **Rewrite carry-forward hint** means a bounded snippet from the immediately
  previous assistant answer that may supply concrete retrieval literals such as
  titles, names, or identifiers without being treated as user-authored
  grounding.
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
- **FR-003**: The system MUST choose a single active semantic retrieval query at
  runtime: the rewritten query when it is usable and materially different,
  otherwise the raw user query.
- **FR-004**: The system MUST provide the rewrite layer with a bounded
  carry-forward hint from the immediately previous assistant answer when one is
  available.
- **FR-005**: The system MUST allow concrete titles, names, or identifiers from
  that bounded carry-forward hint to appear in `rewrittenQuery` without
  treating them as user-authored grounding.
- **FR-006**: The system MUST prefer an explicit subject stated in the current
  turn over any carried subject from prior turns.
- **FR-007**: The system MUST keep related entities separate from the proposed
  main subject for relation or comparative turns.
- **FR-008**: The system MUST preserve ambiguity by keeping the rewrite proposal
  annotated as unresolved when the user has not clearly picked one concrete
  referent.
- **FR-009**: The system MUST prevent rewrite output from becoming the sole
  reason a new conversation subject is trusted or persisted.
- **FR-010**: The system MUST fall back safely when the rewrite is malformed,
  unavailable, or judged unusable for retrieval.
- **FR-011**: The system MUST reject abstract meta-rewrites such as "the user
  referred to" or "when asking ..." from becoming active retrieval queries.
- **FR-012**: The system MUST reject rewrite expansions that broaden a simple
  user question into a checklist, itinerary, or research agenda the user did
  not ask for.
- **FR-013**: The system MUST record diagnostics for rewritten turns that show
  the rewrite proposal, whether rewritten retrieval was run, and the continuity
  annotation kept for the turn.
- **FR-013**: The system MUST fall back safely to raw-query behavior when the
  rewrite output is unavailable, malformed, or unusable.
- **FR-014**: The system MUST preserve existing behavior for standalone queries
  that already identify their subject clearly in the current turn.
- **FR-015**: The system MUST preserve ambiguous, comparative, and relation turn
  types in the structured rewrite output and MUST NOT coerce them into fresh
  subject turns without grounding evidence.
- **FR-016**: The system MUST define rewrite retrieval eligibility from the
  structured rewrite itself and skip rewritten retrieval when the proposal is
  not materially different or is unusable for retrieval.
- **FR-017**: The system MUST treat an explicit current-turn subject as higher
  priority than any related entity named in the same turn unless the turn
  explicitly recenters on that related entity.
- **FR-018**: The system MUST support a dedicated fast rerank model separate
  from the main chat or rewrite model, with low-token rerank requests.

### Key Entities *(include if feature involves data)*

- **Structured Rewrite Result**: The rewrite layer's proposal for interpreting
  the current turn, including standalone query text, turn kind, candidate main
  subject, related entities, unresolved flag, and confidence.
- **Rewrite Carry-Forward Hint**: A bounded snippet from the immediately
  previous assistant answer that can supply concrete retrieval literals without
  becoming user-authored grounding.
- **Rewrite Eligibility Decision**: The decision that determines whether the
  structured rewrite is materially different and usable enough to justify
  becoming the active semantic retrieval query.

## Assumptions

- This feature is backend-only unless existing diagnostics contracts require
  additive response fields.
- The system may keep using rewrite assistance for multilingual and elliptical
  follow-ups, but only within bounded anti-noise and fallback guardrails.
- The feature does not introduce a broader conversation-memory redesign beyond
  additive rewrite annotations for retrieval.
- Any persistence changes are limited to additive diagnostics already allowed by
  the active technology notes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In the approved regression suite for referential follow-ups, at
  least 90% of turns retrieve supporting context for the intended subject
  without requiring the user to restate that subject explicitly.
- **SC-002**: In the approved regression suite, meta-rewrites such as "the user
  referred to" are rejected from becoming active retrieval queries 100% of the
  time.
- **SC-003**: In the approved regression suite, checklist or itinerary
  broadening rewrites are rejected from becoming active retrieval queries 100%
  of the time.
- **SC-004**: In 100% of turns where rewrite assistance is attempted,
  diagnostics show whether rewrite was proposed, whether rewritten retrieval was
  executed, and the continuity annotation kept for the turn.
