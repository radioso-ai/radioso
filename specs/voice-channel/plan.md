# Voice for Web Summit — first steps

Date: 2026-10-12 · Freeze: 6 November · 19 working days left · Companion: [proposal.md](proposal.md)

## 0. What changed since the proposal

- `origin/main` merged. Routine streaming shipped in v1.15.0 (#1443): routine steps that ask or re-ask stream as `chunk` events; durable endings (every hand-off, every routine ending, actions, approvals) are persisted first and delivered whole. Prompt caching shipped (#1484). Both are free latency wins for voice.
- The REST agent-channel door (`POST /api/v1/agents/:agentId/chat`) is already excluded from OpenAPI, so a voice door can follow that precedent and skip the SDK snapshot for the demo. That is a choice to state in the PR, not an accident.
- ElevenLabs' custom-LLM contract is confirmed: it posts OpenAI chat-completions to `{base}/v1/chat/completions` with `stream: true`, expects `data: {json}\n\n` chunks ending in `data: [DONE]\n\n`, passes custom fields in `elevenlabs_extra_body`, sends its system tools (`transfer_to_number`, `end_call`, `skip_turn`, `language_detection`) in the request's `tools`, and expects tool calls back in OpenAI shape. Barge-in signalling is undocumented; the vendor test must observe it.

## 1. Design discipline (answered before code)

The full contract is in [channel-contract.md](channel-contract.md). In short:

**Three layers.** A vendor-neutral voice domain (`backend/src/modules/voiceChannel/`) owns sessions, utterances, speakable replies, the turn policy (bridge, limit, interruption), outcomes, and the agent's voice settings. Vendor adapters (`voiceChannel/adapters/*`) translate one wire protocol to the domain port and back; vendors that share a wire differ only by a data-only dialect. The chat service learns nothing except the `sourceChannel` literal and, in PR 4, a cancellation mode on the turn lease.

**Port.** `VoiceTurnPort.runTurn(VoiceTurnInput, AbortSignal): AsyncIterable<VoiceTurnEvent>` with events `bridge | speech | outcome | interrupted` and outcomes `continue | transfer | end | callback_requested`. Consumed ports, all existing: `AssistantChatService.streamAnswer`, the agent-channel grant middleware, the reply envelope's `ownership.state`. New and narrow: `VoiceSessionRepository` keyed `(agentId, vendor, sessionKey) → conversationId`, mirroring the email thread table.

**Dependency direction.** `adapter → voice domain → chat service`. Composition registers adapters. The domain never imports an adapter; nothing in the domain names a vendor.

**File count check.** PR 1 touches the domain (types, service, repository, migration), one adapter with two dialects, the source literal, composition wiring and a docs page: about eleven files plus tests. That is the price of the right boundary, paid once. Anything beyond it in PR 1 is a smell to stop on.

## 2. PR slices

| PR | Scope | Depends on | Tests |
|---|---|---|---|
| **1. Voice domain + completions adapter** | `sourceChannel: "voice"` (caller kind stays `human`); `channelContext` provider `voice`; migration + `VoiceSessionRepository`; `VoiceTurnPort` service: resolve session, run the chat turn, cut `chunk` text into sentence `speech` events, derive `continue`; the `openai-completions` adapter at `POST /api/v1/agents/:agentId/voice/:dialect/v1/chat/completions` behind the agent-channel grant, with `elevenlabs` and `generic` dialects as data (session key path, tool names); OpenAI `chat.completion.chunk` SSE out, `[DONE]`; not registered in OpenAPI, stated in the PR; `docs/voice-channel.md` describing the channel and the dialect table; Ray coverage-map exclusion line | nothing | service unit tests with a fake chat stream; adapter tests asserting exact SSE frames per dialect; repository integration test; supertest route test |
| **2. Turn policy: bridge and limit** | agent settings block `voice` (`enabled`, `bridgeLines`, `fallbackLine`); policy wrapper: no `speech` within 900 ms → `bridge` chosen by routine state and locale; no `speech` within 8 s → fallback `speech` then outcome; metrics `voice_turn_first_speech_ms`, `voice_bridge_emitted_total`, `voice_turn_limit_total`; Ray descriptor or exclusion for the block | PR 1 | policy tests with fake timers; settings round-trip test |
| **3. Outcomes: hand-off on web** | outcome derivation from `ownership.state` and the human-owned-at-start case for the `web` transport: `callback_requested` when contact details were captured, else `continue`, never the "a teammate is joining" line; the completions adapter finishes the stream cleanly on either. The `phone` rules, the `voice.transfer.target` setting and the `tool_calls` transfer frame stay in the contract and move to Phase 0 | PR 1 | derivation unit tests; route test for the operator-owned path |
| **4. Interruption** | `interruptsPrevious` and abort cancel the in-flight turn at once; turn lease gains a cancellation mode that aborts after emission started, used only by voice; `interrupted` event with `heardUntil` when the adapter supplies it; stored assistant message gets an `interrupted` marker with the delivered text; history render shows it | PR 1 | registry unit test for the new mode; streaming test that aborts mid-chunk and asserts the stored message |

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
