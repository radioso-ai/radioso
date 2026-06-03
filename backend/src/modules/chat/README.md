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
- `services/conversationContractMappers.ts` and
  `services/conversationProcessTurnInput.ts`: adapters from prepared chat turns
  into the reusable conversation-engine contracts.
- `services/groundedAnswerPromptComposer.ts`: grounded answer prompt assembly.

## Common Change Paths

- Streaming: `services/chatService.ts`, `contracts/streamEvents.ts`, frontend
  chat stream adapters. Each terminal skill's `streamRender` owns its full
  post-stream reconcile (grounded-miss safety net included) and returns a
  `TurnStreamResult` (`turnOutcome.ts`) carrying the final presentation plus how
  the host should source question suggestions. The conversation engine is the only
  turn path (`ChatService` requires it), so `processTurnStream` drives terminal
  selection, dispatch, streaming composition, final event append, and trace
  assembly. Chat still owns Radioso presentation, suggestions, persistence, billing,
  and HTTP stream events, and never pushes retrieval-specific policy into the
  reusable engine.
- Citations: `citation*`, `implicitCitationSupport.ts`,
  `chatAnswerPresenter.ts`.
- Suggestions and skill intake: `publicChatActionAdvertiser.ts`,
  `configuredSkillIntakeProvider.ts`, `chat-action` tests.
- History: `assistantHistoryService.ts`, `chatHistoryService.ts`,
  `historyItemPresenter.ts`.
- Bootstrap and public chat: `chatBootstrapService.ts`,
  public chat routes and presenters.
- Reusable turn engine: `conversationContractMappers.ts`,
  `conversationProcessTurnInput.ts`, `conversationEngineChatTurn.ts`, and
  application composition in `src/app/server/dependencyBuilders.ts`.
  `conversationProcessTurnInput.ts` passes the route-scoped directive catalog to
  the engine and adapts the real directive matcher into the engine's
  `directiveMatcher` port; `chatSessionPreparer.ts` does not pre-resolve
  directive matches for terminal answer turns. The adapter writes the resolved
  steering back onto the prepared session before dispatch/render so Radioso-owned
  composers and lifecycle traces keep reading the same steering shape.
  `turnOutcome.ts` holds only the capability-neutral turn machinery (`TurnSkill`,
  renderer registry); the engine adapter names no specific skill and only takes
  skill-shaped input. Each terminal answer capability is its own skill, selected by
  route — `retrievalTurnSkill.ts`, `socialTurnSkill.ts`,
  `assistantIdentityTurnSkill.ts` — each owning its composition (no "retrieval vs
  non-retrieval" branch). Skill **identity is sourced from the canonical catalog**
  (`modules/skills`): these files derive their skill name from
  `retrievalAnswerSkillDefinition` / `socialAnswerSkillDefinition` /
  `assistantIdentityAnswerSkillDefinition` — the chat loop never mints its own skill
  names. The `TurnSkill` here is the chat-side render binding, not a second skill
  registry. Shared answer plumbing: `chatAnswerSupport.ts` (neutral prompt/context
  builders), `preparedTurnOutcome.ts`, `chatAnswerErrors.ts`.

## Tests

Focused starting points:

- `cd backend && pnpm test -- tests/unit/chat-service-streaming.test.ts`
- `cd backend && pnpm test -- tests/unit/chat-history-service.test.ts`
- `cd backend && pnpm test -- tests/unit/chat-presenter.test.ts`
- `cd backend && pnpm run test:integration` for chat route behavior.

Pair backend changes with frontend chat tests when visible chat behavior changes.
