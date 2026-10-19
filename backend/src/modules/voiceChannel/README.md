# Voice Channel Module

Voice owns spoken sessions with an agent, and where each call's recording
lives. A voice runtime (ElevenLabs Agents,
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
  list markers, link syntax) from everything spoken, by structure only,
  as one list of removals (`speechRemovals`) the sentence cutter shares;
  while a reply streams, `speechSegmenter.ts`'s sentence cutter closes an
  emphasis only before a space, line break or punctuation (the end of the
  reply closes the rest), removes list markers only at a real line start,
  and reports where each sentence it releases ends in the written reply
  (`writtenEnd`, by a source map it keeps for its tail only; null where it
  cannot place one); `heardSpeech.ts` is the pure measure of how much of a
  turn's speech its caller heard, by the runtime's own record of what it
  played, compared piece by piece so whatever the runtime puts between
  pieces (a flush delta, a space, nothing after a full-width terminator)
  does not matter;
  `voiceTurnPolicy.ts` is the pure timing wrapper (bridge and turn limit) over
  those events; on a turn that may switch the call's language it holds the
  bridges a phase brings until chat reports the turn's language, and ends the
  request with the switch when the turn asks for one;
  `languageSwitchFollowUp.ts` (`LanguageSwitchFollowUps`) decides a turn's
  switch of the call's language and runs the runtime's follow-up after it,
  held or unheld, over the turn service's own steps (`VoiceTurnSteps`: the
  policy, the teammate replies, the delivery); `switchedTurns.ts` holds a
  turn that switched with its running reply (`SwitchedReply`, pulled to its
  end whether or not anyone speaks it), one per session, until the replay
  window passes or the caller speaks again; `voiceTurnRecord.ts` is the
  turn's record and the speech helpers both share, with the switch's one
  pairing (`SwitchedTurn`: the switching turn's record and its speaker's),
  which the log, the session's exchange and chat's `deliveredReply` read
  through `chatTurnOf` and `speakerOf`; `voiceLines.ts` resolves the turn's language
  (`resolveVoiceLanguage`) and picks the turn's bridge and fallback lines by
  routine state and that language (tag structure only, never the lines' words);
  `voiceSessionMemory.ts` is the in-process memory of each session between its
  requests (the newest request, the last bridge, the last exchange);
  `voiceTurnMetrics.ts` names the turn's series;
  `voiceSessionStartService.ts` starts a session: it reads the agent's
  `voice.enabled` and `voice.runtime`, the workspace's key for that vendor
  through `VoiceVendorCredentialReader`, asks that vendor's
  `VoiceSessionStarter` for the session, and mints the session key (a UUID).
  The same service is the `VoiceSessionAvailabilityPort`: by the gate a start
  passes (`voice.enabled`, a bound `voice.runtime`) and the presence of that
  vendor's key (`presence`, which decrypts nothing and reads `unreadable`
  when the backend has no master key), `readiness` names the first missing
  piece for the dashboard (`GET /api/v1/agents/:agentId` returns it as
  `voiceCallReadiness` to dashboard sessions, and leaves it out when the
  credential store cannot be read) and `isAvailable` is the yes or no the
  embed config may carry. Composition's
  `refreshEmbedConfigsOnVoiceVendorKeyChange` drops the workspace's
  CDN-cached embed configs when a voice vendor key is stored or removed, so
  that yes or no follows the key at once.
  `voiceRecordingService.ts` is a call's recording as the operator meets it:
  the page's report of the vendor's conversation id
  (`VoiceVendorConversationReportPort`, stored only once the vendor's
  `describeConversation` names the vendor agent the session was started on),
  whether a conversation has a recording (`VoiceRecordingAvailabilityPort`'s
  `availability`: from `voice_sessions` and the key's presence, no vendor
  call, null for a conversation that is not a call or cannot be read; the
  history detail and Ray's transcript both ask it) and a play
  (`VoiceRecordingPlaybackPort`), audited through `VoiceRecordingAudit`
  before the audio is handed on; `voiceRecordingErasureService.ts` deletes
  recordings at the vendor when their conversation, visitor, workspace or
  organization is deleted (`VoiceRecordingErasurePort`, the shared
  `VendorHeldConversationDataEraser` in `shared/domain/conversationDataErasure.ts`:
  one erasure per deletion, its scopes in order under one concurrency limit
  and one deadline).
- `persistence/` maps `(agent_id, vendor, session_key)` to a conversation in
  `voice_sessions`. The first binding wins. A Radioso-started row also holds
  the vendor agent it opened on, that account's region and, once reported and
  confirmed, the vendor's conversation id (`VoiceRecordingStore`). A row that
  holds that id outlives its agent, its conversation (both links are SET
  NULL) and the next start's cleanup; it goes with its workspace. A session
  whose conversation is gone is unbound, and its next turn binds a new one.
- `adapters/*` translate one wire to the domain port and back, and nothing
  else. `adapters/openaiCompletions/` is the OpenAI chat-completions wire;
  vendors that share it differ only by a dialect in `dialects.ts`, which is
  data: where the session key, the session's locale and the turn's own
  language travel (a header, a body path, or a named tool's calls and results
  in the replayed `messages`, which `languageSwitches.ts` reads; the same tool
  is the one a switching reply calls, and the presenter renders that call), the default
  transport, the flush and keep-alive deltas a runtime needs, and the suffix
  it appends to a reply the caller cut short. Vendor field names live there
  and in `requestSchema.ts`, never in the domain. `adapters/elevenlabs/` is
  the ElevenLabs `VoiceSessionStarter`: the signed-URL request with the key in
  `xi-api-key`, its response, its 15-minute validity and its 5-second timeout,
  over an injected `fetch`, and the ElevenLabs `VoiceRecordingSource`
  (`recordingSource.ts`): the conversation's audio and its deletion, with the
  key in `xi-api-key`, one byte range passed on, a non-audio answer refused,
  and a 5-second limit on the answer that leaves the audio itself unbounded.
  `describeConversation` reads the conversation document (64 KB cap) for its
  `agent_id`. The audio stops when it stalls for 15 s while the listener
  waits; a listener who pauses never trips it. Both adapters use the region
  host table in `hosts.ts` and the body helpers in `fetchHelpers.ts`.

Dependency direction is adapter → `VoiceTurnPort` → chat. The service reaches
chat through the narrow `VoiceChatPort` (`streamTurn`) and imports chat only
through `modules/chat/contracts`. It asks every chat turn for the
`latest_input_wins` supersession mode, which the chat turn registry owns, and
for the `language` stream event (`reportResponseLanguage`), which carries the
planner's tag for the turn's response language. The domain never imports an adapter or composition.

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
  `createElevenLabsSessionStarter`; the recording ports,
  `VoiceRecordingService`, `VoiceRecordingErasureService`,
  `VoiceRecordingAudit` and `createElevenLabsRecordingSource`.
- `backend/src/app/composition/voiceChannel.ts` — builds the port over a
  session store, `AssistantChatService.streamAnswer`, the agent repository (voice
  settings and default locale), the routine state store, the conversation
  ownership reader (`handoff/public.ts`), the message repository as chat's
  `OperatorReplySpeechClaims` (with `randomUUID` minting each turn's claim id),
  `ReplyInterruptionMarker` and, through `createVoiceStoredReplyReader`, the
  `VoiceStoredReplyReader` a switch's follow-up reads, and the audit service (the
  `voice.reply_interrupted`, `voice.reply_replayed` and
  `voice.operator_reply_spoken` notes, built by `createVoiceTurnNotes`; a
  reply chat stored as its heard part carries its `voice.reply_interrupted`
  event in chat's store, so no note is written for it);
  exposed as `AppDependencies.voiceTurns`. The test app builds its port
  through the same function.
  `createVoiceSessionStartComposition` in the same file builds the session
  start over the agent repository, the ElevenLabs starter with `fetch`, the
  workspace credential store's `getApiKey` as the credential reader, and the
  start registry; exposed as `AppDependencies.voiceSessionStarts`.
  `app/server/dependencies.ts` builds one `VoiceSessionRepository` and hands it
  to both: the turn reads bindings and starts from it, and the start records
  into it. `createVoiceRecordingComposition` builds the recording services
  over the same repository, the ElevenLabs recording source with `fetch`, the
  same credential reader and the audit service
  (`conversation.recording_played` and `conversation.recording_deleted`,
  built by `createVoiceRecordingAudit`); the playback is
  `AppDependencies.voiceRecordings`, Ray's catalog reads its availability,
  and the erasure is the workspace service's
  `VendorHeldConversationDataEraser`.
- `backend/src/app/http/routes/conversationRecordingRoutes.ts` — mounts
  `GET /api/v1/conversations/:conversationId/recording` (dashboard sessions,
  `workspace.history.read`, `sessionOnly` in `apiPrincipalRoutePolicy.ts`),
  streaming the audio with `Cache-Control: private, no-store`; `404` for no
  recording or no audio yet, `416` for a range past the end,
  `503 recording_unavailable` otherwise. `HEAD` is `405`, and a browser
  request whose `Sec-Fetch-Site` is not `same-origin` is `403`. A listener who
  goes away before the vendor answers gets no answer and leaves no warn,
  count or audit.
  `historyRoutes.ts` adds `recording: { available }` to a voice
  conversation's detail for dashboard sessions.
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
- **Recordings stay with the vendor.** Radioso stores where the recording
  is, never the audio: the vendor agent and region at the start and the
  vendor's id for the call, which the page reports once through
  `POST /api/v1/public/chat/:token/voice/sessions/:sessionKey/vendor-conversation`
  (website embed sessions, the same public session as the start, the
  session-read budget). The id is taken only for a session Radioso started
  for that public session while its start is unexpired, at most once, only
  after the vendor says the conversation was held on the session's vendor
  agent (one vendor call per report, none for a report no session waits
  for; a vendor that does not show the conversation yet is a retryable 503,
  only another agent's conversation is a final 404), and is unique per
  vendor and region; it is only ever used to look the
  recording up with the workspace's own key, and no response carries it. A
  self-minted session key has no recording. Each answer that carries audio is
  audited first; an audit that fails refuses the play, and `partial` follows
  the bytes sent. Every deletion that reaches a recording reads the
  recordings and the key before anything removes them, then asks the vendor
  to delete each once it committed, four at a time for at most 20 s in all:
  the privacy module's conversation and visitor erasure (the unit of work's
  `vendorHeldData`, bound to the erasure's transaction by
  `createVoiceRecordingComposition`'s `erasureIn`, read with the session rows
  locked before its erasers run, and a failed read failing the erasure; a
  visitor's scope adds their key, for calls no turn ever bound;
  `persistence/voiceSessionEraser.ts` is the `voice-channel` conversation and
  visitor-key eraser that then removes the rows), and workspace and
  organization deletion (the workspace service's hook, best-effort before the
  deleting transaction) (deletes still in flight at
  the deadline are aborted); what is left is logged with its ids and never
  fails the deletion. Deleting an agent deletes no
  recording. The route is a permanent coverage exclusion
  (`getConversationRecording`: binary audio a teammate hears); Ray's
  `conversation_transcript` carries `recordingAvailable`. The agent's
  optional `voice.recordingNotice` is shown by the embed, not spoken: the
  session start hands it to the page in the call's language, else the
  agent's default, else English, else the first one written.
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
  the service warns once per agent per process. The language is the one the
  request reports for the turn (`VoiceTurnInput.turnLanguage`, next decision),
  else the session's (`VoiceTurnInput.locale`, read by the dialect), else the
  agent's `assistantDefaultLocale`, else `en`: the first present wins
  (`resolveVoiceLanguage`), and the lines match it by tag, then primary subtag,
  then any tag of that language. Chat stores no response language per message,
  so the last reply's language is not a source. The bridge is in that
  language or silent, and so is the fallback line, except on a turn that
  reports its own language: there the fallback line is the first written for
  the turn language, the session's, the agent default or `en`, in that order,
  because a caller who switched to a language without lines is better told in
  the call's other language than left waiting past the limit. A session that
  reports no turn language keeps the authored rule (one language, or none).
  An agent with no fallback line for the turn keeps waiting past the limit.
  `languagesInOrder` in `voiceLines.ts` is the one ordered list behind the
  turn's language, the fallback order and the recording notice.
- **Mid-call language.** What the turn reads when a request reports a turn
  language, as structured data only (how a turn switches an `elevenlabs`
  call itself is under **Switching the call's language** below). On `elevenlabs` that is
  the newest `language_detection` call (ElevenLabs's system tool that
  switches the call's voice and transcription:
  https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/language-detection)
  in an assistant message's OpenAI `tool_calls` anywhere in the replayed
  history, paired with the nearest `role: "tool"` result after it with its
  `tool_call_id`, before any later call that reuses the id
  (`adapters/openaiCompletions/languageSwitches.ts`, over the schema's parsed
  `messages`). A result object is read as the vendor's system tool result
  (`is_error`, and `status: "success"`, after the conversation API's
  `LanguageDetectionToolResultModel`,
  https://elevenlabs.io/docs/api-reference/conversations/get); a plain-text
  result is the error the vendor gives the LLM for a refused switch ("the
  tool returns an error to the LLM"); both were seen on the custom-LLM wire
  in the 2026-10-18 probe. A refused switch is skipped, and the switch before it stands.
  The search ends with no turn language and `unreadable` at the first switch
  it cannot read (no result, a result object of another shape or JSON that
  does not parse, or no language tag in its arguments), refused ones above it
  included, since the call may be in either language. On `generic` it is the
  `X-Radioso-Voice-Turn-Locale` header, then `metadata.turn_locale` (a header
  sent twice arrives joined and is not a tag). The source is
  `vendor_detected` or `turn_field`; a skipped or unread newest switch is
  `VoiceTurnInput.languageReport` (`blocked`, `unreadable`). The reported
  language picks the lines (previous decision). It reaches chat as the turn's
  `userExpectedLocale` only when it is news on the request
  (`VoiceTurnInput.turnLanguage.isNew`: a per-turn field, or a switch after the
  caller's previous utterance); chat's no-evidence replies and action
  suggestions follow it, and the planner, the composers and the quick replies
  read the caller's language from the utterance on every turn. A session
  locale, or a switch an earlier turn made, is not passed: either would hold a
  caller who moved on to a language they no longer speak. The recording
  notice is chosen at the session start, before any turn, so it follows the
  session locale. The turn language is the request's alone: it is in the
  turn's log line, `voice_sessions` keeps no locale, the conversation stores
  none, and the visitor's `last_language` is not written (the route passes no
  request facts). The cut-off reply (`heardUntil`) is the assistant message
  said right before the newest user message, past any tool result or
  tool-call-only assistant message replayed between them.
- **Switching the call's language.** On an agent with
  `voice.languageSwitching`, a request whose `tools` offer the dialect's
  switching tool (`VoiceTurnInput.languageSwitchOffer`, with the languages the
  runtime refused on the call) may switch the call. Only such a turn asks
  chat for the `language` stream event (`reportResponseLanguage`; the
  planner's `responseLanguageTag`), and until it arrives the policy holds the
  bridges a phase brings; the 2.5 s stall bridge and the limit stay armed.
  The window closes `VOICE_BEHAVIOR.languageSwitchDecisionMs` (4 s) into the
  turn, at the first spoken line, or when the language arrives. The turn
  switches when the tag's primary subtag differs from the call's
  (`resolveVoiceLanguage` over the reported turn language, the session locale
  and the agent default; compared only when both subtags have two letters),
  the runtime did not refuse it, the request reports no `unreadable` switch,
  and no teammate's reply was spoken: it yields `switchLanguage` (the primary
  subtag, reason `response_language`, an id from `newLanguageSwitchId`) and
  `outcome: continue`, and the presenter renders the tool call alone with
  `finish_reason: "tool_calls"`, since content beside it is spoken twice. The
  dialect's whitespace keep-alive before it is safe, and its replay as a
  whitespace-only assistant message reads as nothing said (probe,
  2026-10-18). The chat turn runs on behind the response: `SwitchedTurns`
  holds its remaining events, with the phases seen, its start, profile and
  routine state, for the follow-up, one per session, for `replayWindowMs`; the
  turn settles and logs `languageSwitch: "emitted"` when its chat turn ends.
  The runtime's follow-up (`VoiceTurnInput.languageSwitchResult`, recognized
  by Radioso's own reason, the replayed `fc_` prefix removed) takes the
  session's held turn when the utterance matches (warning when it names
  another switch id; another utterance lets the held turn go as
  `mismatched`), reads only the conversation's owner, and speaks those events
  under the policy as part of the switched turn: its bridge and limit count
  from that turn's start, its lines are in the language it reports. It claims
  the teammate replies pending by then, counts `confirmed` or `refused` once
  it is past its supersession check (overtaken before it spoke, the switch is
  `unanswered`), is the record chat's `deliveredReply` consults if a newer
  utterance cuts it off, and its exchange is the session's newest. A
  follow-up this process holds nothing for (`unheld`) reads the conversation
  through `VoiceStoredReplyReader` every `switchFollowUpPollMs`: it bridges in
  its language and speaks the agent's answer whole once it is stored, or the
  fallback line at the limit. A switch let go unspoken (`unanswered`,
  `mismatched`) marks its exchange cut off at the switch, so an identical
  re-request replays it, and counts its outcome once its chat turn ends; a
  switching turn's outcome and lines' language are counted once. A reply that
  fails after the switch is the switched turn's failure, logged once. A switch
  Radioso asked for is no `userExpectedLocale` news on the next turn. Two
  series count switches: `voice_language_switch_total{emitted, unanswered,
  mismatched}` where the switching turn is held, and
  `voice_language_switch_followup_total{confirmed, refused, unheld}` where the
  follow-up arrives; `unheld` logs at info, since it is the multi-instance
  path. A switch let go unspoken counts its turn's outcome and lines'
  language when its chat turn ends, and the switching turn's own log line
  carries its reply's outcome rather than the switch's `continue`.
- **Another tool's follow-up is no turn.** A request whose newest message has
  `role: "tool"` for any other tool is the runtime's follow-up after running
  it; read as a turn, its newest user message would be answered again (a
  replay, or a second user message). The route answers it with an empty
  completion (`stop`, outcome `continue`) before `turnInputFor`, runs no turn,
  calls no `onTurnAccepted`, and logs `voice.tool_followup_ignored` at debug.
  A switch's follow-up calls no `onTurnAccepted` either: it admits no turn.
- **Outcomes (web column of the contract's table).** `voiceTurnOutcome.ts`
  reads chat's closing `done` event. `ownership` human-owned and not
  suppressed means this turn handed off: `callback_requested` (with
  `handoffReason`) when `done.handoff.collectedSlotCount > 0`, else
  `continue`. Suppressed means a person owned the conversation at turn start:
  `continue`, and the speech is the teammate's pending replies, else chat's
  waiting message as chat wrote it.
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
- **A teammate's reply is spoken on the caller's next turn, once.** A call
  speaks only when the runtime asks, on the caller's next utterance, and there
  is no push channel, so an Inbox reply waits for that request. The handoff
  module stores a reply on a voice conversation with `speech: { state:
  "pending" }` (`operatorRepliesAreSpoken` in
  `chat/contracts/operatorReplySpeech.ts`); `customerReplyDelivery.ts` has no
  `voice` deliverer and needs none. The voice domain knows one chat-side port
  of the reply, `OperatorReplySpeechClaims` (the turn service's mandatory
  `operatorReplies.claims`): `claimPendingOperatorReplies` claims and reads
  the conversation's pending replies in one UPDATE ... RETURNING (`[{ messageId,
  text }]`, oldest first), and `markOperatorRepliesSpoken`,
  `skipOperatorReplies` and `releaseOperatorReplies` settle what the turn
  still holds. Chat owns what a reply means and how it is stored.
  Exactly-once is a fact in the stored state, not in process memory: a reply
  is `pending`, `claimed` (with `claimedAt` and the turn's `claimTurnId`),
  `spoken` (`spokenAt`) or `skipped`; every change is one conditional UPDATE,
  so two turns on two instances never both hold a reply, and a claim older
  than `VOICE_BEHAVIOR.operatorReplyClaimExpiryMs` (60 s) reads as pending
  again. `services/operatorReplySpeaker.ts` is one turn's side of it: it
  claims beside the turn's profile, routine and owner reads, cuts each reply
  with `wholeTextSpeech` (`speechSegmenter.ts`, through `speechText.ts`, so
  markdown is removed and every piece ends in whitespace; a reply with no
  words is skipped), and settles once. The turn speaks what it claimed after
  its `conversation` event, ahead of chat's answer and outside the turn
  policy, whoever owns the conversation. On a human-owned turn chat answers
  nothing once a teammate has written (its waiting line stops at the first
  human reply in its ten-message history window), so the replies take the
  waiting line's place and the turn ends `continue`; after a hand-back the
  agent's answer follows under its turn limit, and `mayBridge` holds the
  bridge line back once a reply was spoken. A replay of a lost answer claims
  the pending replies too and speaks them before the answer; one overtaken
  while it claims ends `continue` and hands its claim back. The turn settles
  as its outcome leaves, before a turn-limit drain: the replies its caller
  heard to their end (next decision) are marked spoken (the first `spokenAt`
  stays), then counted, then audited through the `operatorRepliesSpoken` note
  (`voice.operator_reply_spoken`, conversation id and marked ids, never the
  text); the rest go back to pending. A request that overtook a turn of the
  session whose outcome had not left (`VoiceTurnClaim.overtook`, in process)
  settles that turn's claim first, within the note timeout, before it claims,
  so a caller who speaks over a reply hears it whole on that turn; across
  instances that turn is not visible, and the reply waits for it or for the
  claim's expiry. A
  settling write that fails warns and leaves the claim to expire; an audit
  that fails after the mark is logged and not retried. The session's
  interruption bookkeeping measures the replies' pieces ahead of the answer
  (`VoiceExchange.spoken`, the same `heardSpeechOf` measure), so a reply cut
  short after them is marked with its own characters only.
- **What the caller heard.** Text reaches the runtime far ahead of its
  speech, and the runtime keeps the old stream open while the caller's new
  utterance is spoken and transcribed, so what reached the runtime overstates
  what was heard by the synthesis backlog and the whole barge-in. The measure
  is the runtime's own: the request that cuts in carries the reply cut short
  to what was played (`heardUntil`). When it overtook a turn still in flight
  whose speech reached the runtime, `noteInterruptedReply` keeps it on that
  turn's record (`reported`, measured once there, a mismatch warning once)
  and never applies it to the stored exchange before it; it always arrives
  before chat asks that turn what to keep. A report for a turn whose whole
  reply settles after the request that sent it is reserved against that
  turn's own exchange (`reserveInterruptionOf`). The record keeps each piece
  that left the turn with whether it reached the runtime before the turn lost
  its caller (`reached`, against `cutOffAt`; never on a response with
  `VoiceTurnInput.streamsSpeech` false, which the runtime gets only at its
  outcome), and each answer piece with where it ends in the written answer,
  carried on its speech event through the policy and stripped before the
  port's output. `heardSpeech.ts` (`heardSpeechOf`) measures that speech
  against the report: the teammate pieces and the answer pieces played to
  their end, and the answer characters heard; with no report, everything that
  reached the runtime counts as heard. A teammate's reply is marked spoken when
  its turn's outcome reached the runtime before the cut, or when the report
  shows all its pieces played (`operatorReplyPiecesHeard`, handed to
  `OperatorReplySpeaker.settle`); the reply the caller cut into, every reply
  after it, and all of them without a report go back to pending, so the turn
  that cut in speaks them whole, and a barge-in on a call a person owns is
  not met with silence. A turn that fails hands every reply back
  (`settle(null)`). A reply whose turn completed stays Spoken even when the
  caller then talks over its audio while the runtime still plays it; only the
  agent's replies are marked interrupted.
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
  message, and keeps as its reply only what reached the caller (next
  decision); no whole reply is stored for it. That holds while its reply is
  being stored too:
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
- **A reply cut mid-stream is stored as far as it was heard.** Every voice
  chat turn hands chat a `deliveredReply` reader (chat's
  `DeliveredReplyReader`, in `chat/contracts/interruption.ts`). When a newer
  utterance cancels the turn after its reply started, chat's lifecycle asks
  it once, while the turn still holds its lease, so the newer turn waits for
  the store as it waits for a commit. The turn answers with the answer's
  pieces the caller heard to their end (previous decision), cut at the
  written end of the last of them (an unplaceable one warns and stores no
  part), the answer
  characters heard and those that reached the runtime, and its own audit
  event of the cut (`voice.reply_interrupted`, counts and `partial: true`);
  null when no piece with words was heard whole or the fallback line stood in
  for the answer. A report that does not match what reached the runtime warns
  (`Voice reply reported heard does not match what reached the runtime; the
  stored part follows what reached it`, with counts) and falls back to what
  reached it. Chat stores the part, citation markers and delimiters the cut
  left open removed and markdown kept, marked `interruption: { heardCharacterCount,
  spokenCharacterCount, partial: true }`, with the cancelled `chat.answer`
  event and that audit event in one transaction, and names it on its
  `cancelled` event (`storedReply`, `partial: true`; a whole reply chat had
  stored before the cut comes as `partial: false` and is the turn's reply as
  it streamed); the turn counts and logs the
  interruption then. The turn remembers the part as the exchange's reply
  (`VoiceStoredReply.partial`): the session counts it measured, so a later
  `heardUntil` for it is a no-op, and it is never replayed. The cut reply is
  not billed as an answer; its model tokens stay in the usage ledger.
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
  A reply stored as its heard part is not replayed: the utterance runs a new
  turn, which sees the part in its history.
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
  keeps its full text. A reply stored as its heard part is born marked
  (`partial: true`), so no report of it is noted again.
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
received), `handoffReason` (when the turn handed off) and
`spokenOperatorReplies` (when it spoke a teammate's replies),
`storedPartialReply: true` (when chat kept the heard part of its cut-off
reply), plus `bridged`,
`turnLimitReached` and `fallbackSpoken` when the voice policy ran,
`turnLanguage` (the BCP 47 tag the lines were picked in) with
`languageSource` (`vendor_detected`, `turn_field`, `session`,
`agent_default`, `builtin_default`) on a turn that ran with its lines (the
turns `voice_turn_language_source_total` counts), `reportedTurnLanguage` (the
tag the request reported) on every turn that reports one, voice off
included, and `languageReport` (`blocked`, `unreadable`) when the newest
language switch the request carried was not taken: `Voice turn
reached the turn limit` at warn when the limit fired, else `Voice turn finished` at info
(`completed`, `replayed`, `superseded` with `supersededAt`: `before_speech` or
`after_speech`, `abandoned`), or `Voice turn failed` at warn with
`errorClass`. A tool result follow-up logs `Voice tool result follow-up
answered with an empty completion` at debug with `event:
"voice.tool_followup_ignored"`, `dialect` and `agentId`, and no turn line.
`Voice reply was interrupted` at info names the conversation,
the reply's message id, the two character counts and `partial`, once the note
is recorded (for a reply chat stored as its heard part, once chat names the
stored part, whose audit event committed with it); a report of what was heard
that does not match what reached the runtime logs `Voice reply reported heard
does not match what reached the runtime; the stored part follows what reached
it` at warn with `agentId`, `vendor`, `conversationId`,
`reachedCharacterCount` and `reportedCharacterCount`; a note that fails to record, or takes longer than 5 s, logs `Voice
turn note could not be recorded` at warn, and an interrupted reply the
conversation no longer holds logs `Voice reply to mark interrupted was not
found` at warn (workspace, conversation and message ids) and writes no audit
event. `Voice turn could not update the teammate's pending replies` at warn
with `agentId`, `vendor`, `conversationId`, `errorClass` and `step`
(`claim`, `mark`, `skip`, `release`). A warn when a concurrent first turn bound the session to another
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
waiting). The service records `voice_turn_language_source_total` (`source`,
the same values as `languageSource`) once per turn that runs with the lines
it chose: not for a turn a person owns, which speaks neither line, nor for one
a newer request overtook while it set up. It records `voice_turn_superseded_total` (`stage`:
`before_speech`, `after_speech`), `voice_turn_replayed_total`,
`voice_reply_interrupted_total` (`partial`: `yes` for a reply stored as its
heard part, counted as its store commits; `no` for a finished one, counted
once its note is recorded), `voice_operator_reply_spoken_total` (one
per teammate reply a turn recorded as spoken, no labels) and
`voice_turn_outcome_total` (`kind`:
`continue`, `callback_requested`; `handoff_reason`: `routine_handoff`,
`routine_stuck`, `retrieval_miss`, `none`), once per turn that sent an
outcome. Labels are closed enums; no line text, locale tag or id. The chat registry's `chat_turn_cancellations_total` counts a voice
turn cancelled mid-reply with `stage: "persisting"`.

A recording play records `voice_recording_fetch_total` (`vendor`, or `none`
before one is known; `outcome`: `served`, `no_recording`, `store_failed`,
`credential_missing`, `credential_unreadable`, `credential_read_failed`,
`vendor_not_found`, `range_not_satisfiable`, `vendor_failed`, `audit_failed`)
and, for a failure, `Voice recording could not be read` at warn with
`workspaceId`, `conversationId`, `vendor`, `outcome` and the vendor's `reason`
and `vendorStatus`. A report records `voice_vendor_conversation_report_total`
(`recorded`, `no_session`, `vendor_not_found`, `vendor_agent_mismatch`,
`already_reported`, `store_failed`, `credential_*`, `vendor_failed`) and logs
`Voice vendor conversation report was refused` or `… could not be checked`
with `workspaceId`, `agentId`, `vendor` and `outcome`. A deletion records
`voice_recording_delete_total` (`deleted`, `already_absent`, `vendor_failed`,
`credential_*`, `deadline_passed`) and logs `Voice recording was left at the
vendor` at warn for every recording it leaves, past the deadline included,
with `conversationId` and `vendorConversationId` so an operator can delete
it at the vendor. Otherwise never the vendor's conversation id, and never
the key, the vendor URL or any audio.

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
- `cd backend && pnpm exec vitest run tests/contract/voice-operator-reply.contract.test.ts`
  (an Inbox reply on a human-owned call spoken on the next turn, then marked
  and audited; a reply pending at hand-back spoken before the agent's answer)
- `cd backend && pnpm exec vitest run tests/contract/voice-turn-language.contract.test.ts`
  (an ElevenLabs call started in English whose replayed history then carries
  a `language_detection` switch to Italian: the Italian bridge line, and chat
  handed `it`)
- `cd backend && pnpm exec vitest run tests/contract/voice-cut-reply.contract.test.ts`
  (a streamed reply the caller speaks over mid-stream, stored as far as it was
  spoken, marked `partial`, and audited)
- `cd backend && pnpm exec vitest run tests/contract/voice-recording.contract.test.ts`
  (the report, the detail flag, playback through a fake vendor `fetch`, and
  deletion with the workspace)
- `cd backend && pnpm exec vitest run tests/integration/voice-session-repository.integration.test.ts`
  (needs the disposable integration database; see the code map)
