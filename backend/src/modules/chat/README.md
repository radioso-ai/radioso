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
- `services/conversationTurnRegistry.ts`: per-conversation interruption and
  emission-latch coordination.
- `services/conversationContractMappers.ts` and
  `services/conversationProcessTurnInput.ts`: adapters from prepared chat turns
  into the reusable conversation-engine contracts.
- `services/groundedAnswerPromptComposer.ts`: grounded answer prompt assembly.

## Common Change Paths

- Streaming: `services/chatService.ts`, `contracts/streamEvents.ts`, frontend
  chat stream adapters. The engine reports semantic progress through a neutral
  port; `conversationEngineChatTurn.ts` queues those reports with deltas and maps
  them to the public `interpreting | searching | composing` stages. A renderer's
  optional `stream` method owns live, validated delivery and returns a
  `TurnStreamResult` (`turnOutcome.ts`) carrying the final presentation plus how
  the host should source question suggestions. Renderers without a live stream
  are rendered once and replayed through the shared Unicode-safe chunk iterator.
  The conversation engine is the only
  turn path (`ChatService` requires it), so `processTurnStream` drives terminal
  selection, dispatch, streaming composition, final event append, and trace
  assembly. Chat still owns Radioso presentation, suggestions, persistence, billing,
  and HTTP stream events, and never pushes retrieval-specific policy into the
  reusable engine.
- Grounded retrieval answers: `groundedAnswerEnvelope.ts` frames the v1/v2
  terminal envelope, `groundingAssertions.ts` structurally computes
  `grounded | degraded | no_support`, and `retrievalTurnSkill.ts` performs one
  semantic answer generation on compliant paths. A valid in-range `[[n]]`
  assertion opens the stream gate; `[[?]]`, malformed, and anchor-free output
  stays held until the computed final presentation is available. The gate retains
  at most 4,096 Unicode code points. Reaching that cap aborts the candidate and
  returns the focused decline; elapsed time never closes the gate. When retrieved contexts exist, an
  answer or malformed result with no valid sourced assertion suppresses the draft
  and invokes the focused, locale-aware grounded-miss composer with typed
  `no_context`; its static asset is only the composer's last resort for provider or
  blank-output failure. Partial answers with at least one valid assertion remain
  visible and degraded. Raw envelope JSON is never emitted or persisted.
- Citations: `citationAnchorParser.ts`, `citationAnchorSanitizer.ts`,
  `answerPresentationService.ts`, and `chatAnswerPresenter.ts`. Citations come
  only from explicit valid `[[n]]` assertions. `implicitCitationDiagnostics.ts`
  records aggregate rollout diagnostics and never attaches citation artifacts or
  changes verdicts and suggestions.
- Turn interruption: `services/conversationTurnRegistry.ts` coordinates one
  in-flight turn per conversation. `ChatService` cancels a pre-emission turn,
  waits for its cleanup, and latches immediately before assistant persistence or
  the first assistant chunk. The default registry is process-local; strict
  multi-instance behavior requires conversation-affine routing.
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
- Conversation summary: `services/summary/conversationSummaryService.ts` maintains
  a bounded, regenerated-per-update rolling summary per conversation (#866). State
  lives in `conversation_summaries` (`db/repositories/conversationSummaryRepository.ts`,
  PK `session_id` = conversation id, watermark-guarded upsert, TTL) behind the narrow
  `contracts/conversationSummary.ts` `ConversationSummaryStore` port.
  `chatSessionPreparer.ts` loads it at prepare into `PreparedSession.conversationSummary`
  (the approval-resume path shares the same `loadConversationSummaryText` helper, so the
  "no summary" policy cannot drift); `chatTurnLifecycle.ts` regenerates it fire-and-forget
  after the turn is persisted (never awaited, self-heals on the next turn), debounced by
  `refreshEveryMessages` so it does not pay an LLM call every turn. The first summary for
  a legacy long conversation uses a capped recent backfill window (`maxInitialBackfillMessages`)
  so one post-deploy turn cannot trigger unbounded sequential model calls. Rows FK-cascade
  with their conversation (content, unlike the structural `routine_states`/`directive_states`),
  and `forkForTest` carries the summary into a forked test session. Injected via
  `services/summary/conversationSummarySection.ts` into three prompts — turn
  interpretation (`conversationTurnInterpreter.ts`), grounded answer
  (`groundedAnswerPromptComposer.ts`), and the direct answer
  (`assistantReplyPromptBuilder.ts`); an absent/empty summary renders nothing.
  Bounds and TTL are composition-owned in `CHAT_BEHAVIOR.conversationSummary`
  (`shared/domain/behaviorConfig.ts`); the prompt is `prompts/chat/conversation-summary.md`.
  Observability is content-free (`conversation_summary_regenerated | _skipped | _generation_failed`);
  the summary text never enters logs, telemetry, or analytics.
  Trace surfacing: `conversationSummaryTracePresenter.ts` `appendConversationSummaryStage`
  adds a `conversation_summary` stage (text + char count + injection sites) to the turn's
  operator activity trace — the debug surface, distinct from logs/analytics — on live turns
  and eval/replay alike (`chatTurnLifecycle.buildTurnTraceForPresentation`,
  `retrievalPipelineEvalRunner.answer`); the stage appears on every turn — `applied`
  with the text when a summary was available, `skipped` (`no_summary_yet`) when none
  exists — so absence is visible rather than ambiguous.
  Workbench replay and eval have summary parity: each answered turn persists the
  pre-answer summary it saw in its assistant message metadata (`conversationSummary`:
  text, or `null` when the summary-aware turn had none), and `evalSnapshotService`
  prefers that per-turn value over the current row for an answered-turn capture (the
  current row is regenerated after the answer, so it can distill it); the current row is
  frozen only for next-turn captures or, for a legacy pre-feature message, when its
  watermark provably predates the replayed turn. `chatSessionPreparer` accepts a
  `preResolvedConversationSummary` option so replay/eval thread that frozen text into
  `PreparedSession.conversationSummary` instead of loading the store. The applied summary
  is also echoed on `WorkbenchReplayResolvedConfig`/`EvalRunResolvedConfig.conversationSummary`
  for live-vs-replay comparison. Replay is hermetic — it never regenerates or persists the summary.
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
  `conversationProcessTurnInput.ts`, `conversationEngineChatTurn.ts`,
  `chatTurnAssembly.ts`, and
  application composition in `src/app/server/dependencyBuilders.ts`.
  Application composition creates one `ChatTurnAssemblyFactory` for production
  chat and workbench replay. Production supplies durable state ports; replay
  supplies the in-memory ports from `chatTurnEffectProfile.ts`. This keeps engine
  features aligned while replay avoids conversation, audit, action, and decision
  persistence.
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
- `cd backend && pnpm exec vitest run tests/unit/conversation-turn-registry.test.ts tests/integration/chat-interruption.integration.test.ts tests/contract/chat-interruption.contract.test.ts`
- `cd backend && pnpm run test:integration` for chat route behavior.

Pair backend changes with frontend chat tests when visible chat behavior changes.
