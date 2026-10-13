# Voice for Web Summit — first steps

Date: 2026-10-12 · Freeze: 6 November · 19 working days left · Companion: [proposal.md](proposal.md)

## 0. What changed since the proposal

- `origin/main` merged. Routine streaming shipped in v1.15.0 (#1443): routine steps that ask or re-ask stream as `chunk` events; durable endings (every hand-off, every routine ending, actions, approvals) are persisted first and delivered whole. Prompt caching shipped (#1484). Both are free latency wins for voice.
- The REST agent-channel door (`POST /api/v1/agents/:agentId/chat`) is already excluded from OpenAPI, so a voice door can follow that precedent and skip the SDK snapshot for the demo. That is a choice to state in the PR, not an accident.
- Vendor test run on 2026-10-12 against a stub behind a Cloudflare tunnel (agent created by API, text-mode WebSocket session). Findings: the configured custom-LLM URL gets `/chat/completions` appended, so it must end in `/v1`; auth is `Authorization: Bearer <workspace secret>` referenced by `custom_llm.api_key.secret_id`; ElevenLabs sends no conversation identifier of its own, the client must supply `custom_llm_extra_body` at session start (arrives every turn as `elevenlabs_extra_body.<key>`, `{{system__conversation_id}}` is not interpolated) and the agent needs `platform_settings.overrides.custom_llm_extra_body: true`; the full history is replayed each turn behind ElevenLabs' own system prompt; on interruption the HTTP stream is **not** aborted, the next utterance arrives as a new request and the replayed history carries the interrupted reply truncated to what was heard with a trailing "...". The `elevenlabs` dialect now reads `elevenlabs_extra_body.session_key`. Text-mode vendor overhead was about 145 ms; the audio floor needs the browser test.
- Browser (audio) sessions on 2026-10-13, two runs with a headset, English and Italian, against the stub. Vendor per-turn metrics: silence-to-initiation 256 to 448 ms, ASR trailing 19 to 50 ms, LLM time-to-first-byte 400 to 771 ms (stub first frame at 150 ms, the rest is the tunnel), LLM time-to-first-sentence 1,100 to 1,388 ms (the vendor only releases a sentence when the next chunk arrives, so the stub's 700 ms gap inflates it), TTS first byte 70 to 466 ms, **end-of-silence to first audio 1.2 to 2.2 s with a zero-cost backend**. Barge-in worked on every reply (`interrupted: true`) and never aborted the HTTP stream. **Speculative turns are real**: with `turn.speculative_turn: true` (the default, `turn_model: turn_v3`) the vendor fires the custom-LLM request on a guessed end of turn ("Okay.") and aborts it about 1 s later when the caller continues, then re-sends the longer transcript. Against Radioso each speculative request would run a full turn and persist a user message. Mitigation for the demo: `speculative_turn: false` on the agent (set on the test agent, latency effect to be measured); for PR 4: a voice turn aborted before its first speech must leave no trace. Italian was transcribed correctly in an English-configured agent; spoken-language switching needs the vendor's `language_detection` tool enabled, which will then appear in `tools`. The client-minted session key arrived on every request. **Sentence release**: ElevenLabs hands a sentence to text-to-speech once its terminator is followed by whitespace and a later non-blank delta arrives (observed 2026-10-13). A zero-width-space delta alone did not release the bridge in the live run through the real backend (time-to-first-sentence 2.3 to 5.1 s against time-to-first-byte 1.3 to 1.6 s), because Radioso's pieces end on the terminator with no trailing whitespace; three stub variants confirmed the rule, and a space plus a zero-width space in one chunk released immediately (time-to-first-sentence equal to time-to-first-byte, measured twice). The `elevenlabs` dialect therefore sends `" \u200B"` after every sentence piece, bridge and fallback line, wire-only. **Minimum first-sentence length**: the same live replay through the stub showed the vendor also holds the first sentence until about 45 characters of text have arrived (26 characters held, 46 and 57 released; 60 invisible characters of padding and two short sentences did not count). Bridge lines must be full sentences of at least 45 characters; the docs say so. **Mechanics turns** ("Hello.", "Okay, thank you.") take 1.7 to 2.6 s whole-turn on the local stack with the mini model and 1.7 to 1.9 s with nano, so the model tier is not the lever; the planner emitting the reply itself in one call (the `quick_reply` lane) is what would bring them under the bridge threshold. The ElevenLabs account ran out of credits on 2026-10-13 after about 30 test sessions; further vendor runs need a top-up.
- ElevenLabs' custom-LLM contract from the docs: it posts OpenAI chat-completions to `{base}/v1/chat/completions` with `stream: true`, expects `data: {json}\n\n` chunks ending in `data: [DONE]\n\n`, passes custom fields in `elevenlabs_extra_body`, sends its system tools (`transfer_to_number`, `end_call`, `skip_turn`, `language_detection`) in the request's `tools`, and expects tool calls back in OpenAI shape. Barge-in signalling is undocumented; the vendor test must observe it.

## 1. Design discipline (answered before code)

The full contract is in [channel-contract.md](channel-contract.md). In short:

**Three layers.** A vendor-neutral voice domain (`backend/src/modules/voiceChannel/`) owns sessions, utterances, speakable replies, the turn policy (bridge, limit, interruption) and outcomes, and reads the agent's voice settings. Vendor adapters (`voiceChannel/adapters/*`) translate one wire protocol to the domain port and back; vendors that share a wire differ only by a data-only dialect. The chat service learns nothing except the `sourceChannel` literal and, in PR 4, a cancellation mode on the turn lease.

**Port.** `VoiceTurnPort.runTurn(VoiceTurnInput, AbortSignal): AsyncIterable<VoiceTurnEvent>` with events `bridge | speech | outcome | interrupted` and outcomes `continue | transfer | end | callback_requested`. Consumed ports, all existing: `AssistantChatService.streamAnswer`, the agent-channel grant middleware, the reply envelope's `ownership.state`. New and narrow: `VoiceSessionRepository` keyed `(agentId, vendor, sessionKey) → conversationId`, mirroring the email thread table.

**Dependency direction.** `adapter → voice domain → chat service`. Composition registers adapters. The domain never imports an adapter; nothing in the domain names a vendor.

**File count check.** PR 1 touches the domain (types, service, repository, migration), one adapter with two dialects, the source literal, composition wiring and a docs page: about eleven files plus tests. That is the price of the right boundary, paid once. Anything beyond it in PR 1 is a smell to stop on.

## 2. PR slices

| PR | Scope | Depends on | Tests |
|---|---|---|---|
| **1. Voice domain + completions adapter** | `sourceChannel: "voice"` (caller kind stays `human`); `channelContext` provider `voice`; migration + `VoiceSessionRepository`; `VoiceTurnPort` service: resolve session, run the chat turn, cut `chunk` text into sentence `speech` events, derive `continue`; the `openai-completions` adapter at `POST /api/v1/agents/:agentId/voice/:dialect/v1/chat/completions` behind the agent-channel grant, with `elevenlabs` and `generic` dialects as data (session key path, tool names); OpenAI `chat.completion.chunk` SSE out, `[DONE]`; not registered in OpenAPI, stated in the PR; `docs/voice-channel.md` describing the channel and the dialect table; Ray coverage-map exclusion line | nothing | service unit tests with a fake chat stream; adapter tests asserting exact SSE frames per dialect; repository integration test; supertest route test |
| **2. Turn policy: bridge and limit** | agent settings block `voice` (`enabled`, `bridgeLines`, `fallbackLine`); policy wrapper: no `speech` within 900 ms → `bridge` chosen by routine state and locale; no `speech` within 8 s → fallback `speech` then outcome; metrics `voice_turn_first_speech_ms`, `voice_bridge_emitted_total`, `voice_turn_limit_total`; Ray descriptor or exclusion for the block | PR 1 | policy tests with fake timers; settings round-trip test |
| **3. Outcomes: hand-off on web** | outcome derivation from `ownership.state` and the human-owned-at-start case for the `web` transport: `callback_requested` when contact details were captured, else `continue`, never the "a teammate is joining" line; the completions adapter finishes the stream cleanly on either. The `phone` rules, the `voice.transfer.target` setting and the `tool_calls` transfer frame stay in the contract and move to Phase 0 | PR 1 | derivation unit tests; route test for the operator-owned path |
| **4. Interruption and speculative turns** | a new utterance for a session whose turn is still in flight cancels that turn at once (the vendor does not abort the stream on barge-in); turn lease gains a cancellation mode that aborts after emission started, used only by voice; `interrupted` event with `heardUntil` derived from the replayed history's truncated reply; stored assistant message gets an `interrupted` marker with the delivered text; history render shows it. Speculative turns: a voice request the vendor aborts before any speech was produced leaves no persisted user message and no answer. Today the user message is persisted first; if no newer request follows, the aborted turn runs on under the 120 s disconnect ceiling and persists an answer, and if a newer request supersedes it before emission, `recordSupersession` leaves a cancelled event plus the stray user message | PR 1 | registry unit test for the new mode; streaming test that aborts mid-chunk and asserts the stored message; route test that aborts before first speech and asserts nothing persisted |

PRs 2 and 3 are independent of each other. PR 4 is the only one touching shared chat infrastructure and is sequenced last so the demo is never blocked on it. A second adapter (Twilio ConversationRelay, WebSocket) is Phase 0 work and proves the boundary; it is not needed for the booth.

## 3. Week plan

| Week | Engineering | Not code |
|---|---|---|
| **1 · 12 to 16 Oct** | contract reviewed Monday; PR 1 open by Wednesday, merged by Friday | ElevenLabs account on the EU region with zero retention; vendor test (section 4) on web voice against staging on Thursday, filling the `elevenlabs` dialect from observed field names; lead-capture routine drafted on the Radioso workspace agent |
| **2 · 19 to 23 Oct** | PR 2 and PR 3; first end-to-end web voice session by Wednesday | booth screen view (conversation, stages, trace, inbox); bridge lines authored in English and Italian |
| **3 · 26 to 30 Oct** | PR 4; latency tuning on the demo workspace (planner model tier, directive count, corpus size) | script in English and Italian; A-tier prospect crawls; fallback video |
| **4 · 2 to 6 Nov** | fixes only; freeze Friday | rehearsals in noise with headsets; failure drills; QR, signage with recording consent, hotspot, spare device |

## 4. Vendor test (one day, week 1)

Run against a staging agent with PR 1 deployed, or against a ten-line stub that returns a fixed streamed sentence if PR 1 is not ready.

Run on **web voice** (the vendor's browser widget or SDK on a test page, headset on). Telephony is not in scope for the demo.

1. Custom LLM URL and bearer secret accepted; first request arrives with `stream: true`, `tools`, and `elevenlabs_extra_body` carrying a session id. Record the exact field names for the dialect.
2. Time from end of speech to first audio with the stub returning instantly. This is the vendor's floor; everything above it is ours.
3. Interrupt the agent mid-sentence. Observe whether the HTTP stream is aborted, a new request arrives, or both. PR 4's design depends on this.
4. Confirm the first message, timeout prompts and goodbye can all be set to Radioso-authored text and that the vendor speaks nothing else.
5. Confirm `language_detection` keeps Italian and English both working in one session.
6. Confirm EU region and zero-retention settings are on and visible in the dashboard.
7. Measure the widget in a noisy room with a headset and with the tablet microphone; decide push-to-talk versus open microphone for the booth.

## 5. Decisions taken in this plan

- The channel is vendor-neutral from PR 1. ElevenLabs is a dialect of the completions adapter, selected by URL and configuration; nothing in the domain names it.
- Reuse `agent-api` grants for the demo. A dedicated `voice` grant channel (closed union in `accessGrants/domain.ts`, issuance UI from spec 1117) is Phase 0 work.
- Skip OpenAPI and SDK registration for the demo, following the agent-channel precedent. Register in Phase 0.
- Transfer target, bridge lines and fallback line are agent settings, not environment variables, so the demo workspace is configured in the dashboard like any agent. Bridge delay and turn limit are composition constants.
- The adapter contract lives in the module for the demo; promoting it into `packages/connector-api` beside `ConnectorPlugin` is a Phase 0 decision.
- Voice conversations count as end-user traffic in Audience Pulse automatically; nothing to do.

## 6. Decided on 2026-10-12

- The Radioso workspace (the radioso.ai website agent) hosts the demo agent. Its lead-capture routine is drafted in week 1 as ordinary agent setup.
- Telephony is not in the demo. Web voice is the only transport; the hand-off moment is the captured lead and the human-owned conversation on screen. The phone transport stays in the contract and can be switched on later without domain changes.
- The agent makes no early-access promise. It answers, captures contact details, and the team follows up.

Still open, both minor: how many A-tier prospect sites to pre-build, and the vendor budget cap.
