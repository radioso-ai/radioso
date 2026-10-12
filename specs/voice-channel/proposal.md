# Voice for Radioso — proposal

Status: revision 2, re-targeted at the Web Summit demo · Author: Claude (Fable 5.1) for Dmitri · Date: 2026-10-07
Companion files: [competitive-landscape.md](competitive-landscape.md) · [review-office-hours.md](review-office-hours.md) · [review-ceo.md](review-ceo.md)

## 1. The short version

**The goal is a booth demo that wins new customers at Web Summit Lisbon, 9 to 12 November 2026.** Code freeze is 6 November; the week-by-week plan and PR slices are in [plan.md](plan.md). Voice is not for an existing customer; it is the thing a visitor remembers after walking past two hundred stands. Revision 1's demand gate is gone. The architecture is unchanged, because the demo build has to become the product afterwards without being thrown away.

Radioso can offer voice without building a second brain. The split that works is **mouth vs. brain**, not **fast agent vs. slow agent**. A thin voice runtime owns the audio loop (hearing, deciding when the caller has finished, speaking, being interrupted). The existing Radioso agent stays the only thing that decides what to say, so every operator rule, routine, skill, hand-off and trace works in voice exactly as it does in chat.

What this proposal asks Dmitri to decide:

1. **Build the demo on the production architecture**: a vendor-neutral voice channel with a narrow port, and a streaming OpenAI-compatible adapter that most voice vendors can call. ElevenLabs Agents (EU region) is the first vendor configuration, not the shape of the channel. Nothing in the demo is a throwaway; the same channel is Phase 0 for real customers. Contract: [channel-contract.md](channel-contract.md).
2. **Make the demo show "answer, act, hand off" in one web voice session**: a grounded answer from documents, a routine that captures the visitor's contact as a lead, and a hand-off that turns the conversation human-owned on screen for the staffer to continue (a live phone transfer if telephony is switched on). The dashboard on the booth screen shows the turn stages, trace and inbox as it happens, which turns the 3 to 5 s wait into part of the show.
3. **Do not create a separate fast agent with its own judgment.** The fast lane lives inside the one agent. The faster planner is Phase 1 and does not fit before 9 November; the demo manages latency with authored bridge lines, a fast model tier on the demo workspace, and a rehearsed script.
4. **Keep the governance gates on voice.** The demo's pitch is governance. Speech cannot be taken back.
5. **Pre-build agents for the shortlist.** The Web Summit prospect sheet already scores 79 verified companies. Crawl the A-tier sites in advance so a prospect can talk to an agent that already knows their business.

The two reviews' technical findings stand and are in the plan: barge-in must cancel the running turn, a voice turn needs a time limit, the operator-owned rule must become a transfer, auth goes in a header, and transfer numbers come from configuration only. Their demand findings are superseded by the demo goal, and the full decision ledger in [review-ceo.md](review-ceo.md) is re-read in section 12.

## 2. The demo

**Dates and budget.** Web Summit Lisbon runs 9 to 12 November 2026 (opening night 9 November; main programme 10 to 12) at MEO Arena and FIL, Parque das Nações ([websummit.com](https://websummit.com/), [Lisbon Concierge guide](https://thelisbonconcierge.com/en/guide/web-summit)). Code freeze 6 November, which leaves 19 working days from 12 October.

**What a visitor experiences, in under three minutes.**

1. They tap "Talk" on the tablet with a headset, or scan a QR code that opens the voice page on their own phone. Web voice is the only transport for the demo; telephony stays in the contract for later.
2. The agent greets them in an authored line and they ask something in English or Italian. The agent answers from documents, in that language, with a short bridge line while it searches. The booth screen shows the stages (interpreting, searching, composing) and the sources it used.
3. They say they want to know more. The booking routine captures name, company and e-mail by voice, confirms, and the lead appears in the inbox on screen with the transcript.
4. They ask for a person. The agent captures their contact and hands off; the conversation turns human-owned on screen with the operator notice, and the staffer continues it.

**Which agent.** Two layers:

- **Flagship**: the radioso.ai website agent in the Radioso workspace, on the tablet and the voice page. It already answers about Radioso from the product docs, so it demonstrates the product with the product; its lead-capture routine doubles as the booth's sign-up form. Both are normal agent setup, not voice work.
- **Personalised**: pre-crawled agents for the A-tier companies in the prospect sheet, reachable by voice on the tablet. "We already built your agent; talk to it." Crawl and embed these the week before; some sites will block the crawler and are skipped.

**Why this demo sells Radioso rather than voice.** Every voice vendor at Web Summit will demo a fast talking agent. None will show the rules the operator wrote being obeyed, the sources behind each answer, a routine capturing structured data, and a human taking over, all on one screen. The voice is the hook; the screen is the pitch.

**Latency, honestly.** Without Phase 1, answers arrive 3 to 5 s after the visitor stops talking, with a bridge line heard at about 1.5 to 2 s. Three things make that acceptable at a stand: the authored bridge in the visitor's language, the live stage display on the screen, and a script whose turns are grounded questions and routine steps rather than small talk. The demo workspace runs the fastest planner-capable model, prompt caching, a small corpus and few directives.

## 3. Where the time goes today

Measured, not guessed. Sources: the turn pipeline map in this workspace, epic #856, spec 1263's benchmark, and a live Ananda turn traced today.

| Stage | What it is | Cost | Evidence |
|---|---|---|---|
| Prepare + metering | DB reads, usage reservation | tens of ms | `chatService.ts` prepare and `reserveAnswer` |
| **Fused turn planner** | one strict-JSON LLM call that routes, rewrites, picks language, ranks routines, matches directives | **p50 1.6 to 3.8 s**, 12 s timeout, serial, mandatory | `behaviorConfig.ts` `turnPlanning`; spec 102 |
| Routine step | second LLM call when a routine binds; asks and re-asks stream since v1.15.0 (#1443), endings and hand-offs are delivered whole | 1 to 3 s | `chatService.ts` routine attempt, `routineReplyDelivery.ts` |
| Retrieval | rewrite/intent LLM call, pgvector + lexical, optional rerank | 0.5 to 2 s | `retrievalPipelineStages.ts` |
| Composer | the answer LLM call, streamed | first token 1 to 2 s | `chatGateways.ts` |
| Two governance gates | text is held until the JSON head (coverage verdict) parses, and for grounded answers until the first sourced assertion closes | 0.3 to 1 s before the first visible word | `groundedAnswerHeadReader.ts`, `retrievalTurnSkill.ts` |

| Measure | Value | Source |
|---|---|---|
| Internal time-to-first-token target | 2.5 s | `perceivedPerformance.firstTokenTargetMs` |
| Benchmarked TTFT p50 / p95 (local, 20 turns) | 3.6 s / 4.2 s | spec 1263 validation |
| Live Ananda routine-activation turn today | about 4.5 s wall clock | test chat trace 10:56 UTC |
| Historical before the 2026 speed work | p50 14 s / p90 39 s | epic #856 |

Three structural facts matter more than any number:

- **The planner is a mandatory serial LLM round-trip before anything else starts.** It alone exceeds the whole voice budget.
- **The production streaming path does not run through the reusable conversation engine.** Issue #507 is closed as deferred. Routine streaming (#1443) landed on that path; voice rides it rather than adding another copy.
- **Interruption is not cancellation.** A newer message supersedes the running turn only if that turn has not started emitting. Once it streams, the next utterance waits for it to finish, and a disconnected request is aborted only after 120 s (`conversationTurnRegistry.ts`, `behaviorConfig.ts` `disconnectAbortCeilingMs`). On a phone that means the agent keeps talking over the caller and history stores words nobody heard.

## 4. What "good" sounds like

Human turn gaps are about 200 ms. The field has converged on these thresholds (landscape memo, section B):

| Gap after the caller stops | How it reads |
|---|---|
| under 300 ms | human |
| 300 to 500 ms | responsive |
| 500 ms to 1 s | noticed, tolerated |
| over 1 s with silence | flow breaks |
| over 1 s with a spoken bridge ("let me check that") | accepted, and universal among competitors |

Even the best stacks land at 500 to 800 ms end to end on trivial turns. **No vendor delivers grounded, multi-step, governed answers in under a second.** They all bridge. Intercom's Fin Voice runs a dedicated fast model next to its reasoning model; Sierra and Parloa document the same split and concede the routing hop costs hundreds of milliseconds.

The timing that matters is at the caller's ear, not inside Radioso. A bridge fired 900 ms after the transcript arrives is heard 1.5 to 2.3 s after the caller stops, once end-of-speech detection, transcription and the first speech audio are added.

## 5. The core design question: where to split

### The idea on the table: a fast voice agent and a slow main agent

A second agent on a fast model takes quick questions and defers long ones to the existing agent.

What it gets right: a fast model must carry the live microphone, and heavy work must happen behind a spoken bridge. This is the "talker-reasoner" pattern LiveKit and Google describe, and it is how Intercom and Sierra ship.

Where it breaks for Radioso:

- **Two brains, one persona.** The fast agent decides what is "quick" and answers it. The moment it says anything about the business ("yes, we are open Sundays") it answers from its prior, outside the documents, directives, Exact Words and never-lists the operator wrote. Radioso's position is "inside rules the operator authors".
- **Two conversation records.** Trace, inbox, quality signals and metering would all need to understand two authors.
- **Two things to configure.** Operators would keep a voice agent and a text agent consistent by hand.
- **The wrong axis.** "Fast vs. slow question" is itself a judgment that needs a model. "Audio vs. meaning" is a clean mechanical boundary.

### The split this proposal recommends: mouth vs. brain

| Layer | Owns | Knows nothing about |
|---|---|---|
| **Voice runtime (the mouth)** | microphone and speaker, voice activity detection, end-of-turn detection, speech-to-text, text-to-speech, barge-in, telephony, call recording, bridge timing | documents, directives, routines, skills, what the answer should be |
| **Radioso agent (the brain)** | everything it owns today, plus a voice interaction mode that changes how fast and in what shape it speaks | audio, phone numbers, voices, silence thresholds |

The fast lane lives inside the one brain, in two forms that need no second persona:

1. **Conversational mechanics answered by the planner itself** (Phase 1). The fused planner already runs once per turn. In voice mode it gets a `quick_reply` outcome for greetings, confirmations, "can you repeat that", slot answers and goodbyes, and emits the words in the same call. Precondition: the planner on a faster model with prompt caching measures under about 800 ms p50. If it does not, this lane does not exist and the proposal says so.
2. **A bridge sentence chosen without a model.** If the planner has not returned within about 900 ms, the door emits one short bridge line in the conversation's language. Lines are operator-authored per language, like Exact Words, with an LLM-drafted default offered at setup. The style is chosen from conversation state, which costs nothing: inside a routine the bridge is an acknowledgement ("Okay."), outside one it is a check ("Let me look that up."). This avoids "let me check" before every slot answer on a booking call, which the office-hours review flagged as the most common turn.

Speech-to-speech models (gpt-realtime, Gemini Live) are faster and cheaper on paper and are the wrong mouth for Radioso: they paraphrase tool results. Exact Words (spec 1150), directive adherence and sourced phrasing depend on the brain's text reaching the speaker verbatim. A cascade (speech-to-text, Radioso, text-to-speech) preserves governance. Revisit if a speech-to-speech model gains a reliable verbatim mode.

**The governance gates stay on voice.** The CEO review is right that the coverage-verdict gate enforces the out-of-scope outcome and the grounding gate holds back prose with no source yet. Both matter more when the words cannot be retracted. The verdict head costs little because the model writes it before the answer anyway.

## 6. Proposed architecture

```
 caller (phone; browser mic later)
         |  audio
         v
 +----------------------------+     voice door (new, streaming)        +----------------------------+
 | Voice runtime ("mouth")    |  OpenAI-compatible chat completions    | Radioso backend            |
 |  Demo+P0: ElevenLabs EU    |  (HTTP stream; WebSocket variant for   |  voice session mapper      |
 |  Phase 2: own worker       |  Retell / Twilio ConversationRelay)    |  chat service, voice mode  |
 |  STT · VAD · TTS · barge-in|  ---> newest utterance + call id       |  bridge timer              |
 +----------------------------+  <--- text deltas; bridge first;       |  existing: planner,        |
                                       tool_call request_callback /    |  retrieval, routines,      |
                                       transfer_call on hand-off       |  skills, directives,       |
                                                                       |  gates, trace, metering,   |
                                                                       |  inbox                     |
                                                                       +----------------------------+
```

### 6.1 The voice door (backend, new first-class channel)

A vendor-neutral voice domain with a narrow port, and vendor adapters that bind it to a wire; the contract is in [channel-contract.md](channel-contract.md). Conversations are registered as `sourceChannel: "voice"`, `callerKind: "human"`. The first adapter speaks the OpenAI chat-completions wire format because most voice stacks (ElevenLabs, Vapi, LiveKit, Pipecat, Deepgram) call that shape, with per-vendor field and tool names as data-only dialects; Retell and Twilio ConversationRelay get WebSocket adapters over the same port later.

- **Auth**: bearer header carrying a voice-scoped access grant. Never a token in the URL path.
- **Identity**: the vendor's call id maps to one Radioso conversation, scoped to the grant so a call id cannot be guessed into another workspace. Only the newest user message is used; Radioso stays the system of record and ignores the vendor's replayed history. Caller number arrives as a context variable, so routines stop asking callers to spell what the line already knows.
- **Streaming**: `chat.completion.chunk` deltas from the existing SSE chunk source. The bridge line, when the timer fires, is the first delta.
- **Hand-off**: a routine `handoff` ending, re-ask exhaustion, or `handoffOnRetrievalMiss` becomes an OpenAI-style `tool_call`. The demo ships `transfer_call` to the booth phone, and **the transfer number comes only from configuration, never from the model**, or callers can redirect transfers (toll fraud). `request_callback` through the existing contact-request path follows in Phase 0 for customers with closing hours.
- **Barge-in**: in voice mode the newest utterance wins. The vendor aborts the stream, the door cancels the running turn immediately even after emission has started, and history stores the answer as the caller heard it (truncated and marked interrupted). This is new behaviour; today's registry latch would make the caller wait.
- **Turn time limit**: a voice turn that has not produced words within about 8 s speaks a fixed fallback and ends in a callback request, instead of the 12 s planner timeout followed by four fallback LLM calls in silence.
- **Operator-owned conversation**: when an operator has taken the conversation over, the voice turn becomes a transfer or callback. The chat behaviour of writing "a teammate is joining" on every utterance would loop on a phone.
- **Metering**: `reserveAnswer` with `surface: "voice"` on every turn, as today. Minutes are capped at the vendor for the demo and Phase 0; a Radioso minute counter and plan quota come with pricing in Phase 1.
- **Vendor-written words**: the vendor speaks only what Radioso sends. Greeting, fillers, timeout prompts and goodbyes are configured to Radioso-supplied text, and the setup doc has a checklist for it.

This is deliberately **not** a `ConnectorPlugin`: that port's `answer()` is a blocking full-turn call, which would force "wait for the whole answer, then speak".

### 6.2 Voice interaction mode (backend, inside the existing turn)

A per-turn `interactionMode: "voice"` carried from the door into the chat service. It changes latency policy and output shape, never meaning.

| Change | Why | Phase |
|---|---|---|
| Bridge timer and state-chosen bridge style | spoken silence over 1 s breaks the call | demo |
| Cancel-on-abort and interrupted-answer storage | barge-in truth in history | demo |
| Turn time limit with spoken fallback | no silent 12 s paths | demo |
| Planner on the fastest configured model with prompt caching, `quick_reply` outcome | the planner is the serial bottleneck; mechanics should not pay a second call | 1, gated on <800 ms |
| Sentence-level flush to the stream | text-to-speech needs sentence boundaries | 1 |
| Stream routine replies | the demo's lead-capture steps are routine turns | shipped (#1443); voice consumes it |
| Speculative pre-warm on interim transcripts | starts the planner while the caller finishes | 2, own runtime only |

Routine streaming shipped in v1.15.0 (#1443). The voice door consumes the same chunk stream, so it inherits that work and must not fork a separate streaming path. The engine question (#507) stays with the chat streaming path, not with voice.

### 6.3 Governance on voice

- **Steering spoken answers.** Directives need a channel scope (voice, and the same mechanism email needs) rather than a new `voice` surface. Operators then say: no lists, no URLs read aloud, spell out e-mail addresses, one idea per sentence, offer to text a link. Design in Phase 1 together with the email channel.
- **Exact Words** are spoken verbatim because the cascade reads the brain's text.
- **Hand-off policy**: warm transfer to a configured phone (demo), callback outside hours (Phase 0). The transcript lands in the inbox with a channel label like any conversation. Operators typing into a live call is not a goal.
- **Voice persona settings** (voice id, languages, speaking rate, bridge lines, transfer number, hours) are agent data the backend stores and hands to the runtime; the backend never talks to a speech provider.
- **Privacy.** Recordings and transcripts are document-grade sensitive data: retention setting, no audio in logs, trace carries durations and stage names and never speech. Phase 0 leaves recordings with the vendor under zero-retention settings.
- **Ray.** The voice door and persona settings are operator-facing, so they ship a copilot tool descriptor or a stated coverage-map exclusion in the same change.

### 6.4 The runtime (demo and Phase 0 managed, Phase 2 owned)

- **Demo and Phase 0:** ElevenLabs Agents configured to call the voice door as its custom LLM. Reasons: real EU data-residency regions and zero-retention mode, native SIP and a web widget in one product, and its May 2026 price cuts. One day of vendor testing comes first: confirm its custom-LLM contract, that it speaks nothing it was not sent, and how it signals barge-in. Vapi and Retell work with the same door but run on US infrastructure under contracts only. Twilio ConversationRelay fits a phone-only partner who wants Twilio's EU residency, at the cost of the WebSocket adapter.
- **Phase 2:** a Radioso-owned voice worker (LiveKit Agents has a Node SDK; Pipecat is Python), deployed like the document worker, with speech providers pluggable behind the worker's own ports. This is what makes voice available to self-hosted installs and EU-only tenants without a vendor in the audio path.

## 7. Plan to 9 November, then phases

### 7.1 Four weeks to the booth

Detailed PR slices and the vendor test are in [plan.md](plan.md).

| Week | Dates | Build | Demo and booth |
|---|---|---|---|
| 1 | 12 to 16 Oct | PR 1 voice domain and completions adapter; one-day vendor test on web voice | ElevenLabs EU account; lead-capture routine drafted on the Radioso workspace agent |
| 2 | 19 to 23 Oct | PR 2 bridge lines (English, Italian) and 8 s turn limit; PR 3 outcomes: hand-off becomes captured lead plus human-owned conversation | first end-to-end web voice session; booth screen view (conversation, stages, trace, inbox) |
| 3 | 26 to 30 Oct | PR 4 barge-in with interrupted-answer storage; latency tuning on the demo workspace (planner model tier, directive count, corpus size) | demo script in English and Italian; pre-crawl A-tier prospect sites; record the fallback video |
| 4 | 2 to 6 Nov | fixes only; code freeze 6 Nov | rehearsals in noise with handset and headset; failure drills (venue Wi-Fi down, vendor outage, planner timeout); QR codes, signage with recording consent, leave-behind one-pager; mobile hotspot |
| show | 9 to 12 Nov | — | two devices live, one spare, headsets; leads land in the inbox |

Rough effort: about 3 engineering weeks for the build plus a week of demo production. This is the revision 1 Phase 0 scope with `transfer_call` moved in and the metering, pricing and persona-settings work moved out.

### 7.2 Not in the demo, on purpose

Per-minute metering and pricing, voice persona settings in the dashboard, the faster planner and `quick_reply`, sentence flush, the directive channel scope, recordings in Radioso, and any self-hosted runtime. Routine streaming already shipped (#1443) and voice consumes it. The vendor's minute cap and zero-retention mode cover the booth. The agent makes no availability promise; it captures contact details and the team follows up.

### 7.3 After Web Summit

| Phase | Entry criterion | Scope | Effort (rough) |
|---|---|---|---|
| **0 — First customer line** | a Web Summit lead wants voice on a real number | the demo door hardened: `request_callback` outside hours, `surface: voice` metering, minute counter, vendor-side cap, docs | 1 to 2 weeks |
| **1 — Sound right** | a paying voice workspace | planner fast tier with `quick_reply` (keep only if under 800 ms p50), sentence flush, directive channel scope, voice persona settings, per-minute price in the plan catalog, voice eval cases | 4 to 5 weeks |
| **2 — Own it** | a second paying workspace, or an EU-only tenant refuses a vendor in the audio path | Radioso voice worker, WebRTC embed voice button, SIP numbers, interim-transcript pre-warm, recordings and retention, per-minute plan quotas | 8 to 10 weeks |
| **3 — Polish** | Phase 2 live | outbound calls from routines, semantic end-of-turn detection, operator listen-in, voice analytics | ongoing |

## 8. Connectivity to the existing landscape

| Existing piece | What changes | Risk |
|---|---|---|
| Public chat and agent-channel doors (`publicChatRoutes.ts`, `agentChannelChatRoute.ts`) | a sibling voice door; shares auth-by-grant, session preparer, SSE chunk source | third copy of bespoke route wiring; extract a shared streaming-door helper first |
| `conversationSource.ts` | add `voice`; `callerKind` stays `human` | low |
| `ConversationChannelContext` (closed union `slack` / `web`) | add a `voice` variant with call id and transport; engine stays transport-agnostic | contract change; message-queue review |
| Conversation engine input (one complete message) | unchanged; pre-warm is a chat-service port, not an engine concept | keeps the engine pure |
| Streaming path vs. engine (#507 closed as deferred) | decision required in Phase 1: engine path recommended | medium |
| Turn registry and disconnect ceiling | voice mode cancels on abort even after emission; interrupted answers stored truthfully | medium; new behaviour with tests |
| Fused planner (spec 102) | fast tier, `quick_reply`, caching (spec 1262) | prompt and schema change; eval coverage |
| Governance gates | unchanged | none |
| Routine runner | step-reply streaming shipped (#1443); voice consumes it | low for voice |
| Directives | channel scope shared with email | small, additive |
| Agent settings and publish | voice persona settings, bridge lines per language | new revision field; migration |
| Hand-off / inbox | `transfer_call` now, `request_callback` in Phase 0; transcripts labelled | low |
| Metering (`reserveAnswer`, usage limits, EE plan catalog) | `surface: voice` now; minute counter and quota with pricing | billing change |
| Provider registry (`chat`/`rewrite`/`rerank`/`embeddings`) | unchanged; speech providers live in the runtime | none |
| OpenAPI, TypeScript SDK snapshot, MCP | door documented; snapshot regenerated; MCP unaffected | routine |
| Ray | tool descriptor or coverage-map exclusion | required |
| Docs | `docs/voice-channel.md`, vendor setup guide, readme channel list | required |
| Observability | per-call trace linking utterance turns; metrics: time-to-first-audio, bridge rate, barge-ins, turn-limit hits, callback rate; nothing spoken in logs | required |

## 9. Constraints and risks

- **Sub-second grounded answers are not achievable**, here or anywhere. The proposal bridges. If the bar is "no bridge ever", the product is a pre-computed answer cache for frequent questions, which is a different decision.
- **Routine turns are the slowest and the demo leans on them.** The lead-capture steps run the routine LLM call, so each slot answer takes 3 to 5 s before the first word today. If the in-progress routine streaming lands before the freeze, speech starts at the first sentence instead. The acknowledgement-style bridge softens it either way. Keep the routine to three slots.
- **Bridge misfires** on slow trivial turns. Tracked as a metric; `quick_reply` shrinks it.
- **First-turn language** comes from speech-to-text detection or the agent's default locale.
- **Vendor paraphrase** if a speech-to-speech mouth is ever used. Cascade only.
- **Silence paths**: planner timeout and fallbacks, operator-owned loop. Closed by the turn limit and the operator-owned rule in 6.1.
- **Security**: grant in a header, call id scoped to the grant, transfer number from config only, prompt injection via transcript treated like any visitor message.
- **EU residency**: ElevenLabs has EU regions; OpenAI Realtime's EU endpoint excludes tracing; Vapi and Retell are US-hosted. Phase 2 removes the dependency.
- **Cloud Run**: long-lived sockets and UDP media do not belong in the API service; the Phase 2 worker is a separate service, and Phase 0's HTTP-per-utterance shape needs no sticky connections.
- **Operational surface**: numbers, carriers and recordings are new obligations; the demo and Phase 0 leave them with the vendor on purpose.

Demo-specific risks:

- **Hall noise.** Open microphones on a tablet will mis-hear in an exhibition hall. A headset and push-to-talk are mandatory at the stand.
- **Venue network.** The tablet, the voice page and the booth screen ride a mobile hotspot, never venue Wi-Fi. A recorded fallback video covers a vendor or network outage.
- **Expectation setting.** A visitor who hears voice assumes it ships. The agent promises nothing; the staffer sets expectations in person, and the captured contact is the follow-up.
- **Consent.** Visitors' voices pass through a vendor. Zero-retention mode, EU region, and a consent notice at the stand.
- **Latency on stage.** A 4 s silence at a booth feels like failure. The authored bridge, the live stage display and a rehearsed script are the mitigations; small talk is kept out of the script because the planner is slowest on it.

## 10. Costs and unit economics

| Option | $/min |
|---|---|
| Cascade, budget tier (streaming STT + mini LLM + fast TTS) | 0.05 to 0.12 |
| Cascade, production tier | 0.15 to 0.30 |
| Managed platform all-in (Vapi, Retell, Bland) | 0.11 to 0.33 |
| ElevenLabs Agents (STT + TTS) plus Radioso's own LLM cost | about 0.08 plus LLM |
| Speech-to-speech (gpt-realtime / Gemini Live) | 0.02 to 0.15 |

The plan catalog prices Satellite at €149 for 1,000 conversations a month, about €0.15 per conversation. A four-minute call costs roughly $0.40 to $0.80 in vendor fees plus 6 to 10 turns of LLM cost. **Every call loses money under conversation pricing.** A per-minute line in the plan catalog is a gate for general availability, not a Phase 2 nicety. The demo runs on Radioso's own vendor account with a hard cap; a few hundred euros covers the build and four show days.

## 11. What the reviews changed, and what the demo goal changed back

Both reviews are in the companion files and were written against revision 1, which assumed a customer pull.

Kept from the reviews:

- **The gates stay.** The draft skipped them in voice mode; the CEO review showed they are governance, not formatting.
- **Barge-in, turn limit, operator-owned rule, header auth, config-only transfer numbers, the no-vendor-words checklist.** All in the week 2 build.
- **Honest numbers.** Bridge heard at 1.5 to 2 s, answers at 3 to 5 s; the planner lane is conditional on measuring under 800 ms and is not in the demo.
- **Pricing is a gate for general availability**, with the Satellite arithmetic above. Not a gate for the demo.
- **#507 is decided by the routine-streaming workstream**, not by voice; voice rides its result.

Superseded by the demo goal:

- **The demand gate and the call log.** Voice is a positioning bet for Web Summit, so the measure of success is leads at the stand, not after-hours call volume.
- **Ananda as design partner and the after-hours shape.** The flagship agent is Radioso about Radioso; personalised agents come from the prospect sheet.
- **`request_callback` before `transfer_call`.** The demo's best moment is the live transfer, so `transfer_call` is in and callback waits for Phase 0.

## 12. Open decisions for Dmitri

1. **Pre-built prospect agents**: how many A-tier sites to crawl, and whether to tell those companies in advance.
2. **Vendor account and budget.** ElevenLabs EU on Radioso's account; a few hundred euros covers the build and four show days.

Decided on 2026-10-12: the Radioso workspace's website agent is the demo agent; telephony is not in the demo (the phone transport stays in the contract); the agent makes no early-access promise.

Decided on 2026-10-07: the demo agent's documents, persona and routines are ordinary agent setup and not a voice decision. Demo languages are **English and Italian**. Bridge lines, the script and rehearsals cover those two; the planner already picks the response language, so other languages work unrehearsed but are not promised at the stand. Routine streaming shipped in v1.15.0 (#1443) and is not a voice deliverable.

The CEO ledger's D1 to D16 map onto these: D1 and D2 are decided by the demo goal, D5 (ElevenLabs EU after a one-day test), D8 (keep the gates), D10 (newest utterance wins), D14 (bearer header) are recommended as written, and D7, D9, D13, D16 move to Phase 1.

## 13. Competitive summary

Full memo: [competitive-landscape.md](competitive-landscape.md).

- Every support-agent platform with voice (Intercom Fin Voice, Sierra, Decagon via ElevenLabs, PolyAI, Parloa, Cognigy, Zendesk) optimises time-to-first-audio and bridges the rest with context-aware fillers. None delivers governed, grounded answers in under a second.
- Multi-model architectures (Intercom's fast model, Parloa's subtask agents, Cresta's task models) exist, and their own engineering posts concede the routing hop costs hundreds of milliseconds.
- Infrastructure splits into cascades (Vapi, Retell, Bland, ElevenLabs, Deepgram, LiveKit, Pipecat, Twilio ConversationRelay) and speech-to-speech (gpt-realtime, Gemini Live, Nova Sonic, Azure Voice Live). Most cascades accept a custom LLM through an OpenAI-compatible endpoint; Retell and ConversationRelay use WebSockets.
- Funding says the category is real: Sierra at 15.8B, ElevenLabs at 11B, Decagon at 4.5B in 2026 rounds. Buyers are phone-first and B2B.
- Radioso's differentiation on voice is the same as in chat: the operator's rules, documents, routines and hand-off apply unchanged, and the brain is open and self-hostable. No vendor in the memo offers a governed, self-hostable brain behind a bring-your-own mouth.

## 14. Evidence appendix

- Turn pipeline map (this workspace, 2026-10-07): planner `behaviorConfig.ts:99-145`; status stages `streamEvents.ts:14`; routine replies committed whole `chatService.ts:1483-1486`; gates `groundedAnswerHeadReader.ts:51-95`, `retrievalTurnSkill.ts:579-648`; SSE presenter `chatPresenter.ts:109-180`; MCP ask non-streaming `agentConverseService.ts:106-110`; connector port blocking `connectorChatPort.ts:24-40`; channel union `packages/conversation-contract/index.d.ts:95-106`; engine bypass note `turnSkillSelector.ts:88-95`; metering `chatService.ts:1364-1373`; provider capabilities `providerTypes.ts:9`; supersede-only-before-emission `conversationTurnRegistry.ts:146-152`; disconnect ceiling `behaviorConfig.ts:218`.
- Epic #856: historical p50 14 s / p90 39 s; #857, #858, #859, #868, #871 shipped. Issue #507 closed as deferred 2026-06-01.
- Spec 1263 validation: TTFT p50 3,569 ms / p95 4,183 ms baseline, 20-turn local benchmark.
- Live Ananda test turn 2026-10-07 10:56 UTC: routine "Book accommodation" auto-picked at 0.92, about 4.5 s wall clock.
- Ananda workspace: two agents (EN, IT) on `gpt-5.4-mini`, 11,556 embedded chunks, 30 most recent conversations all `website_embed`, Italian majority, dominated by course dates, availability and booking.
- Plan catalog: Satellite `priceCents: 14900`, `monthlyConversations: 1000`.
- No audio, speech, telephony or WebSocket-realtime code exists anywhere in the repository.
