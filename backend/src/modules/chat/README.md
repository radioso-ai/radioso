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

Revision-pinned private Test Chat is hosted by `modules/test-execution`. Chat
provides the safe runtime ports and historical conversation behavior it needs;
it must not resolve a mutable draft or silently fall back to current authoring
rows. Start at `test-execution/README.md` and
`services/trustedTestExecutionRunnerAdapter.ts` when changing that flow.

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
- Grounded retrieval answers: `groundedAnswerEnvelope.ts` defines the v2 JSON
  schema and retains the older sentinel parser for compatibility. First-party
  OpenAI and Gemini use native JSON-schema output; Claude uses an equivalent forced
  schema tool. OpenAI-compatible endpoints keep the schema-oriented prompt but do
  not receive an API-level strict-format parameter because arbitrary compatible
  backends do not share that capability. The incremental envelope reader emits
  only the decoded `answer` field, so claims and follow-up suggestions never enter
  visible streaming text. The envelope stays capability-neutral: a caller may merge
  a strict schema extension into the response format and the reader buffers any
  fields it does not interpret as opaque `extras` (like suggestions, never in
  visible text). Directive adherence rides that seam — the shared
  `shared/domain/directiveAdherence.ts` probe owns the attestation schema fragment
  and resolves the raw `extras` back to directive display names, so the envelope
  never learns directive vocabulary and any composer can carry it. Resolved
  attestation appears only on the operator-facing compose trace output.
  `groundingAssertions.ts` structurally computes
  `grounded | degraded | no_support`, and `retrievalTurnSkill.ts` performs one
  semantic answer generation on compliant paths.
- Decline classification: a declined turn also carries *why* it declined
  (`TurnDeclineReason` in `assistantTurnOutcomeTypes.ts`). `content_gap` keeps the
  turn on `retrieval.answer:no_context`; `out_of_scope` moves it to
  `retrieval.answer:out_of_scope`, an outcome the catalog leaves without a
  `groundedAnswer` flag so it scores on neither side of the grounded rate.
  `generation_unavailable` records missing model configuration, provider failure,
  or an unusable generated decline as `retrieval.answer:unavailable` with failed
  status, also outside the grounding-gap population. The
  content-vs-scope classification is only ever a model-returned enum, never a
  keyword test: the grounded envelope adds an `out_of_scope` outcome value, and
  `fallbackReplyComposer.composeNoContext` returns `{text, declineReason}` from a
  strict JSON schema. Bare model prose without a classification stays the
  conservative `content_gap`; paths where no usable model judgement exists use
  `generation_unavailable`. Direct-answer fallbacks preserve the direct skill
  identity instead of borrowing a retrieval outcome. Every `no_support`
  presentation must supply a typed decline reason, either directly on the verdict
  or through its grounding summary; `ChatAnswerPresenter` rejects the call when
  neither is present. `chatService`'s
  retrieval-miss handoff and the Slack gap escalation both key off the outcome and
  therefore escalate only content gaps, leaving out-of-scope and unavailable
  declines alone. A valid in-range `[[n]]`
  assertion opens the stream gate; `[[?]]`, malformed, and anchor-free output
  stays held until the computed final presentation is available. The gate retains
  at most 4,096 Unicode code points. Reaching that cap aborts the candidate and
  returns the focused decline; elapsed time never closes the gate. When retrieved
  contexts exist, a valid `outcome=answer` result without a valid sourced assertion
  is discarded and rewritten through the focused decline path. Lexical overlap
  never satisfies this delivery guard. A page-read turn whose typed gate captured
  page content is exempt because that content is an admitted source outside the
  citation index. Malformed results remain visible with a computed `degraded`
  verdict, while partial answers with at least one valid assertion remain visible
  and degraded.
  Raw envelope JSON is never emitted or persisted.
- Coverage verdict head (#1260): the grounded envelope's `coverage`,
  `requestFocus`, and `outcome` fields precede `answer` in schema order, so the
  model commits to its coverage verdict before writing any answer text.
  `groundedAnswerHeadReader.ts` resolves that head from partial JSON chunks —
  `pending` while streaming, `parsed` once all three fields are complete and
  valid, `invalid` the moment `answer` opens without them or the response is
  not a JSON object at all (the free-text sentinel-parser path).
  `retrievalTurnSkill.ts` calls the engine's coverage verdict sink exactly
  once, with either the parsed head or the zero-evidence branch's
  deterministic `unanswered / insufficient_evidence` verdict, and waits for
  `proceed` or `yield_turn` before releasing any text; on `yield_turn` the
  stream aborts through the same mechanism the grounding gate's `bound`
  decision uses, with nothing released. `answerCoverageFromHead.ts` maps a
  parsed head, an invalid head, or the deterministic branch to the assessment
  shape `llmAnswerCoverageProducer.ts` also produces, tagged with a `producer`
  (`answer_head`, `deterministic`, or `assessor`). `answerCoverageHeadRecorder.ts`
  persists that assessment and its reaction trace with the same
  `findByRequestMessageId` idempotency; draft test chat and eval replay get
  the unwrapped sink, so the head still gates directive and routine behavior
  but nothing is written. `answerCoverageShadowAssessor.ts` runs
  `llmAnswerCoverageProducer.ts` concurrently with compose, off the critical
  path, for a measurement window
  (`ANSWER_COVERAGE_SHADOW_ASSESSOR_ENABLED`, default on); it never
  influences the turn and only records agreement between the head and shadow
  classifications. The engine side of the port — directive applicability from
  the head, coverage routine candidate evaluation and ranked activation,
  reaction recording — lives in
  `packages/conversation-engine/src/coverageVerdictSink.ts`, invoked from
  inside the skill's stream rather than before it. The citation gate
  (`requiresIndexedSourceGate`) reads the resolved `citationHoldEnabled`
  setting: off, an `answer` commitment releases as soon as the head parses
  instead of waiting for a citation, while a `no_support` or `out_of_scope`
  commitment always bypasses the gate regardless of the setting. Tests:
  `tests/unit/grounded-answer-head-reader.test.ts`,
  `tests/unit/retrieval-answer-coverage-verdict.test.ts`,
  `tests/unit/chat/answerCoverageHeadRecorder.test.ts`,
  `tests/unit/chat/answerCoverageShadowAssessor.test.ts`. See
  `specs/1260-coverage-verdict-in-answer-head/`.
- Citations: `citationAnchorParser.ts`, `citationAnchorSanitizer.ts`,
  `answerPresentationService.ts`, and `chatAnswerPresenter.ts`. Citations come
  only from explicit valid `[[n]]` assertions. `implicitCitationDiagnostics.ts`
  records aggregate rollout diagnostics and never attaches citation artifacts or
  changes verdicts and suggestions.
  `citationTextNormalization.ts` owns the punctuation classes for the anchor
  seam. Both are Unicode properties, never script or keyword lists:
  `Terminal_Punctuation` for the spacing rule that runs over arbitrary answer
  text, plus `Pe`/`Pf` for the narrower line-leading strand check.
  Segment boundaries are markdown-safe. Each `AnswerSegment` is rendered through
  its own markdown pass downstream, so `normalizeAnchoredAnswer` runs every
  anchor offset through `shared/text/markdownSplitBoundary.ts` and cuts at the
  nearest offset that divides no construct (fenced code, code spans, emphasis,
  links, images, autolinks, and whole GFM table blocks). The citation marker
  therefore attaches *after* a closing delimiter, and anchors sharing one
  indivisible construct merge into a single boundary. That resolver is pure
  markdown knowledge and never learns what a citation anchor is — the caller
  declares anchor spans through its `ignoredRanges` port. Relocations increment
  the content-free `chat_citation_anchor_split_relocations_total` counter,
  labelled by construct.
  Tests: `tests/unit/answer-presentation.test.ts`,
  `tests/unit/markdown-split-boundary.test.ts`,
  `tests/unit/citation-text-normalization.test.ts`.
- Turn interruption: `services/conversationTurnRegistry.ts` coordinates one
  in-flight turn per conversation. `ChatService` cancels a pre-emission turn,
  waits for its cleanup, and latches immediately before assistant persistence or
  the first assistant chunk. The default registry is process-local; strict
  multi-instance behavior requires conversation-affine routing. A superseded turn
  is still accountable: `chatTurnLifecycle.recordSupersession` records a
  `chat.answer` audit event with `eventStatus: "cancelled"` (never `"failure"` —
  a user typing a follow-up is not an assistant error) keyed to the turn's
  `userMessageId`, since no assistant message exists yet for it.
- Suggestions and public chat actions: `publicChatActionAdvertiser.ts`,
  `chat-action` tests.
- History: `assistantHistoryService.ts`, `chatHistoryService.ts`,
  `historyItemPresenter.ts`. History list reads take a `sourceScope`
  (`end_user` default | `operator_test` | `all`); the default excludes
  operator-driven test traffic (`shared/domain/conversationSource.ts` —
  `OPERATOR_TEST_SOURCE_CHANNELS` = dashboard test chat + workbench replay + Ray
  agent-turn probe) so an operator's own testing never pollutes Activity,
  Quality, or Needs-Attention. The `operator_test` history scope uses the narrower
  `WORKBENCH_TEST_SOURCE_CHANNELS`, keeping synthetic Ray probes out of reopenable
  workbench history while retaining them for internal traceability.
  The same NULL-safe exclusion lives in `historyItemsRepository`,
  `conversationRepository`, `quality/service.ts`, and `pendingDecisionRepository`.
  `chatHistoryService.getConversation` is shared by the dashboard and the
  public/embed visitor surface; every operator-only fact (`includeOwnership`,
  `includeAgentInternalName`, `includeTurnFailureDebug`) is an explicit,
  default-off option, and `AssistantHistoryService` is the only place that turns
  them on (`dashboardConversationDetailOptions`) — the public routes call
  `chatHistoryService.getConversation` directly and never set them.
  `includeTurnFailureDebug` attaches a `turnFailure` fact (failed or superseded,
  never both classified as the same) to the user message of a turn that never
  produced an assistant reply — the read-side counterpart to
  `recordSupersession`/`recordFailure`, both of which record `userMessageId`.
  `answerCoverageHistoryProvider.ts` is the authorized read projection for
  persisted coverage assessments and reaction traces. It batches request and
  assessment reads per conversation, preserves absent evaluations as
  `not_evaluated`, and exposes persisted target-message and routine-execution
  identifiers without deriving either from response text.
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
  with their conversation (content, unlike the structural `routine_states`/`directive_states`).
  Injected via
  `services/summary/conversationSummarySection.ts` into four prompts — turn
  interpretation (`conversationTurnInterpreter.ts`), grounded answer
  (`groundedAnswerPromptComposer.ts`), and the direct answer
  (`assistantReplyPromptBuilder.ts`), plus fused turn planning
  (`turnPlanService.ts`); an absent/empty summary renders nothing.
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
- Draft a reply without becoming a turn: `services/replyDraftRunner.ts` composes what
  the agent would say next in a live conversation by running the workbench replay over
  that conversation's own transcript, with the last customer message as the query. It is
  the ephemeral effect profile end to end, so the run writes no message, conversation,
  routine state, or summary; the operator surface that asks for it (Ray's `draft_reply`)
  owns the budget, the boundary, and the projection. The agent config it replays is
  resolved by its caller through `ReplyDraftAgentConfigPort`, because chat replays an
  agent rather than assembling one.
- Visitor resolution (spec 1277): `chatSessionPreparer.ts`'s
  `resolveVisitorForNewConversation` resolves a `visitors` row (via
  `modules/visitors/public.ts`'s `VisitorResolverPort`) before creating a new
  conversation — skipped for `operator_test` turns and channels with neither
  an anonymous nor a verified key — and passes `visitorId`, `requestContext`,
  `entryReferrer` into `ConversationRepositoryPort.create`.
  `attachVerifiedIdentity` runs at the existing first-verified-turn site next
  to `setVerifiedCustomerId`. Identity-resolution rules live in
  `modules/visitors/`, not here.
- Bootstrap and public chat: `chatBootstrapService.ts`,
  public chat routes and presenters. Revision greeting selection and exact-mode
  resolution live in `services/agentRevisionGreeting.ts`, shared by bootstrap and
  `services/agentStarterPromptReader.ts` — the read-only port (exported from
  `composition.ts`) channels use to show an agent's greeting chips outside a
  conversation, such as Slack's agent pane. It starts, records, and reserves nothing.
- Seed a private test execution from a conversation:
  `services/conversationTestExecutionSeedSource.ts` implements the test-execution
  module's `TestExecutionSeedSource` port. It reads the user+assistant thread (system
  turns skipped) plus the conversation's CURRENT active routine state, pending
  clarification, and directive firing memory, and exports them as the same v1 replay
  continuation a test turn returns (`testExecutionContinuation.ts`), without a session
  id so the trusted runner rebinds it to the side's own conversation. The seeded test
  therefore resumes mid-routine (unlike eval *replay*, which must NOT seed runtime
  state). It answers `null` for a conversation outside the workspace or agent, and it
  is read-only on the source. Wired in `app/server/builders/chat.ts`; reached through
  `POST /api/v1/agents/:agentId/test-executions` with `seedConversationId`, which
  powers the dashboard's "Continue in test chat". The rolling conversation summary
  is not part of the seed; instead the seed is capped to the same recent-message
  window a live turn reads (`RETRIEVAL_BEHAVIOR.rewriteConversationContextMaxMessages`
  via `listRecentByConversationId`), opening on a user turn when the window cut
  older messages, because the trusted runner replays the whole seeded history on
  every test turn.
- Safe-test turns use the shared `TurnExecutionMode` to keep routine,
  pending-decision, clarification, and directive state needed for a follow-up
  while the lifecycle suppresses external actions, ownership handoffs, customer
  analytics, and summary regeneration. Chat does not own the caller's identity,
  provenance, or authorization policy; application composition supplies those.
- Fused turn planning: `turnPlanService.ts` (one `turn_planning` call on the
  agent's chat model + prompt `backend/prompts/chat/turn-planning.md`, strict
  parse and semantic validation) and `turnPlanCoordinator.ts` (gate, eligibility bounds from
  `behaviorConfig.turnPlanning`, the lazy memoized `session.turnPlan` handle,
  and the four plan-aware adapters). On eligible fresh turns the one plan
  replaces the staged routine-activation, turn-interpretation,
  response-language, and directive-match calls; a bypassed or invalid plan
  sends every consumer back to its staged call, all-or-nothing. This is standard
  behavior with no rollout configuration. The chat builder (`builders/chat.ts`)
  wires the same coordinator into `ChatService` and
  `workbenchReplayRunner.ts`; their shared
  `chatTurnAssembly.ts` consumes the plan so replay executes the identical
  schedule, including the staged response-language detector on bypass or planner
  failure. Policy stays with the owning modules: the routine
  activator applies plan rankings through `RoutineRegistry.prepareCandidates` /
  `applyRankedDecision` (including extracted activation variables), completed-
  routine correction/reentry adapters pin the plan as bypassed when they claim
  the turn, retrieval rewrite guidance/rolling summary resolve through the same
  interpretation-context seam as the staged path, and the directive matcher resolves precomputed
  classifications through `matchAndResolveWithClassifications`.
  Pre-retrieval planning never receives response identity or answer instructions,
  and any model-proposed scope fields are ignored. Retrieved evidence decides
  whether the grounded answer has support.
  `chat_turn_planning_outcomes_total` records fast-path, fallback, and every typed
  gate/state/candidate/prompt bypass without forcing lazy prompt construction. Tests:
  `tests/unit/turn-plan-service.test.ts`,
  `tests/unit/turn-plan-coordinator.test.ts`,
  `tests/unit/chat-service-turn-planning.test.ts`.
- Reusable turn engine: `conversationContractMappers.ts`,
  `conversationProcessTurnInput.ts`, `conversationEngineChatTurn.ts`,
  `chatTurnAssembly.ts`, and
  application composition in `src/app/server/builders/chat.ts`.
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
  `agentChatWorkspaceContext.ts` (the one LLM resolve input for every model call
  on the agent's turn — planner, answer, coverage assessment — so the agent's
  `chatModelOverride` reaches all of them), `preparedTurnOutcome.ts`,
  `chatAnswerErrors.ts`.

## Tests

Focused starting points:

- `cd backend && pnpm test -- tests/unit/chat-service-streaming.test.ts`
- `cd backend && pnpm test -- tests/unit/chat-history-service.test.ts`
- `cd backend && pnpm exec vitest run tests/unit/chat-turn-lifecycle.test.ts tests/unit/assistant-history-service.test.ts`
- `cd backend && pnpm test -- tests/unit/chat-presenter.test.ts`
- `cd backend && pnpm exec vitest run tests/unit/conversation-turn-registry.test.ts tests/integration/chat-interruption.integration.test.ts tests/contract/chat-interruption.contract.test.ts`
- `cd backend && pnpm exec vitest run tests/unit/chat-session-preparer-visitor-resolution.test.ts`
- `cd backend && pnpm run test:integration` for chat route behavior.

Pair backend changes with frontend chat tests when visible chat behavior changes.
