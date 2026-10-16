# Voice Channel Module

Voice owns spoken sessions with an agent. A voice runtime (ElevenLabs Agents,
or a runtime we control) handles audio, speech recognition and synthesis; this
module turns each finished caller utterance into one chat turn on the
session's conversation and hands the reply back as sentence-sized speech. It
also starts a session for a page: it opens one on the vendor agent the Radioso
agent is bound to, with the workspace's own vendor key, and mints the session
key the runtime sends back on every turn.

For the broader repository map, see
[`docs/architecture/code-map.md`](../../../../docs/architecture/code-map.md).
The design is `specs/voice-channel/channel-contract.md`; operator-facing docs
are [`docs/voice-channel.md`](../../../../docs/voice-channel.md).

## Boundaries

- `domain.ts` knows sessions, utterances, bridge lines, speech pieces and turn
  outcomes. It names no vendor and no wire.
- `services/` runs the turn: `voiceTurnService.ts` resolves or binds the
  session's conversation, reads the agent's voice settings and the
  conversation's routine state and owner, starts the chat turn with
  `sourceChannel: "voice"` and a `voice` channel context, and maps the chat
  stream to `VoiceTurnEvent`s; `voiceTurnOutcome.ts` is the pure outcome
  derivation from chat's closing `done` envelope; `speechSegmenter.ts` is the
  pure sentence cutter (punctuation only, no words); `speechText.ts` turns
  text into what a caller hears: it removes the composer's citation markers
  (`[1]`, `[?]`, `[[1]]`, `[[?]]`) and markdown syntax (emphasis, inline code, line-start heading and
  list markers, link syntax) from everything spoken, by structure only, and
  compares a runtime's record of what was heard with what was spoken;
  while a reply streams, `speechSegmenter.ts`'s sentence cutter closes an
  emphasis only before a space, line break or punctuation (the end of the
  reply closes the rest) and removes list markers only at a real line start;
  `voiceTurnPolicy.ts` is the pure timing wrapper (bridge and turn limit) over
  those events; `voiceLines.ts` picks the turn's bridge and fallback lines by
  routine state and locale (tag structure only, never the lines' words);
  `voiceSessionMemory.ts` is the in-process memory of each session between its
  requests (the newest request, the last bridge, the last exchange);
  `voiceTurnMetrics.ts` names the turn's series;
  `voiceSessionStartService.ts` starts a session: it reads the agent's
  `voice.enabled` and `voice.runtime`, the workspace's key for that vendor
  through `VoiceVendorCredentialReader`, asks that vendor's
  `VoiceSessionStarter` for the session, and mints the session key (a UUID).
  The same service is the `VoiceSessionAvailabilityPort`: by the gate a start
  passes (`voice.enabled`, a bound `voice.runtime`) and the presence of that
  vendor's key (`isStored`, which decrypts nothing), it says whether a page
  should offer calls at all.
- `persistence/` maps `(agent_id, vendor, session_key)` to a conversation in
  `voice_sessions`. The first binding wins.
- `adapters/*` translate one wire to the domain port and back, and nothing
  else. `adapters/openaiCompletions/` is the OpenAI chat-completions wire;
  vendors that share it differ only by a dialect in `dialects.ts`, which is
  data: where the session key and the caller's locale travel, the default
  transport, the flush and keep-alive deltas a runtime needs, and the suffix
  it appends to a reply the caller cut short. Vendor field names live there
  and in `requestSchema.ts`, never in the domain. `adapters/elevenlabs/` is
  the ElevenLabs `VoiceSessionStarter`: the signed-URL request with the key in
  `xi-api-key`, its response, its 15-minute validity and its 5-second timeout,
  over an injected `fetch`.

Dependency direction is adapter → `VoiceTurnPort` → chat. The service reaches
chat through the narrow `VoiceChatPort` (`streamTurn`) and imports chat only
through `modules/chat/contracts`. It asks every chat turn for the
`latest_input_wins` supersession mode; the chat turn registry owns what that
means. The domain never imports an adapter or composition.

The completions route takes its credential check, turn budget and success
record from the HTTP layer as a `CompletionsAdmission`, so the adapter does
not know which credential admits a caller. It does import two generic HTTP
helpers and the shared chat message limit from `app/http`
(`consumeSseWithDisconnectCeiling`, `markHttpResponseFailed`,
`CHAT_MESSAGE_MAX_LENGTH`), the same way `connectors/http` does.

## Entry points

- `public.ts` — `VoiceTurnPort`, `VoiceTurnService`, `VoiceSessionRepository`,
  `registerOpenAiCompletionsRoute`; `VoiceSessionStartPort`,
  `VoiceSessionStartResult`, `VoiceSessionStartService`,
  `createElevenLabsSessionStarter`.
- `backend/src/app/composition/voiceChannel.ts` — builds the port over a
  session store, `AssistantChatService.streamAnswer`, the agent repository (voice
  settings and default locale), the routine state store, the conversation
  ownership reader (`handoff/public.ts`), the message repository as chat's
  `ReplyInterruptionMarker` and the audit service (the
  `voice.reply_interrupted` and `voice.reply_replayed` notes, built by
  `createVoiceTurnNotes`); exposed as `AppDependencies.voiceTurns`.
  `createVoiceSessionStartComposition` in the same file builds the session
  start over the agent repository, the ElevenLabs starter with `fetch`, the
  workspace credential store's `getApiKey` as the credential reader, and the
  start registry; exposed as `AppDependencies.voiceSessionStarts`.
  `app/server/dependencies.ts` builds one `VoiceSessionRepository` and hands it
  to both: the turn reads bindings and starts from it, and the start records
  into it.
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
- `backend/src/app/http/routes/publicVoiceSessionRoute.ts` — mounts
  `POST /api/v1/public/chat/:token/voice/sessions` on the public chat router,
  behind the router's public session check (launch token, website embed
  origin, signed visitor session), a website-embed-only check, and
  `publicVoiceSessionStartRateLimiter`
  (`app/http/middleware/publicVoiceSessionRateLimiter.ts`), and maps
  `VoiceSessionStartResult` to HTTP. A page on another origin reaches it
  through the frontend proxy `frontend/app/api/public/chat/[token]/voice/sessions/route.ts`,
  which answers the CORS preflight. The website embed is its first-party
  consumer: `GET /api/v1/public/chat/:token/embed-config` carries
  `voice: { available }`, true when the operator turned on the embed's
  `voiceCallsOffered` switch (the agents module's website embed block) and
  `AppDependencies.voiceSessionAvailability` says voice is ready, and
  the embed's Talk button (`frontend/lib/use-voice-session.ts`, which runs the
  call in `frontend/lib/voice-call.ts`) starts sessions through the relay with
  the embed's public session and opens them in the browser with the vendor's
  client.

## Decisions to keep

- **Session start.** The voice domain owns the ports: `VoiceSessionStarter`
  (`startSession({ vendorAgentId, region, credential })` → `{ signedUrl, expiresAt? }`,
  one adapter per vendor), `VoiceVendorCredentialReader`
  (`read({ workspaceId, vendor })` → `present`, `missing` or `unreadable`;
  it rejects only when the store cannot be read), and the start registry
  (`VoiceSessionStartRegistry` and `VoiceSessionStartLookup`, implemented by
  `VoiceSessionRepository`). The key lives in the workspace credential store
  (`workspace_provider_credentials`, the same encryption, audit events and
  redaction as the model provider keys, written through
  `PUT /api/v1/settings/credentials/elevenlabs`); composition adapts the
  store's `getApiKey`, and there is no deployment fallback. A start needs a
  website embed public session, `voice.enabled` and a bound `voice.runtime`;
  otherwise it is a 404. Every other failure (no key, an unreadable key, a
  store or registry that cannot be reached, a vendor that refuses or does not
  answer) is one `503 voice_unavailable` with no detail, and the outcome label
  and the warn log say which. The vendor list is `VOICE_VENDORS` in
  `shared/domain/voiceVendor.ts`, which the runtime binding, the credential
  store and the starters share. Starts spend their own budgets before the
  vendor call: per visitor session (signed public session id plus request
  source), per request source alone (so re-minting public sessions does not
  refill it), and per workspace, `PUBLIC_VOICE_SESSION_START_*` in `env.ts`.
- **The signed URL is a bearer credential.** An ElevenLabs signed URL is valid
  for 15 minutes and opens sessions for whoever holds it until then, so it
  goes only to the page that asked, with `Cache-Control: no-store`, and never
  into a log, metric or row. The ElevenLabs starter follows no redirect, reads
  at most 16 KB, and returns only a `wss://` URL on the host of the account's
  data residency region. One table in the adapter maps `voice.runtime.region`
  (`us`, `eu`, `in`, `sg`) to the host the request goes to and the signed URL
  must be on, so a start for an EU account calls
  `api.eu.residency.elevenlabs.io` and refuses a URL from any other host. A
  body that stalls past the 5 s request limit is a `timeout`, not a malformed
  answer.
- **The session key is a correlation handle.** The start mints it (a UUID) and
  records it in `voice_sessions` with the visitor's public session and visitor
  key until `VOICE_BEHAVIOR.sessionStartTtlMs` (60 minutes: the signed URL's
  15 minutes, `elevenLabsSignedUrlValidityMs`, bound the session's open, not
  its first turn); the session's
  first turn reads that visitor and passes its grouping key (the visitor key,
  else the public session id, as the embed's chat does) to chat, so the call
  joins the website visitor, then binds the conversation onto the same row. It
  grants nothing: the completions route still admits only the REST
  credential, and a key the page mints itself works the same and joins no
  visitor. An agent's starts whose first turn never came are deleted at its
  next start.
- **Not in OpenAPI.** The completions route speaks a vendor-owned wire format,
  OpenAI chat completions as voice runtimes call it, not Radioso's API
  contract, so it has no operation in `openApiPaths.ts` and no SDK method; it is
  documented in `docs/voice-channel.md`. (The REST agent channel,
  `createAgentChannelChatResponse`, is Radioso's own contract and is
  registered.) The `voice` member of `ConversationChannelContext` is in
  OpenAPI, because history responses return it. The session start is
  Radioso's own contract and is registered as `createPublicVoiceSession`.
- **Ray coverage.** The route is a deferred exclusion in
  `tests/unit/operatorCopilot/catalogCoverage.ts`
  (`internalRuntimeCoverageExclusions.voiceCompletionsAdapter`): a voice
  runtime calls it, an operator does not. The settings block it reads is Ray's
  to author: `voice` has an `agentInputFieldSchemas` entry, so
  `propose_agent_setting` and `prepare_agent_settings` carry it whole, and
  `agent_configuration` returns the stored block. Operators edit it in the
  Voice card on the agent's Channels → API page, `runtime` included. The
  session start is a permanent exclusion (`createPublicVoiceSession`): a
  visitor's page calls it. Its vendor key is on the never-list
  (`provider_credential_writes`), so `agentSettingWholeBlockNote` sends the
  operator to Settings for it.
- **Turn policy.** Runs only while the agent's `voice.enabled` is true; with
  voice off a turn runs exactly as a plain chat turn. The bridge fires when the
  turn starts searching, 400 ms after it starts composing without speech, or
  after 2.5 s with no phase at all (only a stalled planner gets there: a
  planner quick reply takes up to about 2 s, and a knowledge turn bridges on
  `searching`); the limit is 10 s into the turn
  (`VOICE_BEHAVIOR` in `shared/domain/behaviorConfig.ts`). Both cover only
  turns the agent owns: when the conversation is human-owned at turn start
  (one ownership read, beside the routine state read) the policy runs with
  `bridge: null` and `turnLimitMs: null`, so chat's waiting message is neither
  preceded by a bridge line nor talked over by the fallback line, and neither
  is counted. That ownership read is a snapshot: chat makes its own,
  authoritative read a few milliseconds later, and a hand-off or takeover that
  lands between the two gives that one turn the other policy (a bridge before
  the waiting message, or no bridge and no limit on an agent answer). The
  turn service turns chat `status` events into phase markers
  (`interpreting`, `searching`, `composing`) that only the policy reads; adapters never see them, and with
  voice off they are dropped. `interpreting` is where every turn starts, so
  it leaves the 2.5 s fallback armed. Everything stops at the first speech or
  the outcome, and at most one bridge is spoken. The bridge
  style is `acknowledge` while a routine is active in the conversation at turn
  start and `check` otherwise; a session's first turn has no routine. Lines
  rotate per policy turn within the process. A runtime that holds a first
  sentence shorter than some length (`minReleasableSentenceChars` on the
  dialect; `ELEVENLABS_MIN_RELEASABLE_SENTENCE_CHARS`, 45, on `elevenlabs`,
  exported from `public.ts` for the Voice card and Ray's descriptors; carried
  on `VoiceTurnInput`) gets only the style's lines that reach it; when none
  does, the shorter line is spoken and
  the service warns once per agent per process. The locale is the request's
  (`VoiceTurnInput.locale`, read by the dialect), else the agent's
  `assistantDefaultLocale`, else `en`; chat stores no response language per
  message, so the last reply's language is not a source. An agent with no line
  for the locale and style hears silence, and an agent with no fallback line
  keeps waiting past the limit.
- **Outcomes (web column of the contract's table).** `voiceTurnOutcome.ts`
  reads chat's closing `done` event. `ownership` human-owned and not
  suppressed means this turn handed off: `callback_requested` (with
  `handoffReason`) when `done.handoff.collectedSlotCount > 0`, else
  `continue`. Suppressed means a person owned the conversation at turn start:
  `continue`, and the speech is chat's waiting message as chat wrote it.
  Anything else is `continue`. "Captured contact details" is structural: chat's
  `handoff` report counts the declared slots the ending routine held a value
  for (the keys of the engine's `handoff.collected`, counted in
  `chat/services/handoffOwnership.ts`); a retrieval miss reports 0. No slot key
  or value is read for meaning. The `handoff` report is chat's own reply field
  for the delivering channel (`ChatTurnHandoff`); the HTTP presenters drop it
  and the agent reply envelope does not carry it, so OpenAPI is unchanged. The
  outcome the runtime received is the one the policy let through: a turn whose
  limit spoke the fallback line ends `continue` even if the drained reply
  later hands off. `transfer` and `end` stay in the contract; phone turns get
  the same derivation, which matches the contract's phone rows only while no
  transfer target exists.
- **Outcome on the wire.** The completions adapter ends both outcomes with
  `stop` and `[DONE]` and sends no tool call. The outcome kind travels as
  `X-Radioso-Voice-Outcome`: a header on a non-streaming completion, and on a
  stream a trailer (announced with `Trailer` when the stream opens), because a
  stream's headers leave with its first frame. A turn ends with exactly one
  outcome or fails: the service raises `VoiceTurnIncompleteError` when the chat
  stream stops without `done` or `cancelled`, and the adapter holds every port
  stream to the same rule: the outcome ends the port's events, and
  `withOneOutcome` passes it on only once they have ended (no outcome is
  `VoiceTurnIncompleteError`; a second outcome, or anything after it, is
  `VoiceTurnProtocolError`). The failure answers with an HTTP error before
  the first frame, or the generic error frame after it, never `stop`,
  `[DONE]` or an outcome field; a non-streaming request never gets a
  completion for it.
- **Bridge lines are not stored.** A bridge is a channel-level utterance, like
  a typing indicator: it reaches the caller, never the conversation history.
- **After the limit.** The policy speaks the fallback line, ends its events
  with `continue`, and hands the reply's drain to the service
  (`observer.drainingAfterLimit`), so the chat turn still finishes and is
  stored; the service settles and logs the turn once the drain has ended. The
  stored answer is then not what the caller heard, and nothing in history
  marks that. The port's events end at the outcome, so the route ends the
  HTTP response there in both modes and the runtime never waits for the
  drain; the drained chat turn runs past the route's post-disconnect ceiling.
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
  exchange stays in an orphaned conversation (logged as a warn). This stays an
  in-process guarantee until a database-level session claim lands with
  Phase 0.
- **Operator takeover reaches no one.** `customerReplyDelivery.ts` has no
  `voice` deliverer, so an operator's Inbox reply never reaches the caller; the
  Inbox offers no Send on a voice conversation
  (`frontend/lib/email-send-readiness.ts`). Until an operator writes, each caller
  turn hears the chat service's waiting line; after that, silence.
- **Newest utterance wins.** ElevenLabs does not abort the HTTP stream when
  the caller interrupts: the next utterance arrives as a new request while the
  previous reply may still stream. Every voice chat turn runs with
  `supersession: "latest_input_wins"`, so the chat turn registry cancels the
  running turn for the newer one even after it started emitting
  (`supersedeAfterEmission` on the lease, applied only when both turns ask for
  it; every other channel keeps the rule that a turn which started emitting
  runs to completion). The cancelled turn yields chat's `cancelled` event, the
  service ends it with `continue`, and the route closes its stream with `stop`
  and `[DONE]`. A turn cancelled after it started emitting keeps its user
  message and stores no reply. That holds while its reply is being stored too:
  chat checks the lease once more right before the store and latches it for
  the commit as the storing transaction's last step, so the newer utterance and
  the stored reply have one winner: before the latch the newer utterance
  cancels the turn, and a reply the caller never received (a whole reply,
  written only once stored) counts as replaced before emission; after it the
  newer utterance waits for the stored turn.
- **A replaced turn leaves no trace.** A turn cancelled before it emitted
  anything by a newer turn that is also `latest_input_wins`
  (`ChatTurnSupersededError.replacedByNewerInput`) has its user message
  deleted by the chat turn lifecycle (`recordSupersession` →
  `AssistantTurnPersistencePort.discardReplacedUserMessage`); the cancelled
  `chat.answer` audit event keeps `userMessageId` and adds
  `userMessageDiscarded: true`. The deletion and the event commit in one
  transaction; when it fails, the message stays and the event is recorded
  without the flag, so no message is lost without its record. Any
  other newer turn, such as an approval resuming a routine, only cancels it,
  and the message stays. The message is deleted rather than written late
  because model-call usage events, coverage assessments and the facet job
  reference its id before the reply starts. Usage events keep the spend with
  the link cleared (`ON DELETE SET NULL`, and `DurableUsageEventRecorder`
  writes an event whose message is already gone without the link); coverage
  assessments, facets and facet jobs are deleted with it. A turn that is
  replaced while it waits for its predecessor stores nothing at all. "Before
  emission" means before chat's first chunk, which can precede the first
  spoken sentence by up to one sentence.
- **A reply cut mid-stream.** When a newer utterance arrives while a reply is
  still streaming, the caller has heard part of it and the vendor keeps the
  truncated text, but Radioso stores the caller's message with no reply. The Inbox shows an unanswered
  message, and the next turn (including a routine collecting slots) does not
  know what the agent started to say. The cut reply is not billed as an
  answer; its model tokens stay in the usage ledger.
- **Bursts.** A transcriber that flaps sends several requests in a second or
  two. `VoiceSessionMemory.arrive` marks the previous request of the session
  superseded; one still setting up (session lookup, voice profile) ends with
  `continue` before its chat turn starts, and one already in chat is cancelled
  by the registry when the newer turn starts. `arrive` runs as the request
  enters, before any read, so arrival order decides whichever request's reads
  finish first. The conversation keeps the last
  transcript and one answer. In-process only: a burst split across API
  instances can store two user messages.
- **Bridges never stack.** The policy asks `mayBridge` when the bridge falls
  due: no bridge once a newer request owns the session, and none while a bridge
  from a turn that lost its caller is younger than `bridgeAfterMs`. A
  suppressed bridge is not counted in `voice_bridge_emitted_total`.
- **Replay.** The route fires the port's `hungUp` signal when the runtime
  closes the request before the outcome was sent. A turn that was hung up on,
  or overtaken before its outcome, and that stored an answer, is replayable for
  `VOICE_BEHAVIOR.replayWindowMs` (30 s): an identical utterance (whitespace
  aside) for the session, with no chat turn running, is answered with the
  stored answer as speech, with no chat turn, no bridge and no user message.
  The replayed turn writes its `voice.reply_replayed` note once its outcome
  has left, off the response's path: the response and the session's settling
  never wait for the audit write, and a note that fails or takes longer than
  5 s logs a warn.
  While no answer is stored, the identical utterance runs as a new turn and
  supersedes the running one. In-process only.
- **Interrupted replies.** The `elevenlabs` dialect reads an assistant message
  right before the newest user message that ends in `...` as `heardUntil`.
  When it is a strict prefix of what the session's last stored turn spoke
  (bridge plus reply, zero-width spaces and spacing aside) and what it leaves
  out holds words, not only punctuation, the service logs
  `Voice reply was interrupted` and notes the stored reply with
  `heardCharacterCount` (reply characters only) and `spokenCharacterCount`,
  once per reply. Composition writes the note in two steps: it marks the
  message through chat's `ReplyInterruptionMarker`, which history reads back
  as the reply's `interruption`, then records `voice.reply_interrupted`. A mark
  that fails rejects the note before the audit write; a reply the
  conversation no longer holds is neither marked nor audited, and the note
  resolves. The note is written off the turn's path, within the 5 s note
  limit, and the session counts it recorded only once both writes succeed (`VoiceSessionMemory.reserveInterruption`): a failed note is written
  again on the next report of the same reply, where the mark is idempotent,
  and the log line and the metric follow the recorded note. The stored reply
  keeps its full text.
- **ElevenLabs session key.** ElevenLabs sends no conversation id; Radioso's
  session start or the page that starts the session mints `session_key`, and
  the page passes it as the custom LLM extra body, which arrives as
  `elevenlabs_extra_body.session_key`. Dynamic
  variables inside the extra body are not interpolated.
- **Disconnects** follow the REST agent channel: the turn keeps running after
  the vendor hangs up, and is aborted only past the post-disconnect ceiling.

## Observability

One log per turn with `agentId`, `vendor`, `transport`, `conversationId`,
`result`, `durationMs` and `speechPieceCount`, `outcome` (the kind the runtime
received) and `handoffReason` (when the turn handed off), plus `bridged`,
`turnLimitReached` and `fallbackSpoken` when the voice policy ran: `Voice turn
reached the turn limit` at warn when the limit fired, else `Voice turn finished` at info
(`completed`, `replayed`, `superseded` with `supersededAt`: `before_speech` or
`after_speech`, `abandoned`), or `Voice turn failed` at warn with
`errorClass`. `Voice reply was interrupted` at info names the conversation,
the reply's message id and the two character counts, once the note is
recorded; a note that fails to record, or takes longer than 5 s, logs `Voice
turn note could not be recorded` at warn, and an interrupted reply the
conversation no longer holds logs `Voice reply to mark interrupted was not
found` at warn (workspace, conversation and message ids) and writes no audit
event. A warn when a concurrent first turn bound the session to another
conversation, and a warn naming only `dialect` and `agentId` when a request
carries no usable session key (a 400). Once per agent per process, when a
turn's bridge line is below the dialect's minimum, `Voice bridge line is
shorter than the runtime speaks on its own` at warn with
`event: "voice.bridge_line_below_vendor_minimum"`, `agentId`, `vendor`,
`lineCharacterCount` and `minimumCharacterCount`. A stream that fails after its first
frame ends with one generic OpenAI error frame. Never the utterance, the reply
or an internal error message. Chat-side spans, metrics and failure logs cover the
turn itself.

A session start records `voice_session_start_total` (`vendor`: the bound
vendor or `none`; `outcome`: `started`, `agent_not_found`, `voice_off`,
`no_runtime`, `credential_missing`, `credential_unreadable`,
`credential_read_failed`, `registration_failed`, `vendor_failed`). A start
that fails logs `Voice session start failed` at warn with `workspaceId`,
`agentId`, `vendor` and `outcome`, plus `errorClass` when something threw and
the vendor's `reason` and `vendorStatus` when it answered. A first turn whose
start cannot be read logs `Voice session start could not be read; the turn
runs without its visitor` at warn with `agentId`, `vendor` and `errorClass`.
Never the key, the signed URL or the session key. Credential writes are audited by the credential store
(`workspace_provider_credentials.set` and `.remove`, `metadata.provider`).

The policy records `voice_turn_first_speech_ms` (histogram, `bridged`),
`voice_bridge_emitted_total` (`style`, `locale_resolved`: `no` when the agent
had no line, so nothing was spoken) and `voice_turn_limit_total`
(`locale_resolved`: `no` when there was no fallback line and the turn kept
waiting). The service records `voice_turn_superseded_total` (`stage`:
`before_speech`, `after_speech`), `voice_turn_replayed_total`,
`voice_reply_interrupted_total` and `voice_turn_outcome_total` (`kind`:
`continue`, `callback_requested`; `handoff_reason`: `routine_handoff`,
`routine_stuck`, `retrieval_miss`, `none`), once per turn that sent an
outcome. Labels are closed enums; no line text, locale tag or id. The chat registry's `chat_turn_cancellations_total` counts a voice
turn cancelled mid-reply with `stage: "persisting"`.

## Tests

- `cd backend && pnpm exec vitest run tests/unit/voice-channel-*.test.ts` (the
  policy tests use fake timers; `voice-channel-composition-notes` covers the
  mark-then-audit order of the notes)
- `cd backend && pnpm exec vitest run tests/unit/conversation-turn-registry.test.ts tests/unit/chat-service-routine-reply-streaming.test.ts`
  (the chat side of `latest_input_wins`: cancelling after emission, and the
  replaced turn's user message; and the `handoff` report on a streamed
  routine hand-off)
- `cd backend && pnpm exec vitest run tests/unit/routine-ending-effects.test.ts tests/unit/chat-turn-lifecycle.test.ts tests/unit/chat-presenter.test.ts tests/unit/public-chat-presenter.test.ts`
  (the slot count on a hand-off, the reply's `handoff` report, and the
  presenters that keep it out of HTTP responses)
- `cd backend && pnpm exec vitest run tests/contract/agent-voice-settings.contract.test.ts`
  (the settings round trip and the dashboard-save safety check)
- `cd backend && pnpm exec vitest run tests/contract/public-voice-session.contract.test.ts tests/contract/settings-credentials.contract.test.ts`
  (the session start through the embed's public session, with a fake vendor
  `fetch`; the ElevenLabs key in the credential store)
- `cd backend && pnpm exec vitest run tests/integration/voice-session-repository.integration.test.ts`
  (needs the disposable integration database; see the code map)
