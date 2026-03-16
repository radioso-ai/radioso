# Feature Specification: Conversational Subject Continuity

**Feature Branch**: `012-subject-carry-forward`  
**Created**: 2026-03-16  
**Status**: Draft  
**Input**: User description: "Preserve subject continuity across chat turns by carrying forward a trusted grounded subject into retrieval rewrite and retrieval selection for referential follow-up questions without altering the user-visible message."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Keep Follow-Ups On Subject (Priority: P1)

As a chat user continuing a conversation about the same subject with shorthand, referential, or context-dependent wording, I want the system to keep retrieving information about that grounded subject so that the answer does not drift to a different person, place, product, or document.

**Why this priority**: This is the primary trust failure being addressed. If follow-up turns lose the subject, retrieval grounding becomes unreliable even when the earlier turn was correct.

**Independent Test**: Can be fully tested by asking a first-turn question that grounds on one subject, then a context-dependent follow-up such as "Can I buy her book?", "What about his later work?", or an equivalent multilingual shorthand turn, and verifying retrieval remains anchored to the previously grounded subject.

**Acceptance Scenarios**:

1. **Given** a previous grounded turn resolved to a single trusted subject, **When** the user asks a context-dependent follow-up that does not fully restate the subject, **Then** retrieval uses that trusted subject to interpret the follow-up without changing the stored or displayed user message.
2. **Given** rewrite assistance is unavailable, **When** the user asks a context-dependent follow-up after a trusted grounded turn, **Then** the system falls back to deterministic subject-aware retrieval behavior rather than dropping the subject entirely.

---

### User Story 2 - Drop Stale Subject Bias When Topic Changes (Priority: P1)

As a chat user changing topics after asking about one subject, I want the system to stop carrying the old subject forward as soon as the new turn clearly points elsewhere so that retrieval does not over-index on stale context.

**Why this priority**: Subject carry-forward is only safe if the system can abandon it quickly when the conversation shifts to a new subject or becomes ambiguous.

**Independent Test**: Can be fully tested by grounding one turn on subject A, then asking a later turn that explicitly names subject B or produces current-turn evidence split away from A, and verifying the old subject is not silently forced onto the new retrieval.

**Acceptance Scenarios**:

1. **Given** the previous grounded turn resolved to subject A, **When** the next user turn explicitly names subject B, **Then** the system prefers the current-turn subject over the carried subject and does not bias retrieval toward A.
2. **Given** the previous grounded turn resolved to a single subject, **When** current-turn retrieval evidence is ambiguous or converges on a different subject, **Then** the system clears or replaces the carried subject instead of persisting the old one.

---

### User Story 3 - Preserve Safe Multi-Subject And Ambiguous Behavior (Priority: P2)

As a chat user asking for comparisons or asking questions whose retrieved evidence remains split, I want the system to avoid forcing a single carried subject so that comparisons stay separated and ambiguous evidence does not become a confident but wrong answer.

**Why this priority**: Carry-forward must improve single-subject continuity without damaging comparison flows or turning ambiguous evidence into a silent wrong rewrite.

**Independent Test**: Can be fully tested by asking comparison questions and ambiguous context-dependent follow-ups after a grounded turn, then verifying the system either keeps multiple subjects separate or leaves the subject unresolved.

**Acceptance Scenarios**:

1. **Given** a prior turn involved multiple explicit subjects, **When** the next turn remains comparative, **Then** the system keeps those subjects separated instead of collapsing them into one carried subject.
2. **Given** current retrieval evidence remains split across competing subjects, **When** the system evaluates whether to carry a subject forward, **Then** it leaves the subject unresolved and avoids a silent single-subject rewrite.

### Edge Cases

- The first user turn names a subject directly, but the system should not require pre-retrieval subject extraction to answer it.
- A follow-up query uses shorthand or referential wording, including multilingual object-pronoun equivalents, and the system must preserve subject continuity without depending on language-specific regex templates.
- A previous turn was grounded on one subject, but the next turn explicitly names a different subject.
- A previous turn was ambiguous or comparative, so no single trusted subject should be carried forward.
- Retrieval with and without carried-subject bias points to different subject clusters on the current turn.
- A carried subject exists, but the current turn is self-contained and should not be treated as referential.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated only if configuration changes are required.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Any new diagnostics or persisted retrieval state MUST avoid exposing more raw document content than existing chat and retrieval flows already expose.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Chat orchestration owns when retrieval runs and what history is supplied, retrieval-domain services own subject carry-forward state decisions, normalized subject identity, convergence rules, and raw-versus-biased retrieval comparison, query rewriting owns standalone retrieval-query construction from structured inputs, prompt assembly owns answer prompt formatting only, and persistence layers own storage of any conversation-scoped retrieval state if storage is required.
- **Encapsulation Rule**: `backend/src/modules/chat/services/chatService.ts` must remain orchestration-only and must not absorb subject-resolution heuristics or convergence scoring. `backend/src/modules/retrieval/services/promptBuilder.ts` must remain prompt assembly only and must not become the home for hidden subject injection or topic-change policy. HTTP routes and presenters must remain transport-only.
- **New Seams Required**: The design must introduce or refine a focused retrieval-state seam for trusted subject carry-forward, a normalized subject identity seam or equivalence-class seam for comparing candidate subjects, a deterministic convergence decision seam for whether a subject is safe to persist or reuse, and a topic-change safeguard seam that can clear or replace the carried subject based on current-turn evidence.
- **Anti-Goals**: Do not rewrite the stored user message. Do not treat generative subject guesses as authoritative retrieval state. Do not make carried-subject behavior sticky across unrelated turns without revalidation. Do not solve first-turn subject detection by brittle hard-coded question templates alone. Do not bury carry-forward policy inside prompt text.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST preserve the raw user message unchanged for storage, history display, and answer generation even when subject carry-forward influences retrieval.
- **FR-002**: The system MUST define a trusted conversation-scoped `resolvedSubject` state that represents a single subject grounded by prior retrieval evidence rather than a fresh generative guess.
- **FR-003**: The system MUST set `resolvedSubject` only when the current turn's grounded retrieval evidence converges on exactly one normalized subject identity according to explicit deterministic decision rules.
- **FR-004**: The system MUST make the convergence decision depend on current retrieved evidence concentration, support count, score mass, winning-subject margin, or equivalent deterministic signals rather than relying only on the previous user-message text.
- **FR-005**: The system MUST allow a context-dependent follow-up turn to use the trusted `resolvedSubject` as structured input to retrieval rewrite when that state exists and the current turn is not self-contained.
- **FR-006**: The system MUST provide a deterministic fallback path that can use the trusted `resolvedSubject` for retrieval when rewrite assistance is unavailable or unusable.
- **FR-007**: The system MUST support context-dependent follow-up turns across supported languages without making language-specific regex templates or hard-coded pronoun lists the primary mechanism for deciding whether subject carry-forward applies.
- **FR-008**: The system MUST prefer explicit subject signals present in the current user turn over any previously carried subject.
- **FR-009**: The system MUST revalidate the subject on every turn and MUST clear, replace, or leave it unresolved when current-turn retrieval evidence no longer supports the previously carried subject.
- **FR-010**: The system MUST NOT carry a single `resolvedSubject` forward from turns that are explicitly comparative, multi-subject, or still ambiguous after retrieval evaluation.
- **FR-011**: When current-turn retrieval with carried-subject bias and current-turn raw retrieval disagree materially about the winning subject, the system MUST treat that as a topic-change or ambiguity signal rather than forcing the prior subject.
- **FR-012**: The system MUST preserve safe behavior for first-turn named-subject queries by allowing retrieval to answer from the raw query first and only establishing `resolvedSubject` after retrieval converges.
- **FR-013**: The system MUST preserve comparison behavior by keeping multiple named subjects separate rather than collapsing them into one carried subject.
- **FR-014**: The system MUST expose enough diagnostics in existing retrieval-execution information to explain whether a trusted subject was reused, newly established, replaced, cleared, or left unresolved.
- **FR-015**: The system MUST include automated backend coverage for first-turn subject establishment, context-dependent follow-ups, multilingual shorthand or object-reference follow-ups, explicit topic changes, ambiguous follow-ups, and multi-subject comparison flows.
- **FR-016**: The system MUST avoid introducing hidden answer-generation prompt text that implies the user literally asked with the carried subject when they did not.
- **FR-017**: The system MUST compute subject convergence over normalized subject identities or equivalence classes rather than raw chunk surface-form labels alone.
- **FR-018**: The system MUST treat disagreement between raw retrieval and subject-biased retrieval as a first-class decision input before reusing a carried subject.
- **FR-019**: The system MUST distinguish topic change from focus narrowing or relation shift when current-turn retrieval converges on a related but different subject, and MUST avoid silently treating every such case as simple subject reuse.
- **FR-020**: The system MUST treat low-content, elliptical, shorthand, and zero-pronoun follow-up turns as eligible for subject continuity evaluation even when no explicit pronoun is present.
- **FR-021**: Diagnostics MUST record the evidence metrics used in the convergence decision, including the winning subject identity, runner-up identity when present, support counts or equivalent support signals, and disagreement between retrieval paths.

### Key Entities *(include if feature involves data)*

- **Resolved Subject**: A conversation-scoped retrieval-state value representing one grounded subject that prior retrieval evidence judged safe to reuse for referential follow-up interpretation.
- **Normalized Subject Identity**: The canonical identity or equivalence class used to compare subject references across aliases, surface forms, or other retrieval labels that refer to the same underlying subject.
- **Subject Convergence Decision**: The deterministic evaluation of whether current retrieved evidence is concentrated enough on one normalized subject identity to establish or retain a `resolvedSubject`.
- **Context-Dependent Follow-Up Turn**: A user turn whose wording depends on prior context, such as shorthand references, continuations, or elliptical follow-ups that do not fully restate the subject.
- **Topic-Change Signal**: Any current-turn evidence showing that the prior `resolvedSubject` should not be reused, such as an explicitly named new subject or a materially different converged subject in current retrieval.
- **Subject Reuse Outcome**: The per-turn result describing whether the trusted subject was reused, newly set, replaced, cleared, or left unresolved.

## Assumptions

- The first release can rely on existing chunk-level `subjectLabel` behavior and retrieval diagnostics rather than requiring a new dedicated chunk subject column immediately.
- A single trusted `resolvedSubject` is enough for the first release; richer multi-subject conversation memory is outside scope.
- Existing conversation history is sufficient for signaling context-dependent follow-up behavior, but the carry-forward decision itself must come from retrieval evidence rather than only history text.
- If persistence is needed for `resolvedSubject`, it can be scoped to existing conversation-level storage patterns rather than introducing a new external state system.
- The first release may treat relation-shift handling, such as person to book or company to product, as a bounded limitation so long as the system does not silently mislabel the new focus as ordinary subject reuse.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In automated regression coverage for context-dependent follow-up fixtures, at least 95% of covered single-subject follow-ups retrieve contexts aligned with the previously grounded subject.
- **SC-002**: In automated topic-change fixtures, 100% of turns that explicitly name a new subject stop reusing the previous carried subject.
- **SC-003**: In automated ambiguity fixtures, 100% of cases with split competing subject evidence avoid persisting a misleading single `resolvedSubject`.
- **SC-004**: In automated comparison fixtures, 100% of covered multi-subject turns preserve separate subject groups instead of collapsing to one carried subject.
- **SC-005**: In automated first-turn fixtures for named subjects, the system establishes a reusable `resolvedSubject` only after current-turn retrieval converges, with no requirement for pre-retrieval hard-coded question parsing.
