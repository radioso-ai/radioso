# Feature Specification: Chat Streaming Hotfix

**Feature Branch**: `005-chat-streaming-hotfix`  
**Created**: 2026-03-14  
**Status**: Approved  
**Input**: User description: "why is the chat response streaming not working?" and follow-up: "go ahead, in a new worktree, then post a hotfix PR"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Receive Real Incremental Chat Chunks (Priority: P1)

An authenticated account user submits a chat question and sees assistant text arrive progressively from the backend while the model is generating the answer.

**Why this priority**: The current SSE endpoint only replays a completed answer, so the visible streaming experience is effectively broken.

**Independent Test**: Issue a streamed chat request against a delayed streaming gateway and verify the response emits the conversation event before completion and emits at least one chunk before the final done event.

**Acceptance Scenarios**:

1. **Given** a streamed chat request uses a gateway capable of incremental output, **When** the backend produces the response, **Then** chunk events are forwarded before the full answer is complete.
2. **Given** a streamed chat request completes successfully, **When** the final done event is emitted, **Then** the persisted assistant message content matches the concatenated streamed chunks and includes the final citations.
3. **Given** a streamed chat request has no retrieval contexts, **When** the backend answers with the safe fallback, **Then** the client still receives a valid conversation event, answer text, and done event without hanging.

### Edge Cases

- If the upstream model stream yields empty deltas, the backend should ignore them instead of emitting blank chunk events.
- If the upstream model stream fails after partial output, the backend should surface the failure and avoid persisting a truncated assistant message as a successful completion.
- If a client disconnects mid-stream, the server should stop writing further SSE events for that response.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Backend MUST follow TDD with tests written and failing before implementation.
- Stack remains Node.js backend, React frontend, PostgreSQL with `pgvector`, and GPT-5.2-family defaults unchanged.
- Modular boundaries between transport, orchestration, and gateway integration MUST remain explicit.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: HTTP presenters own SSE formatting only; chat orchestration owns conversation persistence and completion lifecycle; the OpenAI gateway owns provider-specific streaming translation.
- **Encapsulation Rule**: Do not add provider-specific event parsing to route handlers or presenters.
- **Anti-Goals**: Do not fake streaming by slicing a completed answer. Do not change the existing non-streaming JSON response contract.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The backend MUST provide a true streaming code path that can forward model output incrementally before the full answer is complete.
- **FR-002**: The backend MUST preserve the existing JSON response path for non-streaming chat requests.
- **FR-003**: The streaming code path MUST emit a conversation event before chunk events and a done event after persistence succeeds.
- **FR-004**: The backend MUST persist the assistant message content assembled from streamed chunks only after the stream completes successfully.
- **FR-005**: The backend MUST continue returning the safe fallback answer when retrieval yields no supporting contexts.
- **FR-006**: Contract coverage MUST verify the streamed route emits chunk data before the stream completes, not merely that the payload has SSE formatting.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Contract tests prove that streamed responses emit at least one chunk before the final done event when the gateway yields delayed chunks.
- **SC-002**: Unit tests prove successful stream completion persists the full assistant answer and final citations.
- **SC-003**: Existing non-streaming chat contract tests continue to pass unchanged.
