# Chat Module

Chat owns assistant-facing conversation behavior. Start here when a feature
changes chat turns, streaming, citations, suggestions, conversation history,
assistant bootstrap, or skill intake.

For the broader repository map, see
[`docs/architecture/code-map.md`](../../../../docs/architecture/code-map.md).

## Boundaries

Chat knows about chat sessions, assistant instructions, turn lifecycle,
streaming events, answer presentation, history presentation, citations, and
clickable suggestion behavior.

Chat should not own retrieval ranking, document persistence, provider registry
details, or hard-coded user-facing assistant responses. Runtime prompt templates
belong under `backend/prompts/`.

## Public Surfaces

- `contracts/`: chat response types, stream events, gateway contracts, and
  extension provider ports.
- `composition.ts`: chat module wiring used by application composition.
- `llmAdapters.ts`: LLM-provider registration for chat.
- `retrievalSupport.ts`: narrow helpers used by retrieval answer assembly.

Production code outside this module should prefer these entry points over direct
imports from `services/`.

## Read First

- `services/assistantChatService.ts`: assistant chat orchestration.
- `services/chatService.ts`: core chat service behavior.
- `services/chatSessionPreparer.ts`: session setup for chat turns.
- `services/chatTurnLifecycle.ts`: turn lifecycle and persistence flow.
- `services/groundedAnswerPromptComposer.ts`: grounded answer prompt assembly.

## Common Change Paths

- Streaming: `services/chatService.ts`, `contracts/streamEvents.ts`, frontend
  chat stream adapters.
- Citations: `citation*`, `implicitCitationSupport.ts`,
  `chatAnswerPresenter.ts`.
- Suggestions and skill intake: `chatIntakeProvider.ts`,
  `configuredSkillIntakeProvider.ts`, `chat-action` tests.
- History: `assistantHistoryService.ts`, `chatHistoryService.ts`,
  `historyItemPresenter.ts`.
- Bootstrap and public chat: `chatBootstrapService.ts`,
  public chat routes and presenters.

## Tests

Focused starting points:

- `cd backend && pnpm test -- tests/unit/chat-service-streaming.test.ts`
- `cd backend && pnpm test -- tests/unit/chat-history-service.test.ts`
- `cd backend && pnpm test -- tests/unit/chat-presenter.test.ts`
- `cd backend && pnpm run test:integration` for chat route behavior.

Pair backend changes with frontend chat tests when visible chat behavior changes.
