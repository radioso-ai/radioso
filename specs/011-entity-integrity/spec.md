# Feature Specification: Generalized Entity Integrity in Retrieval Grounding

**Feature Branch**: `011-entity-integrity`  
**Created**: 2026-03-16  
**Status**: Draft  
**Input**: User description: "Generalize retrieval grounding fixes to preserve entity integrity across people, products, places, organizations, events, and documents"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Preserve Single-Entity Answers (Priority: P1)

As a chat user asking about one real-world subject, I want the answer to remain grounded in facts about that same subject so that the system does not merge attributes from different entities into a single response.

**Why this priority**: This is the core trust problem. If the system fuses facts across different entities, grounding and citations stop being credible.

**Independent Test**: Can be fully tested by asking a single-entity question against a corpus containing overlapping facts for multiple entities and confirming the answer cites only one subject cluster.

**Acceptance Scenarios**:

1. **Given** retrieved contexts include chunks about two different entities with overlapping attributes, **When** the user asks a single-entity identity question, **Then** the answer attributes facts only to the intended entity or refuses to answer if the context is ambiguous.
2. **Given** a retrieved chunk contains pronouns or partial facts without an explicit subject name, **When** the system evaluates it for a single-entity answer, **Then** the chunk is anchored to an entity context before use or downranked as unsafe.

---

### User Story 2 - Respect Corrections and Disambiguation (Priority: P2)

As a chat user correcting a previous answer, I want the system to reinterpret the next turn as a correction or disambiguation so that it does not repeat the same blended answer.

**Why this priority**: Once a wrong answer is shown, the product must recover quickly instead of reinforcing the mistake.

**Independent Test**: Can be tested by asking an initial question that yields competing entity candidates, then sending a correction such as "No, I meant X, not Y" and verifying the next answer is re-grounded to the corrected subject.

**Acceptance Scenarios**:

1. **Given** the previous turn surfaced facts from competing entities, **When** the user says "I meant X, not Y," **Then** the next answer favors contexts consistent with X and suppresses conflicting contexts about Y.
2. **Given** the user says "X is not Y" after an incorrect answer, **When** retrieval reruns, **Then** the answer either corrects the attribution or reports that the retrieved evidence remains ambiguous instead of restating the prior blended claim.

---

### Edge Cases

- Two different entities share the same display name or alias.
- A chunk contains only pronouns, dates, or attributes and relies on nearby headings for subject identity.
- The top semantic matches contain multiple plausible entities and reranking is unavailable.
- The user asks for an explicit comparison between two entities; the system must not treat that as a single-entity query.
- The user asks a generic category question with no single target entity; the system must avoid over-constraining retrieval.
- Source titles are generic and do not identify the subject unless heading or page metadata is propagated.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated if configuration changes.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Any user-visible debugging information MUST avoid exposing sensitive document content beyond existing retrieval details behavior.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Document ingestion and chunk preparation own subject identity extraction and chunk metadata; retrieval services own candidate scoring, grouping, and selection; chat orchestration owns correction-aware retrieval invocation and answer assembly; HTTP presenters remain transport-only.
- **Encapsulation Rule**: [chatService.ts](/Users/dm/code/hivec-entity-integrity/backend/src/modules/chat/services/chatService.ts) must remain orchestration-only and must not absorb entity parsing, ranking, or verification rules. [promptBuilder.ts](/Users/dm/code/hivec-entity-integrity/backend/src/modules/retrieval/services/promptBuilder.ts) must remain prompt assembly only and must not become the primary home for retrieval policy.
- **New Seams Required**: The design must introduce focused modules for generalized entity target detection, chunk subject identity enrichment, candidate subject grouping or penalties, and answer-time entity consistency checks.
- **Anti-Goals**: Do not hardcode person-specific logic. Do not solve this by manual source-data patches alone. Do not bury entity rules inside route handlers, citation presentation, or generic utility files. Do not depend on reranker availability as the only safeguard.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST infer whether a query is targeting a single entity, comparing multiple entities, or correcting a prior entity attribution.
- **FR-002**: The system MUST enrich chunks or retrieval candidates with generalized subject identity signals that can apply to people, products, places, organizations, events, or documents.
- **FR-003**: The system MUST preserve or reattach section, heading, or page context needed to interpret subject-less chunks whose content does not explicitly name their subject.
- **FR-004**: For single-entity queries, the system MUST favor contexts that agree on the same subject identity and downrank or exclude contexts that appear to belong to competing subjects.
- **FR-005**: For explicit comparison queries, the system MUST allow multiple subject groups and keep their facts separated in the answer.
- **FR-006**: For correction or disambiguation follow-ups, the system MUST reinterpret retrieval using the user’s correction signal instead of treating the turn as an unrelated broad semantic query.
- **FR-007**: If retrieved evidence remains split across competing subjects after filtering and reranking, the system MUST avoid blended attribution and instead answer conservatively or state that the evidence is ambiguous.
- **FR-008**: The answer assembly flow MUST perform a final consistency safeguard that detects when facts from different subject groups are being attributed to one entity and prevents that response from being returned unchanged.
- **FR-009**: The feature MUST preserve existing grounding behavior for queries that do not target a specific entity, unless the new safeguards are necessary to avoid an incorrect attribution.
- **FR-010**: The system MUST include backend automated tests covering at least mixed-entity contamination, correction-aware reretrieval, and explicit multi-entity comparison behavior.

### Key Entities *(include if feature involves data)*

- **Target Entity Interpretation**: The system’s understanding of the subject or subjects implied by the current query and recent conversation context, including whether the turn is a single-entity question, correction, or comparison.
- **Subject Identity Signal**: A generalized set of chunk- or candidate-level cues that indicate what entity a piece of evidence is about, such as labels, aliases, headings, page context, or source-local identity markers.
- **Subject Group**: A retrieval-time grouping of candidates that the system considers to refer to the same underlying entity for answer grounding.
- **Entity Integrity Decision**: The retrieval or answer-time decision to keep evidence together, split it into competing groups, or reject a blended attribution.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In automated mixed-entity test fixtures, single-entity queries return answers that attribute facts to only one subject group in at least 95% of covered cases.
- **SC-002**: In automated correction-turn fixtures, a follow-up correction produces a materially different retrieval outcome aligned with the corrected entity in at least 90% of covered cases.
- **SC-003**: Explicit multi-entity comparison fixtures keep facts for each compared entity separated in the generated answer across all covered regression cases.
