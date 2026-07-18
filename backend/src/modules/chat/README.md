# Chat Module

Chat owns assistant-facing conversation behavior. Start here when a feature
changes chat turns, streaming, citations, suggestions, conversation history,
assistant bootstrap, or public chat actions.

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
  chat stream adapters. Each terminal skill's `streamRender` owns final
  presentation of its single generation and returns a
  `TurnStreamResult` (`turnOutcome.ts`) carrying the final presentation plus how
  the host should source question suggestions. The conversation engine is the only
  turn path (`ChatService` requires it), so `processTurnStream` drives terminal
  selection, dispatch, streaming composition, final event append, and trace
  assembly. Chat still owns Radioso presentation, suggestions, persistence, billing,
  and HTTP stream events, and never pushes retrieval-specific policy into the
  reusable engine.
- Grounded retrieval answers: `groundedAnswerEnvelope.ts` frames the v1/v2
  terminal envelope, `groundingAssertions.ts` structurally computes
  `grounded | degraded | no_support`, and `retrievalTurnSkill.ts` performs one
  semantic answer generation. A valid in-range `[[n]]` assertion opens the
  stream gate; `[[?]]`, malformed, and anchor-free output stays held until the
  computed final presentation is available. Raw envelope JSON is never emitted
  or persisted.
- Citations: `citationAnchorParser.ts`, `citationAnchorSanitizer.ts`,
  `answerPresentationService.ts`, and `chatAnswerPresenter.ts`. Citations come
  only from explicit valid `[[n]]` assertions. `implicitCitationDiagnostics.ts`
  records aggregate rollout diagnostics and never attaches citation artifacts or
  changes verdicts and suggestions.
- Suggestions and public chat actions: `publicChatActionAdvertiser.ts`,
  `chat-action` tests.
- History: `assistantHistoryService.ts`, `chatHistoryService.ts`,
  `historyItemPresenter.ts`. History list reads take a `sourceScope`
  (`end_user` default | `operator_test` | `all`); the default excludes
  operator-driven test traffic (`shared/domain/conversationSource.ts` —
  `OPERATOR_TEST_SOURCE_CHANNELS` = dashboard test chat + workbench replay) so an
  operator's own testing never pollutes Activity, Quality, or Needs-Attention.
  The same NULL-safe exclusion lives in `historyItemsRepository`,
  `conversationRepository`, `quality/service.ts`, and `pendingDecisionRepository`.
- Bootstrap and public chat: `chatBootstrapService.ts`,
  public chat routes and presenters.
- Fork a conversation into a test session: `services/conversationForkService.ts`
  (`forkForTest` copies the user+assistant thread AND the active routine state into a
  new `authenticated_chat` conversation, same agent; skips system turns; original
  untouched). Routine state is keyed by `session_id` = conversation id, so it re-keys
  `loadActive(source)` → `save({...state, sessionId: fork})` — the fork resumes
  mid-routine (unlike eval *replay*, which must NOT seed it). Route:
  `POST /api/v1/conversations/:id/fork` in `conversationOwnershipRoutes.ts`
  (workspace-session auth). Powers the workbench's "Continue in test chat".
- Reusable turn engine: `conversationContractMappers.ts`,
  `conversationProcessTurnInput.ts`, `conversationEngineChatTurn.ts`, and
  application composition in `src/app/server/dependencyBuilders.ts`.
  `conversationProcessTurnInput.ts` passes route-scoped directive matching, turn
  interpretation, and retrieval work to the engine through neutral ports;
  `chatSessionPreparer.ts` does not pre-resolve directive matches for terminal
  answer turns. The adapter writes the resolved steering and prepared retrieval
  session back before dispatch/render so Radioso-owned composers and lifecycle
  traces keep reading the same steering shape.
  `turnOutcome.ts` holds only the capability-neutral turn machinery (`TurnSkill`,
  renderer registry); the engine adapter names no specific skill and only takes
  skill-shaped input. `conversationTurnInterpreter.ts` is adapted as the engine's
  turn interpretation port after routines decline; it performs the merged
  route-and-rewrite structured call for normal engine-prepared turns. `turnRouter.ts`
  remains available for non-engine callers and the retrieval-sense-compatible
  serial path. Retrieval preparation is adapted as retrieval work and runs only
  when interpretation selects the retrieval route.
  Each terminal answer capability is its own skill, selected by route —
  `retrievalTurnSkill.ts` and `directTurnSkill.ts` — each owning its composition.
  Skill **identity is sourced
  from the canonical catalog** (`modules/skills`): these files derive their skill
  name from `retrievalAnswerSkillDefinition` / `directAnswerSkillDefinition` — the
  chat loop never mints its own skill names. The `TurnSkill` here is the chat-side
  render binding, not a second skill registry. Shared answer plumbing:
  `chatAnswerSupport.ts` (neutral prompt/context builders),
  `preparedTurnOutcome.ts`, `chatAnswerErrors.ts`.

## Tests

Focused starting points:

- `cd backend && pnpm test -- tests/unit/chat-service-streaming.test.ts`
- `cd backend && pnpm test -- tests/unit/chat-history-service.test.ts`
- `cd backend && pnpm test -- tests/unit/chat-presenter.test.ts`
- `cd backend && pnpm run test:integration` for chat route behavior.

Pair backend changes with frontend chat tests when visible chat behavior changes.
