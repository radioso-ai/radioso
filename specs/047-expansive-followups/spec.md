# Feature Specification: History-Aware Expansive Suggestions

**Feature Branch**: `047-expansive-followups`  
**Created**: 2026-04-23  
**Status**: Draft  
**Input**: User description: "Make exploratory follow-up suggestions widen from conversation intent while staying grounded, with distinct deeper and broader suggestion behaviors."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Stay Aligned With The Conversation Goal (Priority: P1)

As a chat user, I want expansive suggested questions to stay aligned with the
ongoing conversation goal instead of only reacting to the last assistant
sentence, so the next steps feel useful even after several turns.

**Why this priority**: This is the core product problem. If suggestions only
echo the most recent answer, exploratory mode feels shallow and repetitive
instead of intentionally expansive.

**Independent Test**: Can be fully tested by running a multi-turn conversation
that narrows and then widens a topic, then confirming that expansive
suggestions remain tied to the active subject and user goal rather than merely
restating the final reply.

**Acceptance Scenarios**:

1. **Given** a conversation has established an active subject across prior
   turns, **When** the user asks a follow-up question in exploratory mode,
   **Then** the expansive suggestions widen from that active subject and goal
   rather than only from the final sentence of the latest answer.
2. **Given** the latest answer mentions several details, **When** expansive
   suggestions are shown, **Then** at least one broader suggestion can point to
   a grounded adjacent avenue that was relevant to the conversation goal even if
   it was not the final detail mentioned in the answer.

---

### User Story 2 - Choose Between Going Deeper And Going Broader (Priority: P1)

As a chat user, I want suggested questions to distinguish between deeper and
broader next steps so I can either keep drilling into the same subject or widen
out to nearby grounded areas.

**Why this priority**: Expansive behavior should feel intentional, not like one
undifferentiated pile of pills. Users need a clear difference between "more on
this" and "what else around this matters."

**Independent Test**: Can be fully tested by asking a supported question in
exploratory mode and confirming that the returned suggestions visibly separate
narrower continuations from adjacent broader continuations.

**Acceptance Scenarios**:

1. **Given** exploratory mode produces enough grounded follow-up material,
   **When** suggestions are rendered, **Then** the user can see distinct deeper
   and broader suggestion groups.
2. **Given** only deeper continuations are honestly supported, **When**
   suggestions are rendered, **Then** only the deeper group is shown and no
   broader filler is invented.
3. **Given** broader continuations are honestly supported, **When** suggestions
   are rendered, **Then** those suggestions clearly widen from the active
   subject without drifting into unrelated topics.

---

### User Story 3 - Keep Expansive Suggestions Grounded And Predictable (Priority: P1)

As a workspace operator, I want richer suggestion behavior to remain grounded
in workspace evidence and to respect directness requests, so exploratory mode
does not weaken trust or overwhelm users.

**Why this priority**: Richer suggestions are only useful if they preserve the
existing trust boundary. The feature must improve discovery without loosening
grounding rules or ignoring user intent for brevity.

**Independent Test**: Can be fully tested by exercising supported, weakly
supported, unsupported, and direct-answer-only turns and confirming that
expansive suggestions are omitted, reduced, or preserved appropriately.

**Acceptance Scenarios**:

1. **Given** a turn has insufficient grounded material for broader expansion,
   **When** exploratory mode completes, **Then** the system omits broader
   suggestions instead of guessing.
2. **Given** the user explicitly asks for brevity, directness, or "just the
   answer," **When** the turn completes, **Then** optional expansive suggestions
   are suppressed for that turn.
3. **Given** suggested questions are disabled for the workspace, **When** a
   turn completes in exploratory mode, **Then** neither deeper nor broader
   suggestions are shown.

---

### User Story 4 - Reuse Suggestions Reliably Across Chat Surfaces (Priority: P2)

As a chat user, I want richer suggestions to behave the same way in authenticated
and public chat flows so the exploratory experience is predictable wherever I
use the workspace assistant.

**Why this priority**: Suggestion behavior should not diverge by surface once
the workspace has chosen its conversation style.

**Independent Test**: Can be fully tested by generating exploratory turns in
both authenticated and public chat and confirming that the same richer
suggestion structure is returned and rendered consistently.

**Acceptance Scenarios**:

1. **Given** the same workspace and same supported query, **When** the turn is
   run through authenticated chat and public chat, **Then** both surfaces
   receive compatible richer suggestion groups for the turn.
2. **Given** a user clicks one of the richer suggestions, **When** the next turn
   is sent, **Then** existing suggestion-click provenance is preserved.

### Edge Cases

- What happens when the current turn is the first message and there is no prior
  conversation context to widen from?
- What happens when prior turns suggest one active subject but the latest user
  query intentionally pivots to a new subject?
- What happens when the retrieval context supports only one honest suggestion
  group?
- What happens when multiple candidate suggestions are near-duplicates of the
  current query, the current answer, or each other?
- What happens when a suggestion would only make sense with pronouns or other
  turn-local references?
- What happens when a user clicks a broader suggestion several turns later and
  the text must still be understandable as a standalone next query?

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; runtime conversational copy MUST be generated by the LLM so multilingual behavior remains intact.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.
- Operator-facing documentation and settings docs changed by this feature MUST be updated in the same delivery.
- Backend runtime prompt assets revised for this feature MUST live under `backend/prompts/`.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Chat routes and presenters continue to own request validation and response shaping, chat orchestration continues to coordinate turn execution, retrieval and rewrite services continue to own history-aware subject continuity, focused suggestion-planning modules own expansive suggestion context assembly and candidate selection, and frontend chat surfaces continue to render backend-provided suggestion structure without inventing local suggestion text.
- **Encapsulation Rule**: `backend/src/modules/chat/services/chatService.ts` MUST remain orchestration-focused and MUST NOT absorb prompt assembly, history summarization, lane classification, or duplicate filtering logic directly. `frontend/components/dashboard/chat-message-thread.tsx` and `frontend/components/chat/public-chat-shell.tsx` MUST remain rendering and interaction containers rather than becoming the source of suggestion planning rules.
- **New Seams Required**: Introduce or extend focused backend seams for history-aware expansive suggestion input assembly, suggestion-type planning or classification, and prompt-template ownership under `backend/prompts/chat/`. Introduce or extend focused frontend rendering helpers so deeper and broader groups are displayed consistently across chat surfaces.
- **Anti-Goals**: Do not add non-grounded generic brainstorming suggestions. Do not hide suggestion behavior inside one large prompt with no explicit post-processing rules. Do not make frontend components infer broader intent solely from the displayed answer text.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Exploratory suggestion generation MUST consider the current grounded turn together with recent conversation context when deciding how to widen follow-up suggestions.
- **FR-002**: When recent turns establish an active subject or task, broader suggestions MUST widen from that active conversation intent instead of only paraphrasing or extending the last assistant sentence.
- **FR-003**: The system MUST support at least two exploratory suggestion behaviors: deeper continuations that stay on the current subject and broader continuations that widen to adjacent grounded areas.
- **FR-004**: Deeper suggestions MUST remain tightly connected to the current subject, while broader suggestions MUST still remain recognizably connected to the active conversation intent.
- **FR-005**: Any richer suggestion shown to the user MUST be grounded in the workspace material already available to the turn and MUST preserve existing citation or provenance linkage.
- **FR-006**: When broader continuations cannot be supported honestly from the grounded turn context, the system MUST omit them rather than inventing generic discovery prompts.
- **FR-007**: The system MUST filter or reject suggestions that substantially duplicate the current query, the delivered answer, or other suggestions from the same assistant turn.
- **FR-008**: Suggestion text MUST remain understandable as a standalone next question, use the same language as the user turn, and avoid turn-local pronouns when an explicit referent is needed for clarity.
- **FR-009**: Existing workspace controls for enabling or disabling suggested questions and for setting suggested question counts MUST continue to govern the richer exploratory suggestions.
- **FR-010**: Guided mode MUST remain more conservative than exploratory mode and MUST NOT begin surfacing broad adjacent discovery behavior that belongs to the expansive experience.
- **FR-011**: When a user explicitly requests brevity, directness, or "just the answer" in the current turn, the system MUST suppress optional richer suggestions for that turn even if exploratory mode is active.
- **FR-012**: Authenticated chat and public chat flows that already support suggested questions MUST expose compatible richer suggestion structure and suggestion-click provenance behavior.
- **FR-013**: The system MUST preserve compatibility for stored conversation history so reopened assistant turns can still show richer suggestions without breaking existing message rendering.
- **FR-014**: The feature MUST include automated backend coverage for history-aware expansion, omission when unsupported, and duplicate filtering, plus frontend coverage for rendering the richer suggestion groups.
- **FR-015**: Operator-facing documentation for conversation mode and suggested questions MUST explain how expansive suggestions use conversation context, how deeper and broader suggestions differ, and when broader suggestions are intentionally omitted.

### UI Tasks

- Render richer exploratory suggestions in visibly distinct deeper and broader groups when both are available.
- Ensure only the supported suggestion groups are shown for a turn, with no empty headings or placeholder groups.
- Preserve existing suggestion-click behavior and message provenance when a user selects a richer suggestion.
- Keep the richer suggestion presentation consistent between dashboard chat and public chat surfaces.

### Key Entities

- **Conversation Intent Snapshot**: The recent-turn context that identifies the active subject, current task, or ongoing user goal for the current assistant turn.
- **Deeper Suggestion**: A grounded standalone follow-up question that drills further into the same active subject.
- **Broader Suggestion**: A grounded standalone follow-up question that widens into an adjacent avenue while staying connected to the active conversation intent.
- **Suggestion Group**: A categorized set of suggestions associated with one assistant turn and rendered as a distinct deeper or broader lane.
- **Suggestion Provenance**: The existing linkage that connects a clicked suggestion back to the assistant message that produced it.

## Assumptions

- No new persistent database schema is required; the feature can rely on existing conversation history, retrieval context, and assistant-turn metadata.
- Guided mode should remain compact and focused, while exploratory mode becomes the only mode that can surface broader adjacent discovery suggestions.
- Existing suggestion-click provenance behavior remains the source of truth for associating a new turn with the assistant message that offered the suggestion.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In covered multi-turn exploratory scenarios, broader suggestions remain aligned with the established conversation subject or task instead of merely echoing the latest answer text.
- **SC-002**: In covered exploratory scenarios with enough grounded material, users can see distinct deeper and broader suggestion groups for 100% of expected turns.
- **SC-003**: In covered weak-support and no-support scenarios, broader suggestions are omitted rather than replaced with generic filler for 100% of expected turns.
- **SC-004**: Authenticated and public chat regression coverage confirms compatible richer suggestion behavior across both supported chat surfaces.
