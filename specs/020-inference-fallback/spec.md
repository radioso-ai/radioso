# Feature Specification: Inference-Based Fallback Answers

**Feature Branch**: `020-inference-fallback`
**Created**: 2026-03-20
**Status**: Draft
**Input**: User description: "Add inference-based fallback answers when no document hits found, controlled by a toggle in retrieval settings"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Admin Enables Inference Fallback Toggle (Priority: P1)

A workspace administrator navigates to the retrieval settings tab and enables the "Inference Fallback" toggle. This allows the chatbot to answer from general LLM knowledge when no documents match a user's query, instead of returning a dead-end "I could not find relevant information" message.

**Why this priority**: This is the core enablement action. Without it, the feature has no effect. It must be a conscious opt-in since it changes the nature of the assistant's responses.

**Independent Test**: Can be fully tested by toggling the setting on/off and verifying it persists across page reloads.

**Acceptance Scenarios**:

1. **Given** the retrieval settings page is open, **When** the admin toggles "Inference Fallback" on and clicks Save, **Then** the setting is persisted and reflected on reload.
2. **Given** the toggle is on, **When** the admin toggles it off and saves, **Then** inference fallback is disabled and the system reverts to the static no-results message.
3. **Given** a fresh workspace with no settings configured, **When** the admin opens retrieval settings, **Then** the Inference Fallback toggle is off by default.

---

### User Story 2 - User Gets a Helpful Answer When No Documents Match (Priority: P1)

An end user asks a question that has no matching documents in the workspace corpus. With inference fallback enabled, the system calls the LLM with the user's query (without retrieved context) and returns a general-knowledge answer. The answer is clearly distinguished from document-grounded responses so the user knows it is not sourced from their documents.

**Why this priority**: This is the core user-facing behavior and the primary reason for the feature. Equal priority with the toggle since both are required for a functional MVP.

**Independent Test**: Can be tested by asking a question with no matching documents in a workspace that has inference fallback enabled, and verifying the response is an LLM-generated answer (not the static fallback message) with a visible "not from your documents" indicator.

**Acceptance Scenarios**:

1. **Given** inference fallback is enabled and the user asks a question with no matching document chunks, **When** the retrieval pipeline returns zero contexts, **Then** the system calls the LLM with a modified prompt and returns a general-knowledge answer.
2. **Given** the same conditions, **When** the inference answer is returned, **Then** the response is tagged with source type `"inference"` (distinct from `"retrieval"`) so the frontend can style it differently.
3. **Given** inference fallback is enabled, **When** an inference answer is generated, **Then** the answer does not contain any `[[n]]` citation markers.
4. **Given** inference fallback is **disabled** and no documents match, **When** the user asks a question, **Then** the system returns the existing static message: "I could not find relevant information in your documents."

---

### User Story 3 - User Sees Visual Distinction for Inference Answers (Priority: P2)

When an inference-based answer is displayed in the chat, the frontend renders a visual indicator (e.g., a banner, different styling, or label) that communicates the answer was generated from general knowledge, not from the workspace's documents.

**Why this priority**: Important for user trust and transparency, but the feature is functional without it (the API tagging from Story 2 provides programmatic distinction even before the UI treatment is built).

**Independent Test**: Can be tested by triggering an inference answer and verifying the chat UI displays a distinguishing indicator that is not present on document-grounded answers.

**Acceptance Scenarios**:

1. **Given** the chat displays an inference-based answer, **When** the user views it, **Then** a visible indicator communicates this answer is not based on their documents.
2. **Given** the chat displays a document-grounded answer, **When** the user views it, **Then** no inference indicator is shown.
3. **Given** the chat displays an inference answer, **When** the user views it, **Then** no citation UI (source documents, citation links) is shown for that message.

---

### Edge Cases

- What happens when the retrieval pipeline returns zero contexts but the LLM call for inference also fails? The system falls back to the existing static message and logs the error.
- What happens when the user asks a conversational/greeting message ("hello", "thanks")? The inference fallback handles these gracefully since they naturally produce no document hits.
- What happens when the similarity threshold is set very high and excludes borderline matches? The inference fallback activates based on zero contexts after the full pipeline, not on raw search results.
- What happens during streaming? Inference answers stream identically to retrieval answers, with the `source` tag included in the final `done` SSE event.

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

- **Boundary Rule**: `chatService.ts` owns answer orchestration; `retrievalPipelineService.ts` owns retrieval; `promptBuilder.ts` owns prompt construction; `retrievalSettings.ts` owns setting definitions; `settings-view.tsx` owns the settings UI.
- **Encapsulation Rule**: `chatService.ts` must remain orchestration-only — it should branch on zero-contexts and delegate to `promptBuilder` for the inference prompt variant, not embed prompt text inline. `retrievalPipelineService.ts` must not be aware of inference fallback; it reports zero contexts and is done.
- **New Seams Required**: None. The inference prompt variant should be a new method or mode in `PromptBuilder`, and the toggle is a new field on the existing `RetrievalSettings` domain. No new services or modules are needed.
- **Anti-Goals**: Do not add inference logic to the retrieval pipeline. Do not make the retrieval pipeline aware of the fallback behavior. Do not create a separate "inference service" — this is a prompt variant within the existing answer generation flow.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST add an `inferenceAnswerEnabled` boolean field to the retrieval settings domain, defaulting to `false`.
- **FR-002**: System MUST validate `inferenceAnswerEnabled` as a boolean in both the domain validation and API schema.
- **FR-003**: System MUST persist `inferenceAnswerEnabled` in the database alongside existing retrieval settings.
- **FR-004**: The retrieval settings UI MUST display an "Inference Fallback" toggle in the retrieval tab, following the existing `Switch` + label + description pattern used by Query Rewrite and Rerank toggles.
- **FR-005**: When `inferenceAnswerEnabled` is `true` and the retrieval pipeline returns zero contexts, the system MUST call the LLM with a prompt that omits the "Retrieved Context" section and includes an instruction to answer from general knowledge while clearly stating the answer is not based on the user's documents.
- **FR-006**: When `inferenceAnswerEnabled` is `false` and the retrieval pipeline returns zero contexts, the system MUST return the existing static message: "I could not find relevant information in your documents."
- **FR-007**: Inference answers MUST NOT contain `[[n]]` citation markers.
- **FR-008**: The API response for inference answers MUST include a `source` field with value `"inference"` to distinguish from document-grounded answers (`"retrieval"`).
- **FR-009**: Inference answers MUST support SSE streaming, consistent with existing retrieval-based answers.
- **FR-010**: If the LLM call for an inference answer fails, the system MUST fall back to the static no-results message and log the error.
- **FR-011**: Retrieval diagnostics MUST still be returned for inference answers, showing the pipeline ran and found zero contexts.

### UI Tasks

- Add an "Inference Fallback" toggle row in the retrieval settings tab, positioned after the existing Rerank toggle.
- Toggle row includes a label ("Inference Fallback") and description ("When no documents match, answer from general knowledge instead of showing a no-results message").
- In the chat view, display a visual indicator on inference-based messages (e.g., a subtle banner or label: "Answered from general knowledge — not based on your documents").
- Hide the citation/source-documents UI for inference-based messages.

### Key Entities

- **RetrievalSettings**: Extended with `inferenceAnswerEnabled: boolean` (default: `false`). Stored as `inference_answer_enabled` in the database.
- **ChatResponse**: Extended with `source: "retrieval" | "inference"` to indicate answer provenance.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users who ask questions with no document matches receive a helpful LLM-generated answer (when enabled) instead of a dead-end message, reducing conversation abandonment after no-results responses.
- **SC-002**: 100% of inference answers are visually distinguishable from document-grounded answers in the chat UI, ensuring users always know the provenance of an answer.
- **SC-003**: The toggle default is off, meaning zero existing workspaces are affected by this change unless an admin explicitly opts in.
- **SC-004**: Inference answers stream to the user with the same perceived latency as retrieval-based answers (no additional round-trips or delays beyond the LLM call itself).

## Assumptions

- The existing `PromptBuilder` can support a prompt variant that omits the "Retrieved Context" section without requiring a structural redesign.
- The warmth level and custom instruction settings still apply to inference answers, since they are workspace-level tone preferences.
- Conversation history is still included in the inference prompt, so the LLM has conversational context.
- The `source` tag is a new field on the API response; existing API consumers that do not read this field are unaffected.
