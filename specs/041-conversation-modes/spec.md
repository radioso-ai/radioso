# Feature Specification: Conversation Modes

**Feature Branch**: `041-conversation-modes`  
**Created**: 2026-04-16  
**Status**: Draft  
**Input**: User description: "Add workspace conversation modes for grounded chat behavior. Replace terse one-size-fits-all responses with configurable factual, guided, and exploratory modes that shape all answers, not just unsupported-answer recovery. Guided should suggest 1-2 focused adjacent topics. Exploratory should surface more of what is available and invite grounded follow-up, using focused and expansive exploration while keeping answerPolicy as a separate strict trust boundary."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Make The Assistant Feel Meaningfully Different By Mode (Priority: P1)

As a chat user, I want the assistant to answer directly in factual mode, offer a
small number of focused next directions in guided mode, and offer broader
grounded exploration in exploratory mode, so I can choose between efficiency and
discovery.

**Why this priority**: This is the main product value. If users cannot clearly
feel the difference between modes during normal supported conversations, the
feature reduces to a settings label rather than a better chat experience.

**Independent Test**: Can be fully tested by asking supported questions against
the same workspace in each mode and verifying that factual answers stay tight,
guided answers include a small focused extension, and exploratory answers
surface a wider grounded map of adjacent content.

**Acceptance Scenarios**:

1. **Given** a question is supported by retrieved workspace material, **When**
   the workspace is in factual mode, **Then** the assistant answers the
   question directly and does not proactively add extra topics unless needed for
   honesty or clarification.
2. **Given** a question is supported by retrieved workspace material, **When**
   the workspace is in guided mode, **Then** the assistant answers the question
   and may suggest one or two focused adjacent topics grounded in the same
   workspace material.
3. **Given** a question is supported by retrieved workspace material, **When**
   the workspace is in exploratory mode, **Then** the assistant answers the
   question and then surfaces two or three grounded avenues for further
   exploration drawn from the available workspace material, with any optional
   grounded follow-up prompt clearly separated from the direct answer.
4. **Given** the assistant suggests next directions in guided or exploratory
   mode, **When** the user reads them, **Then** it is clear those are optional
   grounded continuations rather than part of the direct answer itself.

---

### User Story 2 - Configure How Broadly The Assistant Responds (Priority: P1)

As a workspace operator, I want to choose whether the assistant is factual,
guided, or exploratory so the conversation style matches how my users prefer to
work with the knowledge base.

**Why this priority**: The user experience needs an operator control or every
workspace remains locked into one interaction style. This story ensures the
product improvement is tunable and operationally usable.

**Independent Test**: Can be fully tested by saving each mode in settings,
reloading the workspace, and confirming the selected mode is reflected in later
chat behavior.

**Acceptance Scenarios**:

1. **Given** a workspace operator opens chat settings, **When** they choose
   factual, guided, or exploratory and save, **Then** the workspace stores that
   mode and later chat turns use it.
2. **Given** a workspace has never saved a conversation mode, **When** settings
   are read, **Then** the workspace receives guided mode as the default instead
   of a blank or undefined value.
3. **Given** the active workspace mode is changed, **When** a new answer is
   generated, **Then** the assistant behavior reflects the newly saved mode
   without changing the workspace trust policy.

---

### User Story 3 - Preserve Trust Boundaries Across All Modes (Priority: P1)

As a workspace operator, I want conversation mode to stay separate from the
unsupported-answer policy so richer conversational behavior never weakens
grounding enforcement.

**Why this priority**: This is the key safety boundary. If conversation mode and
trust policy blur together, the product becomes harder to reason about and
riskier to operate.

**Independent Test**: Can be fully tested by exercising supported, partially
unsupported, fully unsupported, and no-context turns under each conversation
mode while keeping the same support policy, then confirming trust outcomes stay
consistent.

**Acceptance Scenarios**:

1. **Given** a workspace uses strict answer support behavior, **When** any
   conversation mode is active, **Then** unsupported substantive content is
   still handled by the strict policy rather than being allowed through because
   the mode is more expansive.
2. **Given** a response is partially or fully unsupported, **When** guided or
   exploratory mode is active, **Then** any recovery, pivot, or follow-up stays
   grounded in retrieved workspace material and does not become a generic model
   answer.
3. **Given** no relevant workspace material is retrieved, **When** exploratory
   mode is active, **Then** the assistant remains explicit that supporting
   material was not found and does not pretend to know more than the workspace
   contains.

---

### User Story 4 - Inspect Which Mode Produced A Turn (Priority: P2)

As an operator debugging chat quality, I want history and debug views to show
which conversation mode shaped a turn so I can understand why an answer was
direct, focused, or expansive.

**Why this priority**: Once modes change answer style, operators need basic
observability or they will not be able to tune behavior confidently.

**Independent Test**: Can be fully tested by generating turns under different
conversation modes and confirming stored debug or history output identifies the
active mode and whether optional expansion content was applied.

**Acceptance Scenarios**:

1. **Given** an assistant turn is stored after this feature ships, **When** an
   operator inspects history or debug data, **Then** they can see which
   conversation mode applied to that turn.
2. **Given** guided or exploratory mode adds optional expansion content, **When**
   an operator inspects stored diagnostics, **Then** they can tell that the turn
   included mode-driven expansion rather than only a direct answer.

### Edge Cases

- What happens when guided mode finds no honest focused adjacent topics worth
  suggesting?
- What happens when exploratory mode retrieves many plausible adjacent areas and
  the assistant must avoid dumping an overwhelming list?
- What happens when the answer is supported but only narrowly, and expansive
  suggestions would risk stretching beyond retrieved evidence?
- What happens when a user asks for a terse answer while the workspace is in
  exploratory mode?
- What happens when the retrieval result supports focused follow-up but not
  truly expansive adjacent discovery?
- What happens when the workspace default mode changes in the middle of an
  existing conversation?

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
- Any operator-facing settings, debug metadata, or user-visible answer behavior changed by this feature MUST update the corresponding documentation in the same delivery.
- Any backend runtime prompt assets introduced or extracted for conversation modes MUST live under `backend/prompts/`.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Settings transport continues to own request validation and response shaping, retrieval continues to own query processing and context assembly, chat orchestration continues to coordinate turn execution, focused domain modules own conversation-mode instructions and expansion planning, and persistence continues to own workspace settings plus stored audit metadata.
- **Encapsulation Rule**: `backend/src/modules/chat/services/chatService.ts` MUST remain orchestration-focused and MUST NOT absorb large amounts of mode-specific wording or suggestion logic. `backend/src/modules/retrieval/services/promptBuilder.ts` MUST NOT become the only home for all conversation-mode behavior; prompt shaping and post-answer expansion must be separable concerns. Frontend chat surfaces MUST remain renderers of backend-provided behavior rather than inventing mode-specific exploration text locally.
- **New Seams Required**: Introduce or extend focused backend seams for conversation-mode instruction building, grounded expansion planning, and final answer composition that can distinguish direct answer content from optional focused or expansive continuations.
- **Anti-Goals**: Do not merge conversation mode into `answerPolicy`. Do not add generic non-grounded fallback behavior. Do not push exploration logic into route handlers or frontend components. Do not implement expansive behavior as an uncontrolled single-prompt blob with no bounded output rules or observability.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a workspace-scoped conversation mode setting with exactly three supported values: `factual`, `guided`, and `exploratory`.
- **FR-002**: The system MUST use `guided` as the default conversation mode for workspaces that have not explicitly saved one.
- **FR-003**: Factual mode MUST answer the user’s question directly without proactively adding optional adjacent topics except when clarification or honesty requires it.
- **FR-004**: Guided mode MUST answer the user’s question and MAY suggest one or two focused adjacent directions that are grounded in retrieved workspace material for that turn.
- **FR-005**: Exploratory mode MUST answer the user’s question and, when retrieved workspace material supports doing so honestly, MUST surface two or three grounded avenues for further exploration and MAY add one grounded follow-up prompt.
- **FR-006**: Any focused or expansive continuation generated by guided or exploratory mode MUST be derived only from workspace material retrieved or otherwise already available to the grounded turn context.
- **FR-007**: Conversation mode MUST affect supported-answer behavior, partially unsupported behavior, fully unsupported behavior, and no-context behavior rather than only unsupported misses.
- **FR-008**: The active `answerPolicy` MUST remain a separate control and MUST continue to govern how unsupported substantive content is handled after answer generation.
- **FR-009**: Conversation mode MUST NOT weaken or bypass strict unsupported-answer handling, no-context honesty, citation behavior, or existing support-validation semantics.
- **FR-010**: When guided or exploratory mode cannot support an honest focused or expansive continuation from the grounded material, the system MUST omit that continuation rather than invent one.
- **FR-011**: The final delivered answer MUST make a clear distinction between the direct answer and any optional focused or expansive exploration content when such content is present.
- **FR-012**: The system MUST preserve the current user-language behavior for both direct answers and any mode-driven continuations.
- **FR-013**: The system MUST store or surface enough turn metadata for operators to identify which conversation mode applied to a turn and whether mode-driven expansion content was used.
- **FR-014**: Settings, contract, and debug/history surfaces affected by this feature MUST expose the conversation mode consistently for authenticated and public/anonymous chat paths where the workspace setting applies.
- **FR-015**: The feature MUST include automated backend coverage for each conversation mode across supported, unsupported, and no-context outcomes.
- **FR-016**: Operator-facing documentation for chat settings and answer behavior MUST describe the difference between factual, guided, and exploratory modes and must clarify that answer-support policy remains a separate trust control.
- **FR-017**: When a user explicitly asks for brevity, directness, or “just the answer” in the current turn, the assistant MUST honor that request for the turn even if the workspace default mode is guided or exploratory.
- **FR-018**: Exploratory-mode expansion content MUST be recognizable as discovery-oriented behavior rather than only a slightly longer prose answer.

### UI Tasks

- Add a conversation mode control to the existing admin chat or retrieval settings surface so operators can choose factual, guided, or exploratory behavior.
- Present short operator-facing descriptions that explain the difference between direct-only, focused, and expansive grounded behavior.
- Keep the unsupported-answer policy visible as a separate safety or trust setting rather than merging it into the conversation-mode control.
- Show conversation-mode information in existing operator debug or history surfaces wherever answer-shaping metadata is already exposed.

### Key Entities *(include if feature involves data)*

- **Conversation Mode**: The workspace-scoped behavioral setting that determines whether the assistant responds with direct-only, focused, or expansive grounded behavior.
- **Focused Continuation**: An optional short grounded extension that points the user toward one or two adjacent directions closely related to the current answer.
- **Expansive Continuation**: An optional grounded extension that surfaces a broader map of nearby covered material or suggests a grounded follow-up direction beyond the exact asked question.
- **Mode-Applied Turn Metadata**: Stored or presented debug information that records which conversation mode shaped a turn and whether optional expansion content was included.

## Assumptions

- The workspace-level setting should apply consistently to authenticated chat and public or anonymous chat flows that already inherit workspace retrieval settings.
- The product default should be `guided` because it balances direct answering with modest grounded discovery for the largest set of workspaces.
- The feature may reuse the current retrieved context set for focused and expansive continuations rather than triggering a second retrieval path by default.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Operators can save and later retrieve the configured conversation mode for a workspace with no ambiguity about the active value.
- **SC-002**: Acceptance tests demonstrate visibly distinct behavior between factual, guided, and exploratory modes for the same supported question.
- **SC-003**: Validation scenarios demonstrate that strict unsupported-answer handling behaves consistently across all three conversation modes without unsupported factual content being surfaced.
- **SC-004**: Operators reviewing stored debug or history output can identify the applied conversation mode for 100% of turns generated after the feature ships.
