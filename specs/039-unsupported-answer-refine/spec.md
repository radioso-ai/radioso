# Feature Specification: Conversational Unsupported Answers

**Feature Branch**: `039-unsupported-answer-refine`  
**Created**: 2026-04-15  
**Status**: Draft  
**Input**: User description: "Refine the existing unsupported-answer policy so that when the requested answer is unsupported, the assistant responds more naturally and, when possible, points to the closest grounded material already retrieved, without introducing any new ungrounded fallback mode."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Helpful Unsupported Response From Retrieved Material (Priority: P1)

As a chat user, I want an unsupported answer to sound helpful and
conversational instead of ending with a generic refusal so I can continue the
conversation using the material that was actually found.

**Why this priority**: This is the core user-value change. If unsupported
answers remain dead-ending, the existing policy protects trust but leaves users
with little guidance about what to do next.

**Independent Test**: Can be fully tested by asking a question whose exact
answer is unsupported while retrieval still returns related material, then
verifying that the final response explicitly states the miss and offers a
grounded adjacent direction based only on retrieved material.

**Acceptance Scenarios**:

1. **Given** retrieval returns related material but not support for the exact
   requested answer, **When** the assistant responds under the existing
   unsupported-answer policy, **Then** the response states that the requested
   answer was not supported and offers the closest grounded topic or source from
   the retrieved material.
2. **Given** retrieved material includes one clearly relevant adjacent source,
   **When** the unsupported-answer response is generated, **Then** the response
   may invite the user to explore that source rather than presenting it as a
   direct answer to the original question.
3. **Given** the unsupported-answer response references adjacent retrieved
   material, **When** the user reads the response, **Then** it is clear which
   part is the unsupported miss and which part is the grounded next-step
   suggestion.

---

### User Story 2 - Safe No-Context Response Without Scope Expansion (Priority: P2)

As a workspace operator, I want no-context responses to feel natural and useful
without silently switching the product into generic model-answer mode so trust
in document grounding is preserved.

**Why this priority**: No-context behavior is closely related to the unsupported
answer experience, but the product contract becomes unsafe if a wording
improvement accidentally introduces an ungrounded fallback lane.

**Independent Test**: Can be fully tested by asking a question that retrieves
no relevant material and verifying that the response remains explicit about the
absence of supporting material while avoiding a hard-coded dead-end phrase.

**Acceptance Scenarios**:

1. **Given** no relevant material is retrieved, **When** the assistant responds,
   **Then** the response explicitly says that no supporting material was found
   in the workspace and does not present an answer as if it came from the
   documents.
2. **Given** no relevant material is retrieved, **When** the assistant offers a
   next step, **Then** that next step is framed as conversational guidance
   rather than a grounded answer or a generic knowledge fallback.
3. **Given** no relevant material is retrieved, **When** the response is
   generated, **Then** it does not imply that the system searched beyond the
   workspace materials for the answer.

---

### User Story 3 - Preserve Existing Policy Semantics And Diagnostics (Priority: P3)

As an operator debugging chat behavior, I want the refinement to stay within
the current unsupported-answer policy architecture so I can preserve existing
policy expectations, diagnostics, and audit meaning.

**Why this priority**: The change should improve presentation, not create a new
answer mode that complicates policy behavior, diagnostics, or rollout risk.

**Independent Test**: Can be fully tested by exercising supported, unsupported,
and no-context chat turns and confirming that the feature changes the visible
response style without weakening existing safety boundaries or hiding outcome
states.

**Acceptance Scenarios**:

1. **Given** a turn is classified as unsupported under the existing policy
   path, **When** the response is delivered, **Then** the feature refines only
   the user-visible wording and grounded next-step behavior rather than adding a
   separate answer mode.
2. **Given** a turn has no retrieved context, **When** the response is
   delivered, **Then** the no-context outcome remains distinguishable from a
   grounded answer and from a partially unsupported grounded answer.
3. **Given** an operator inspects stored diagnostics after the feature ships,
   **When** they compare outcomes across supported, unsupported, and no-context
   turns, **Then** the existing trust and debugging signals remain interpretable
   without a new fallback classification.

### Edge Cases

- What happens when retrieval returns material that is only weakly related and
  there is no honest adjacent topic worth suggesting?
- What happens when multiple adjacent retrieved topics are plausible and the
  system should avoid sounding overconfident about which one is best?
- What happens when the unsupported answer text is already conversational and
  only needs a small rewrite to become helpful?
- What happens when the user asks for a specific artifact such as a recipe,
  policy, or date, but retrieved material only supports a broader theme?
- What happens when no relevant contexts are retrieved and the safest response
  is a concise miss with no grounded suggestion at all?
- What happens when retrieved adjacent material is in a different language than
  the user's question?

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
- Any operator-facing wording or documented behavior changes to answer-support
  settings or chat outcomes MUST update the corresponding documentation in the
  same feature.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Retrieval continues to own candidate search and context
  assembly, chat orchestration continues to decide which answer path runs for a
  turn, and focused answer-presentation or unsupported-notice modules own the
  final user-visible wording for unsupported and no-context outcomes.
- **Encapsulation Rule**: `backend/src/modules/chat/services/chatService.ts`
  MUST remain orchestration-only and MUST NOT absorb bespoke wording-selection
  logic. Retrieval pipeline services MUST remain responsible for retrieval, not
  for composing conversational unsupported-answer copy. Frontend chat surfaces
  MUST remain renderers of backend-provided answer text rather than inventing
  their own unsupported fallback copy.
- **New Seams Required**: Introduce or extend a focused backend seam for
  composing conversational unsupported/no-context responses from bounded inputs
  such as the user query, retrieval result summary, and current outcome type.
- **Anti-Goals**: Do not add a new generic persona-answer mode. Do not use
  model inference outside retrieved material to answer the original question. Do
  not blur the distinction between no-context refusal and grounded-but-unsupported
  outcomes. Do not push product wording rules into route handlers, retrieval
  services, or frontend presentation code.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST refine the existing unsupported-answer behavior so
  the final visible response sounds conversational rather than like a hard-coded
  dead-end refusal.
- **FR-002**: When the exact requested answer is unsupported but retrieval
  returned related material, the response MUST explicitly say that the requested
  answer could not be supported from the available material.
- **FR-003**: When the exact requested answer is unsupported but retrieval
  returned related material, the response MUST be allowed to point the user
  toward the closest grounded topic, source, or direction already present in the
  retrieved material.
- **FR-004**: Any adjacent suggestion in an unsupported-answer response MUST be
  derived only from material already retrieved for that turn and MUST NOT depend
  on generic model knowledge outside the workspace.
- **FR-005**: An adjacent suggestion MUST be phrased as a next step or
  exploration prompt rather than as a direct answer to the original unsupported
  question.
- **FR-006**: When no relevant material is retrieved, the response MUST remain
  explicit that supporting material was not found in the workspace.
- **FR-007**: When no relevant material is retrieved, the response MAY offer a
  conversational next step, but it MUST NOT present an answer as if it were
  grounded in workspace materials.
- **FR-008**: If the retrieved material does not support an honest adjacent
  suggestion, the system MUST return a concise conversational miss rather than
  inventing a topic pivot.
- **FR-009**: The feature MUST refine the current unsupported-answer and
  no-context presentation behavior without introducing a new answer-support
  policy mode or a new generic fallback classification.
- **FR-010**: The feature MUST preserve the existing distinction between
  grounded success, grounded degraded unsupported segments, and no-context
  refusal in stored outcomes and diagnostics unless a documented contract update
  is explicitly required.
- **FR-011**: The feature MUST preserve existing retrieval and support-detection
  boundaries; it must not change retrieval ranking, query rewriting, or support
  classification semantics as part of this refinement.
- **FR-012**: The feature MUST keep unsupported and no-context responses in the
  same language as the current user question when possible.
- **FR-013**: The feature MUST include automated backend coverage for unsupported
  responses with adjacent grounded suggestions, unsupported responses with no
  honest suggestion, and no-context responses.
- **FR-014**: Operator-facing docs that describe answer-support policy or no-context
  behavior MUST be updated to reflect the refined response style and its
  grounding limits.

### Key Entities *(include if feature involves data)*

- **Unsupported Answer Response**: The final user-visible response shown when
  the requested answer is not fully supported, including the explicit miss and
  any grounded adjacent suggestion.
- **No-Context Response**: The final user-visible response shown when no
  relevant workspace material was retrieved for the turn.
- **Adjacent Grounded Suggestion**: A bounded conversational prompt that points
  the user toward a nearby topic or source already present in retrieved
  material, without claiming to answer the original unsupported question.

## Assumptions

- This feature refines the existing unsupported-answer policy behavior rather
  than introducing a new product mode.
- The current retrieval pipeline already exposes enough bounded information
  about retrieved contexts to support a safe adjacent suggestion without adding
  a second retrieval pass.
- The refinement is primarily backend-owned because the backend already owns the
  answer text and outcome classification for chat turns.
- Existing diagnostics and outcome enums remain stable unless implementation
  discovery proves that a small additive clarification is required.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In regression coverage for this feature, 100% of unsupported turns
  with related retrieved material produce a response that both states the miss
  and limits any suggestion to retrieved material.
- **SC-002**: In regression coverage for this feature, 100% of no-context turns
  remain explicit about missing supporting workspace material and do not return
  an answer framed as grounded.
- **SC-003**: In regression coverage for this feature, 100% of unsupported and
  no-context turns preserve the existing outcome distinctions relied on by
  diagnostics and history views.
- **SC-004**: In product review of representative unsupported/no-context
  examples, the refined responses are judged more natural and helpful than the
  prior hard-coded wording while preserving the product's grounding contract.
