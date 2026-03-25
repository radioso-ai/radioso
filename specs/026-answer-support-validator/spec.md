# Feature Specification: Answer Support Validator

**Feature Branch**: `026-answer-support-validator`  
**Created**: 2026-03-25  
**Status**: Draft  
**Input**: User description: "Add post-generation answer support validation and downgrade persistence/audit outcomes when unsupported segments are found, preserving supported segments and replacing unsupported ones with an explicit unsupported notice."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Strip Unsupported Segments Before Delivery (Priority: P1)

An end user asking a mixed or partially unsupported question wants the assistant
to keep only the answer parts that are actually supported by retrieved material,
so unsupported content is not delivered as if it were grounded.

**Why this priority**: This is the enforcement point that turns grounding from a
best-effort prompt behavior into a product guarantee.

**Independent Test**: Can be fully tested by asking a question that combines one
document-grounded request with one unsupported request and verifying that the
returned answer preserves only the supported portion while replacing unsupported
segments with an explicit unsupported notice.

**Acceptance Scenarios**:

1. **Given** a chat answer draft contains both supported and unsupported
   segments, **When** the system validates the draft before final delivery,
   **Then** the system keeps the supported segments and replaces each
   unsupported segment with an explicit unsupported notice.
2. **Given** a chat answer draft contains only unsupported substantive content,
   **When** the system validates the draft, **Then** the final delivered answer
   contains only the safe unsupported-response text and no unsupported
   substantive content from the draft.
3. **Given** a chat answer draft contains only supported segments, **When** the
   system validates the draft, **Then** the delivered answer remains unchanged
   apart from any required formatting normalization.

---

### User Story 2 - Record Violations As Degraded Outcomes (Priority: P2)

An operator or engineer reviewing chat history and audit records wants
unsupported-answer incidents to be recorded as degraded outcomes rather than
successful grounded answers, so diagnostics and trust metrics reflect what
actually happened.

**Why this priority**: If unsupported content is blocked but the turn is still
recorded as a normal success, the product remains operationally misleading.

**Independent Test**: Can be fully tested by causing a mixed-support answer that
triggers validation and verifying that the persisted turn outcome is downgraded
from a normal grounded success.

**Acceptance Scenarios**:

1. **Given** the validator replaces one or more unsupported segments, **When**
   the system persists the assistant turn and audit metadata, **Then** the turn
   is recorded with a downgraded outcome that distinguishes it from a fully
   grounded success.
2. **Given** the validator finds no unsupported segments, **When** the system
   persists the assistant turn and audit metadata, **Then** the turn continues
   to be recorded as a normal grounded success when retrieved context supported
   the answer.
3. **Given** the retrieval pipeline found no relevant supporting context at all,
   **When** the system returns the existing no-information refusal, **Then** the
   turn is not mislabeled as a validator-triggered degradation.

---

### User Story 3 - Preserve Debuggability Of Validation Decisions (Priority: P3)

An engineer investigating a suspicious answer wants the system to preserve which
segments were kept, replaced, and downgraded, so regressions can be diagnosed
without reconstructing the validation decision from logs or model output alone.

**Why this priority**: Validation that silently rewrites answers without leaving
evidence would reduce user harm but still weaken incident investigation and
quality measurement.

**Independent Test**: Can be fully tested by generating an answer with at least
one unsupported segment, then inspecting the stored turn metadata and verifying
that the validation decision is visible and attributable to that turn.

**Acceptance Scenarios**:

1. **Given** a validator-triggered rewrite occurred, **When** an engineer
   inspects the stored turn diagnostics, **Then** they can determine that the
   answer was modified due to unsupported segments and how many segments were
   affected.
2. **Given** a supported answer passed validation unchanged, **When** an
   engineer inspects the stored turn diagnostics, **Then** they can determine
   that validation ran and found no unsupported segments.

### Edge Cases

- What happens when the draft answer interleaves supported and unsupported
  clauses within the same paragraph rather than clean section boundaries?
- What happens when a draft contains unsupported procedural filler or follow-up
  offers after an otherwise grounded answer?
- How does the system behave when a segment cannot be confidently matched to
  available support evidence and the safest choice is to treat it as
  unsupported?
- What happens when the answer contains only greetings, confirmations, or other
  low-information conversational text alongside grounded content?
- How does the system behave when retrieval returned grounded context but the
  model omitted or malformed support references for one or more substantive
  segments?

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in
  React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- Backend development MUST follow TDD: tests written and failing before
  implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example`
  MUST be updated.
- Customer data MUST be protected with least-privilege access and secure
  transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration,
  domain logic, and persistence.
- Specs MUST identify files or modules that should remain
  responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Chat routes and SSE presenters remain transport-only,
  `ChatService` remains orchestration-only, support validation rules live in a
  focused chat or retrieval domain service, and repositories remain
  persistence-only.
- **Encapsulation Rule**: Prompt-building and answer-generation modules may
  supply evidence markers for validation, but they MUST NOT own the final
  decision about whether unsupported content may be delivered or persisted.
- **New Seams Required**: The feature MUST introduce a focused post-generation
  answer support validator and a separate answer-outcome classification seam so
  validation and persistence downgrade logic can be unit tested without HTTP
  handlers or repository wiring.
- **Anti-Goals**: Do not rely on prompt wording alone to prevent unsupported
  content. Do not implement validation as a frontend-only safeguard. Do not
  hide validator-triggered rewrites behind a normal grounded-success outcome. Do
  not push support-validation policy into route handlers, presenters, or generic
  persistence repositories.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST validate each generated assistant answer after
  generation and before the final answer is delivered or persisted whenever
  retrieved context was available for grounding.
- **FR-002**: The validator MUST evaluate answer content at a segment level
  rather than only as one whole-answer boolean so supported and unsupported
  content can be treated differently within the same answer.
- **FR-003**: The validator MUST classify each substantive answer segment as
  either supported by retrieved evidence, unsupported, or non-substantive
  conversational text that may be retained without grounding risk.
- **FR-004**: When one or more substantive segments are unsupported, the system
  MUST replace those segments in the final delivered answer with an explicit
  unsupported notice instead of delivering the original unsupported content.
- **FR-005**: When all substantive segments are unsupported, the final delivered
  answer MUST contain only the safe unsupported-response content rather than any
  unsupported draft content.
- **FR-006**: When all substantive segments are supported, the final delivered
  answer MUST preserve the generated grounded content aside from formatting
  normalization needed to produce the final answer shape.
- **FR-007**: The validator MUST be driven by explicit support references or
  equivalent support-identification data attached to the generated answer so the
  validation decision is based on inspectable evidence rather than prompt text
  alone.
- **FR-008**: The system MUST downgrade the stored assistant-turn outcome when
  one or more unsupported substantive segments were replaced, so the turn is not
  recorded as a normal grounded success.
- **FR-009**: The downgraded outcome MUST remain distinguishable from both a
  fully grounded success and a no-context refusal caused by having no relevant
  retrieved material.
- **FR-010**: Persisted turn diagnostics MUST record whether validation ran,
  whether the delivered answer was modified, and how many segments were marked
  unsupported.
- **FR-011**: Persisted turn diagnostics MUST preserve enough validation detail
  for engineers to understand why a turn was downgraded without exposing full
  hidden prompts, secrets, or unrestricted raw model output.
- **FR-012**: The feature MUST include automated backend coverage for at least
  one mixed-support answer, one fully supported answer, and one fully
  unsupported drafted answer that reaches validation.
- **FR-013**: Existing no-context refusal behavior MUST continue to work without
  being reclassified as a validator-triggered unsupported-segment downgrade.

### Key Entities *(include if feature involves data)*

- **Answer Segment Validation Result**: The per-segment validation decision that
  states whether a substantive segment is supported, unsupported, or safe
  non-substantive text, along with the evidence references used to make that
  decision.
- **Validated Answer Outcome**: The final post-validation assistant answer,
  including kept segments, replaced unsupported notices, and whether the answer
  was modified before persistence and delivery.
- **Assistant Turn Outcome**: The persisted status for one assistant turn that
  distinguishes grounded success, validator-triggered degradation, and
  no-context refusal.

## Assumptions

- This feature is limited to backend enforcement and persistence classification;
  it does not add new operator-facing UI beyond what existing diagnostics
  surfaces can already consume from stored metadata.
- An explicit unsupported notice may be repeated within an answer if multiple
  unsupported segments are replaced and preserving the supported surrounding
  context still improves user understanding.
- Greetings, thanks, and similar low-information conversational wrappers may be
  retained when they do not introduce unsupported factual or procedural content.
- Internal support references may be richer than the existing user-facing
  citation presentation and do not need to be shown directly to end users in
  this feature.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In regression coverage for this feature, 100% of mixed-support
  drafted answers replace unsupported substantive segments before the final
  answer is delivered.
- **SC-002**: In regression coverage for this feature, 100% of fully supported
  drafted answers remain classified as grounded successes after validation.
- **SC-003**: In regression coverage for this feature, 100% of turns modified by
  the validator are persisted with a downgraded outcome rather than a normal
  grounded-success outcome.
- **SC-004**: In regression coverage for this feature, 100% of no-context
  refusals remain distinguishable from validator-triggered degradation events.
- **SC-005**: In stored-turn diagnostic inspection for validator-triggered
  cases, engineers can determine whether validation ran, whether the answer was
  modified, and how many segments were replaced without requiring ad hoc code
  changes or raw log access.
