# Voice Channel Module

Voice owns spoken sessions with an agent. A voice runtime (ElevenLabs Agents,
or a runtime we control) handles audio, speech recognition and synthesis; this
module turns each finished caller utterance into one chat turn on the
session's conversation and hands the reply back as sentence-sized speech.

For the broader repository map, see
[`docs/architecture/code-map.md`](../../../../docs/architecture/code-map.md).
The design is `specs/voice-channel/channel-contract.md`; operator-facing docs
are [`docs/voice-channel.md`](../../../../docs/voice-channel.md).

## Boundaries

- `domain.ts` knows sessions, utterances, bridge lines, speech pieces and turn
  outcomes. It names no vendor and no wire.
- `services/` runs the turn: `voiceTurnService.ts` resolves or binds the
  session's conversation, reads the agent's voice settings and the
  conversation's routine state, starts the chat turn with
  `sourceChannel: "voice"` and a `voice` channel context, and maps the chat
  stream to `VoiceTurnEvent`s; `speechSegmenter.ts` is the pure sentence cutter
  (punctuation only, no words); `speechText.ts` removes the composer's
  citation markers (`[1]`, `[?]`, `[[1]]`, `[[?]]`) from everything spoken, by
  structure only; `voiceTurnPolicy.ts` is the pure timing wrapper
  (bridge and turn limit) over those events; `voiceLines.ts` picks the turn's
  bridge and fallback lines by routine state and locale (tag structure only,
  never the lines' words); `voiceTurnMetrics.ts` names the policy's series.
- `persistence/` maps `(agent_id, vendor, session_key)` to a conversation in
  `voice_sessions`. The first binding wins.
- `adapters/*` translate one wire to the domain port and back, and nothing
  else. `adapters/openaiCompletions/` is the OpenAI chat-completions wire;
  vendors that share it differ only by a dialect in `dialects.ts`, which is
  data: where the session key and the caller's locale travel, the default
  transport, and the flush delta a runtime needs after each sentence. Vendor
  field names live there and in `requestSchema.ts`, never in the domain.

Dependency direction is adapter → `VoiceTurnPort` → chat. The service reaches
chat through the narrow `VoiceChatPort` (`streamTurn`) and imports chat only
through `modules/chat/contracts`. The domain never imports an adapter or
composition.

The completions route takes its credential check, turn budget and success
record from the HTTP layer as a `CompletionsAdmission`, so the adapter does
not know which credential admits a caller. It does import two generic HTTP
helpers and the shared chat message limit from `app/http`
(`consumeSseWithDisconnectCeiling`, `markHttpResponseFailed`,
`CHAT_MESSAGE_MAX_LENGTH`), the same way `connectors/http` does.

## Entry points

- `public.ts` — `VoiceTurnPort`, `VoiceTurnService`, `VoiceSessionRepository`,
  `registerOpenAiCompletionsRoute`.
- `backend/src/app/composition/voiceChannel.ts` — builds the port over
  Postgres, `AssistantChatService.streamAnswer`, the agent repository (voice
  settings and default locale) and the routine state store; exposed as
  `AppDependencies.voiceTurns`.
- The agent's `voice` settings block belongs to the agents module
  (`agents/voiceSettings.ts`, stored in `behavior_settings.voice`, served on
  `GET`/`PUT /api/v1/agents/:agentId`). This module reads it: the services
  import `AgentVoiceSettings` and `VoiceBridgeStyle` as types from
  `agents/public.ts`, and composition hands the turn service the agent's block
  and default locale.
- `backend/src/app/http/routes/agentVoiceRoute.ts` — mounts
  `POST /api/v1/agents/:agentId/voice/:dialect/v1/chat/completions` beside the
  REST agent channel, behind `requireRestAgentChannelCredential` (an
  `agent-api` grant whose agent matches the path) and the REST agent-channel
  rate limiters.

## Decisions to keep

- **Not in OpenAPI.** The completions route speaks a vendor-owned wire format,
  OpenAI chat completions as voice runtimes call it, not Radioso's API
  contract, so it has no operation in `openApiPaths.ts` and no SDK method; it is
  documented in `docs/voice-channel.md`. (The REST agent channel,
  `createAgentChannelChatResponse`, is Radioso's own contract and is
  registered.) The `voice` member of `ConversationChannelContext` is in
  OpenAPI, because history responses return it.
- **Ray coverage.** The route and the settings block are deferred exclusions
  in `tests/unit/operatorCopilot/catalogCoverage.ts`
  (`internalRuntimeCoverageExclusions.voiceCompletionsAdapter`,
  `voiceSettingsBlock`). `voice` is left out of `agentInputFieldSchemas`, so
  `propose_agent_setting` refuses it by name; `fieldParity.ts` records the gap
  for it and for `prepare_agent_settings`.
- **Turn policy.** Runs only while the agent's `voice.enabled` is true; with
  voice off a turn runs exactly as a plain chat turn. The bridge fires when the
  turn starts searching, 400 ms after it starts composing without speech, or
  after 1.8 s with no phase at all; the limit is 8 s into the turn
  (`VOICE_BEHAVIOR` in `shared/domain/behaviorConfig.ts`). The turn service
  turns chat `status` events into phase markers (`interpreting`, `searching`,
  `composing`) that only the policy reads; adapters never see them, and with
  voice off they are dropped. `interpreting` is where every turn starts, so
  it leaves the 1.8 s fallback armed. Everything stops at the first speech or
  the outcome, and at most one bridge is spoken. The bridge
  style is `acknowledge` while a routine is active in the conversation at turn
  start and `check` otherwise; a session's first turn has no routine. Lines
  rotate per policy turn within the process. The locale is the request's
  (`VoiceTurnInput.locale`, read by the dialect), else the agent's
  `assistantDefaultLocale`, else `en`; chat stores no response language per
  message, so the last reply's language is not a source. An agent with no line
  for the locale and style hears silence, and an agent with no fallback line
  keeps waiting past the limit.
- **Bridge lines are not stored.** A bridge is a channel-level utterance, like
  a typing indicator: it reaches the caller, never the conversation history.
- **After the limit.** The policy speaks the fallback line, ends the turn with
  `continue`, and drains the reply unheard so the chat turn still finishes and
  is stored. The stored answer is then not what the caller heard, and nothing in
  history marks that. The route ends the HTTP response at the outcome in both
  modes, so the runtime never waits for the drain.
- **Flush delta.** ElevenLabs hands a sentence to speech once the terminator
  is followed by whitespace and a later non-blank delta arrives (observed
  2026-10-13). Pieces end on the terminator, so the `elevenlabs` dialect's
  `sentenceFlushDelta` is a space plus U+200B in one chunk, after every bridge
  line and speech piece on the wire; `renderCompletion` and history never see
  it.
- **Keep-alive.** ElevenLabs drops a custom-LLM stream that is silent for about
  4 s and re-asks with the same utterance (observed 2026-10-13). The streaming
  route writes the `elevenlabs` dialect's `keepAlive.delta` (space plus U+200B)
  after every 2.5 s without a frame, the role frame first if nothing was
  written yet, and stops at the outcome, on disconnect and on error. It is
  wire-level and lives in the adapter; the turn policy knows nothing of it.
- **Metering.** The chat service reserves usage with `surface` = the source
  channel and prices it from the same value: `voice` reserves
  `surface: "voice"`, `usage: "conversation_reply"`, the treatment the REST
  agent channel gets as `agent_api`.
- **Request context.** The route passes no edge request facts. The HTTP peer is
  the vendor's runtime, not the caller, so its address and geo would describe
  the vendor.
- **Stops at `done`.** The service closes the chat stream at `done`; what
  follows is suggestion enrichment, which a caller never hears.
- **First-turn race.** A session's first turns are single-flight per
  `(workspaceId, agentId, vendor, sessionKey)` within one process: a second
  first turn waits until the first binds the session, then joins its
  conversation. Across instances the race remains: both turns start a
  conversation, `bind` keeps the session on the first, and the losing turn's
  exchange stays in an orphaned conversation (logged as a warn).
- **Operator takeover reaches no one.** `customerReplyDelivery.ts` has no
  `voice` deliverer, so an operator's Inbox reply never reaches the caller; the
  Inbox offers no Send on a voice conversation
  (`frontend/lib/email-send-readiness.ts`). Until an operator writes, each caller
  turn hears the chat service's waiting line; after that, silence.
- **Barge-in.** ElevenLabs does not abort the HTTP stream when the caller
  interrupts: the previous reply streams to completion and the next utterance
  arrives as a new request. The chat turn registry makes that turn wait for the
  running reply (it supersedes only a turn that has not started speaking), and
  the full reply is stored. The replayed history carries the interrupted reply
  truncated to what was heard, but the adapter reads only the newest user
  message.
- **ElevenLabs session key.** ElevenLabs sends no conversation id; the page
  that starts the session mints `session_key` and passes it as the custom LLM
  extra body, which arrives as `elevenlabs_extra_body.session_key`. Dynamic
  variables inside the extra body are not interpolated.
- **Disconnects** follow the REST agent channel: the turn keeps running after
  the vendor hangs up, and is aborted only past the post-disconnect ceiling.

## Observability

One log per turn with `agentId`, `vendor`, `transport`, `conversationId`,
`result`, `durationMs` and `speechPieceCount`, plus `bridged`,
`turnLimitReached` and `fallbackSpoken` when the voice policy ran: `Voice turn
reached the turn limit` at warn when the limit fired, else `Voice turn finished` at info
(`completed`, `superseded`, `abandoned`), or `Voice turn failed` at warn with
`errorClass`. A warn when a concurrent first turn bound the session to another
conversation, and a warn naming only `dialect` and `agentId` when a request
carries no usable session key (a 400). A stream that fails after its first
frame ends with one generic OpenAI error frame. Never the utterance, the reply
or an internal error message. Chat-side spans, metrics and failure logs cover the
turn itself.

The policy records `voice_turn_first_speech_ms` (histogram, `bridged`),
`voice_bridge_emitted_total` (`style`, `locale_resolved`: `no` when the agent
had no line, so nothing was spoken) and `voice_turn_limit_total`
(`locale_resolved`: `no` when there was no fallback line and the turn kept
waiting). Labels are closed enums; no line text, locale tag or id.

## Tests

- `cd backend && pnpm exec vitest run tests/unit/voice-channel-*.test.ts` (the
  policy tests use fake timers)
- `cd backend && pnpm exec vitest run tests/contract/agent-voice-settings.contract.test.ts`
  (the settings round trip and the dashboard-save safety check)
- `cd backend && pnpm exec vitest run tests/integration/voice-session-repository.integration.test.ts`
  (needs the disposable integration database; see the code map)
