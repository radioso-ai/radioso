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

- `domain.ts` knows sessions, utterances, speech pieces and turn outcomes. It
  names no vendor and no wire.
- `services/` runs the turn: `voiceTurnService.ts` resolves or binds the
  session's conversation, starts the chat turn with `sourceChannel: "voice"`
  and a `voice` channel context, and maps the chat stream to
  `VoiceTurnEvent`s; `speechSegmenter.ts` is the pure sentence cutter
  (punctuation only, no words).
- `persistence/` maps `(agent_id, vendor, session_key)` to a conversation in
  `voice_sessions`. The first binding wins.
- `adapters/*` translate one wire to the domain port and back, and nothing
  else. `adapters/openaiCompletions/` is the OpenAI chat-completions wire;
  vendors that share it differ only by a dialect in `dialects.ts`, which is
  data: where the session key travels, and the default transport. Vendor field names live there and in `requestSchema.ts`, never
  in the domain.

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
  Postgres and `AssistantChatService.streamAnswer`; exposed as
  `AppDependencies.voiceTurns`.
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
- **Ray coverage.** The route is a deferred exclusion in
  `tests/unit/operatorCopilot/catalogCoverage.ts`
  (`internalRuntimeCoverageExclusions.voiceCompletionsAdapter`) until voice
  settings exist for an operator to configure.
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
- **Barge-in.** The chat turn registry supersedes a running turn that has not
  started speaking; once it has, the next utterance waits for it to finish and
  the full reply is stored.
- **Disconnects** follow the REST agent channel: the turn keeps running after
  the vendor hangs up, and is aborted only past the post-disconnect ceiling.

## Observability

One log per turn with `agentId`, `vendor`, `transport`, `conversationId`,
`result`, `durationMs` and `speechPieceCount`: `Voice turn finished` at info
(`completed`, `superseded`, `abandoned`), or `Voice turn failed` at warn with
`errorClass`. A warn when a concurrent first turn bound the session to another
conversation, and a warn naming only `dialect` and `agentId` when a request
carries no usable session key (a 400). A stream that fails after its first
frame ends with one generic OpenAI error frame. Never the utterance, the reply
or an internal error message. Chat-side spans, metrics and failure logs cover the
turn itself.

## Tests

- `cd backend && pnpm exec vitest run tests/unit/voice-channel-*.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/voice-session-repository.integration.test.ts`
  (needs the disposable integration database; see the code map)
