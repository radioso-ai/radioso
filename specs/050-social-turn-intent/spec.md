# Feature Specification: Model-Level Social Turn Intent

**Feature Branch**: `050-social-turn-intent`  
**Created**: 2026-04-25  
**Status**: Draft  
**Input**: User description: "Add model-level social and identity turn intent routing so greeting, politeness, thanks, and identity-only turns bypass retrieval and strict unsupported-answer fallback, while mixed turns still retrieve the substantive question and regex-based chat-service routing is removed."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reply Naturally To Social-Only Turns (Priority: P1)

As a chat user, I want greetings, thanks, and lightweight reactions to receive a
natural acknowledgement instead of a document-grounded fallback, so the
assistant feels conversational rather than broken.

**Why this priority**: This is the visible user problem. If social turns still
produce unsupported-answer fallback copy, the feature fails its core purpose.

**Independent Test**: Can be fully tested by sending a greeting, thank-you, or
lightweight reaction with no substantive question and verifying that the system
responds naturally without running the normal grounded-miss path.

**Acceptance Scenarios**:

1. **Given** a user sends a greeting or thank-you with no substantive question,
   **When** the system interprets the turn, **Then** it returns a brief natural
   acknowledgement in the user’s language and does not answer with a
   document-grounded miss message.
2. **Given** a user sends a social-only reaction after a prior assistant turn,
   **When** the system answers, **Then** it may invite the user to continue the
   current conversation but does not pretend to have verified a factual claim
   against workspace documents.
3. **Given** a conversation has no useful retrieved context for the latest
   turn, **When** the latest turn is social-only, **Then** the system still
   responds conversationally rather than treating the turn as a failed grounded
   question.
4. **Given** the workspace has answer-shaping instructions that affect tone,
   language, or response style, **When** a social-only turn is answered through
   the non-retrieval path, **Then** those instructions still shape the reply.

---

### User Story 2 - Preserve Retrieval For Mixed Turns (Priority: P1)

As a chat user, I want mixed turns such as “thanks, and what courses are coming
up?” to stay grounded on the real question, so politeness does not suppress the
actual request.

**Why this priority**: Over-classifying turns as social would silently weaken
retrieval quality and break real user questions.

**Independent Test**: Can be fully tested by sending mixed turns that include
both social language and a substantive question, then verifying that retrieval
still runs for the substantive request.

**Acceptance Scenarios**:

1. **Given** a user sends a turn containing both polite language and a clear
   substantive question, **When** the system interprets the turn, **Then** it
   treats the substantive question as primary and follows the normal grounded
   retrieval path.
2. **Given** a user accepts, continues, or selects a concrete option offered in
   the previous assistant turn, **When** the wording also includes a polite or
   lightweight reaction, **Then** the system preserves the existing grounded
   follow-up behavior instead of downgrading the turn to social-only.
3. **Given** a user sends a mixed turn in a new or existing conversation,
   **When** the system answers, **Then** the final answer addresses the
   substantive question and does not fall back to a social acknowledgement only.

---

### User Story 3 - Handle Assistant Identity Through The Same Intent Layer (Priority: P2)

As a chat user, I want questions about who the assistant is or what it can help
with to be answered intentionally without relying on forbidden keyword or regex
routing.

**Why this priority**: The current assistant-identity shortcut lives in
application code as hard-coded regex. This feature should replace that policy
with the same model-level interpretation layer used for social turns.

**Independent Test**: Can be fully tested by asking identity-only questions and
verifying that the system answers them without retrieval and without any
regex-based routing remaining in chat orchestration.

**Acceptance Scenarios**:

1. **Given** a user asks who the assistant is or what it can do, **When** the
   system interprets the turn, **Then** it answers through the model-level
   non-retrieval path instead of using hard-coded regex or keyword matching.
2. **Given** an assistant-identity-only turn has no substantive document
   request, **When** the system answers, **Then** it uses the configured
   assistant identity and does not fall back to document-grounded miss copy.
3. **Given** a user asks an identity question plus a substantive grounded
   question in the same turn, **When** the system interprets the turn, **Then**
   the substantive grounded question remains primary.

---

### User Story 4 - Preserve Debuggability Of Non-Retrieval Routing (Priority: P3)

As an engineer investigating odd chat behavior, I want stored diagnostics to
show whether a turn followed the non-retrieval social or identity path, so
misclassification can be debugged without guessing from final answer text.

**Why this priority**: This feature changes control flow. Without diagnostics,
future regressions will be hard to distinguish from retrieval or validation
bugs.

**Independent Test**: Can be fully tested by exercising social-only,
assistant-identity-only, and mixed turns and inspecting the stored turn or
audit metadata.

**Acceptance Scenarios**:

1. **Given** a social-only turn is handled through the non-retrieval path,
   **When** an engineer inspects stored diagnostics, **Then** they can tell
   that retrieval was intentionally skipped due to interpreted turn intent.
2. **Given** a mixed turn follows the normal retrieval path, **When** an
   engineer inspects stored diagnostics, **Then** they can tell the turn was
   not classified as non-retrieval social or identity-only.

### Edge Cases

- What happens when a greeting or thank-you includes a real substantive
  question in the same sentence?
- What happens when a user’s short reaction is actually accepting or selecting a
  concrete branch from the immediately previous assistant turn?
- What happens when the model returns malformed or low-confidence intent output?
- What happens when the user asks an assistant-identity question in a different
  language from the previous turn?
- What happens when a social-only reply would otherwise be rewritten or
  replaced by strict unsupported-answer handling?
- What happens when workspace-specific answer instructions or conversation-mode
  guidance should still influence a non-retrieval social or identity reply?

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in
  React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- User-facing assistant or chat responses MUST NOT rely on hard-coded
  application strings; runtime conversational copy MUST be generated by the LLM
  so multilingual behavior remains intact.
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
- Backend runtime LLM prompt templates introduced or revised for this feature
  MUST live under `backend/prompts/`.
- User-visible behavior changes and any affected operator-facing docs MUST be
  updated in the same delivery if the final implementation changes documented
  chat behavior.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Query interpretation owns model-level turn intent
  classification and the decision about whether retrieval is required. Chat
  orchestration coordinates the chosen path but does not own intent rules.
  Answer-support validation remains the post-generation trust boundary for
  retrieval-backed answers only. Persistence remains responsible for storing the
  resulting diagnostics. Answer-shaping instructions that normally inform final
  answer prompts remain accessible to both retrieval-backed and non-retrieval
  answer paths.
- **Encapsulation Rule**: Chat transport handlers remain transport-only.
  Chat-service orchestration must not absorb new keyword or regex routing for
  greetings, thanks, or identity questions. Retrieval rewrite `turnKind`
  remains retrieval-focused and must not be overloaded as the only source of
  non-retrieval control flow.
- **New Seams Required**: Introduce or extend a focused model-level turn-intent
  contract that can distinguish retrieval-required turns from non-retrieval
  social and assistant-identity turns, plus a bounded diagnostic seam that
  records which path was used. Introduce or extend a shared answer-instruction
  seam so non-retrieval social and identity prompts can still consume the same
  workspace answer-shaping instructions that normally appear during retrieval
  prompt assembly.
- **Anti-Goals**: Do not add deterministic keyword or regex intent recognition.
  Do not solve this by weakening strict answer-support policy globally. Do not
  route social-turn policy through HTTP handlers or frontend code. Do not
  collapse mixed turns into social-only acknowledgements when a substantive
  grounded request is present.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST determine a model-level response intent before
  retrieval for each chat turn.
- **FR-002**: The response-intent decision MUST be separate from retrieval
  rewrite `turnKind` and MUST decide whether the turn requires document
  retrieval.
- **FR-003**: The system MUST recognize a non-retrieval social-only class for
  greetings, politeness, thanks, or lightweight reactions that do not contain a
  substantive retrieval target.
- **FR-004**: When a turn is classified as social-only, the system MUST produce
  a brief acknowledgement in the user’s language and MAY invite the user to
  continue the conversation.
- **FR-005**: Social-only turns MUST NOT run the normal document-retrieval path
  and MUST NOT return the grounded-miss unsupported-answer fallback.
- **FR-006**: The system MUST preserve normal grounded retrieval behavior for
  mixed turns that include social language plus a substantive question,
  comparison, branch selection, or follow-up request.
- **FR-007**: Existing grounded follow-up behavior for concrete continuation or
  option-selection turns MUST continue to work even when the user also includes
  polite or reactive language.
- **FR-008**: The system MUST handle assistant-identity-only turns through the
  same model-level intent layer rather than hard-coded keyword or regex routing.
- **FR-009**: Assistant-identity-only turns MUST be answered without document
  retrieval and MAY use configured assistant identity as hidden support for the
  response.
- **FR-010**: When a turn includes both assistant-identity language and a
  substantive grounded request, the substantive grounded request MUST remain
  primary.
- **FR-011**: Malformed, missing, or otherwise unusable intent output MUST fail
  safely without introducing hard-coded keyword or regex fallback routing.
- **FR-012**: Strict answer-support validation MUST NOT replace social-only or
  assistant-identity-only replies with the unsupported-answer grounded-miss
  fallback.
- **FR-013**: User-facing acknowledgement, invitation, and assistant-identity
  reply text MUST remain model-generated rather than hard-coded application
  strings.
- **FR-014**: Non-retrieval social-only and assistant-identity-only replies
  MUST still have access to the active workspace answer-shaping instructions,
  including assistant identity, workspace-specific answer instructions,
  conversation-mode guidance, and current response-language behavior.
- **FR-015**: The system MUST NOT require retrieval prompt assembly to run in
  full just to preserve those answer-shaping instructions for a non-retrieval
  reply.
- **FR-016**: Persisted diagnostics or audit metadata MUST record whether a
  turn followed the non-retrieval social path, the non-retrieval
  assistant-identity path, or the normal retrieval path.
- **FR-017**: The feature MUST include automated backend coverage for
  social-only turns, assistant-identity-only turns, mixed turns, and unusable
  intent fallback behavior.
- **FR-018**: The feature MUST include automated backend coverage showing that
  non-retrieval social and identity replies still honor active answer-shaping
  instructions.
- **FR-019**: The implementation MUST remove the existing regex-based
  assistant-identity routing from chat orchestration.

### Key Entities *(include if feature involves data)*

- **Response Intent Decision**: The model-derived control-flow result that says
  whether the latest user turn should follow the normal retrieval path, the
  non-retrieval social path, or the non-retrieval assistant-identity path.
- **Social-Only Turn**: A user message that is conversational or polite but
  does not contain a substantive grounded request.
- **Mixed Turn Interpretation**: The decision that social wording is present
  but secondary to a substantive grounded request, so retrieval still runs.
- **Intent Routing Diagnostics**: The stored metadata that records which path
  was used for a turn and whether retrieval was intentionally skipped.

## Assumptions

- This feature does not add a new operator-facing setting; the behavior is a
  backend interpretation improvement.
- A social-only response may invite the user to continue, but it should remain
  brief and should not invent document-grounded specifics when retrieval did not
  run.
- Assistant-identity-only responses may rely on configured assistant identity
  without treating that identity as retrieved document evidence.
- The current retrieval-backed answer path already carries workspace answer
  instructions, so this feature should preserve those same instructions for
  non-retrieval paths instead of introducing a separate behavior island.
- When model-level intent output is unusable, the safest fallback is to preserve
  the normal retrieval-oriented path rather than introduce deterministic local
  classifiers.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In automated regression coverage for this feature, 100% of
  social-only turns return a conversational acknowledgement and never return the
  grounded-miss unsupported-answer fallback.
- **SC-002**: In automated regression coverage for this feature, 100% of mixed
  turns that contain a substantive grounded request continue through the normal
  retrieval path.
- **SC-003**: In automated regression coverage for this feature, 100% of
  assistant-identity-only turns are handled without regex-based routing and
  without document-retrieval fallback text.
- **SC-004**: In automated regression coverage for this feature, unusable
  intent output fails safely without introducing deterministic keyword or regex
  routing.
- **SC-005**: In automated regression coverage for this feature, non-retrieval
  social and identity replies still honor active answer-shaping instructions.
- **SC-006**: In stored-turn or audit inspection for covered scenarios,
  engineers can distinguish whether a turn followed the social-only,
  assistant-identity-only, or normal retrieval path.
