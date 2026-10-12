# CEO review: Voice for Radioso

Date: 2026-10-07 · Reviewer: Claude (Opus 5.5) running gstack `/plan-ceo-review`, non-interactive · **Mode: SCOPE REDUCTION**

Subject: [proposal.md](proposal.md), read with [competitive-landscape.md](competitive-landscape.md). The founder could not answer questions during this run. Every question became a ledger line marked PENDING with a recommendation.

The proposal links `review-office-hours.md`. That file does not exist in `specs/voice-channel/` at review time.

Code claims below were checked with narrow reads. Where a claim was not checked, the text says so.

---

## 1. Decision ledger

| ID | Decision | Options | Recommended | Status | Why |
|---|---|---|---|---|---|
| D1 | Go or no-go on Phase 0 | (a) start now; (b) start only after a partner commits in writing; (c) shelve | (b) | PENDING (founder) | No issue, spec, or customer quote asks for voice. A written partner commitment is the cheapest demand proof. |
| D2 | Design partner | (a) Ananda after-hours line; (b) another customer; (c) internal test line only | (a), if Ananda agrees | PENDING (founder) | Ananda routes booking to "the reception" and is phone-shaped. Its willingness is unknown. |
| D3 | Phone or browser first | (a) phone; (b) embed microphone; (c) both | (a) | PENDING (founder) | Buyers are phone-first. The embed adds WebRTC and browser work Phase 0 avoids. |
| D4 | Who owns the vendor account in Phase 0 | (a) partner-owned, Radioso does the setup; (b) Radioso-owned with a vendor spend cap | (a); (b) as fallback | PENDING (founder) | (a) removes Radioso's per-minute exposure and defers the minute counter. (b) needs a hard cap before any real number. |
| D5 | First vendor | (a) ElevenLabs Agents, EU region; (b) Twilio ConversationRelay; (c) Vapi or Retell | (a), after a one-day spike | PENDING (founder) | Only vendor in the memo with real EU regions plus native SIP. The spike verifies call-id passing, timeouts, retries, and transfer semantics. |
| D6 | Phase 0 success criteria | (a) set kill and continue lines now; (b) judge afterwards | (a) | PENDING (founder) | Without a kill line, Phase 1 starts by momentum. Suggested measures: real calls per week, calls resolved without transfer, hang-ups during bridged turns, partner willingness to pay. The numbers are the founder's call. |
| D7 | Bridge phrase source in Phase 0 | (a) publish-time LLM generation per revision; (b) LLM-drafted, operator-reviewed phrase set in voice config; (c) vendor-side filler | (b) | PENDING (founder) | Same governance as (a) without a revision migration or a new publish failure mode. (c) puts copy outside Radioso's trace. |
| D8 | Text gates in voice mode | (a) bypass as proposed; (b) keep both gates | (b) | PENDING (founder) | The gates enforce the coverage verdict and hold unsourced prose. Speech cannot be retracted. |
| D9 | How operators steer voice answers | (a) new generation surface `voice`; (b) a channel-scope axis on directives | (b), in Phase 1 | PENDING (founder) | `GenerationSurface` names model calls (`answer`, `suggested_questions`), not channels. The email channel (#1403) needs the same axis. |
| D10 | Barge-in semantics | (a) today's behaviour: the turn finishes, the next one waits; (b) voice cancels on disconnect and supersedes after emission | (b), in Phase 0 | PENDING (founder) | Today an interrupted answer keeps running for up to 120 s and blocks the next turn. |
| D11 | Hand-off policy | (a) transfer in hours, callback outside; (b) callback only; (c) transfer only | (a) | PENDING (founder) | Matches the proposal. Choose (b) if the reception cannot take live transfers. |
| D12 | Operator claims a live voice conversation | (a) the claim triggers transfer or callback; (b) claiming is blocked while the call is live | (a) | PENDING (founder) | Today a human-owned turn speaks a generated "waiting" message on every utterance. On a phone that is a loop. |
| D13 | Where Phase 1 voice-mode code lives | (a) in the streaming shortcut; (b) `interactionMode` in the conversation contract, routine streaming via #507 | (b) | PENDING (founder) | (a) deepens the duplicated path that #507 exists to remove. |
| D14 | Voice door authentication | (a) token in the URL path; (b) bearer header using an access grant with a voice scope | (b) | PENDING (founder) | Path tokens leak into request logs and vendor dashboards. OpenAI-compatible clients already send a bearer key. |
| D15 | Managed vendor in the audio path for the EU-first cloud | (a) acceptable for Phase 0 with EU region and DPA; (b) build Phase 2 first | (a) | PENDING (founder) | Phase 2 is 8 to 10 weeks with no proven demand. |
| D16 | Voice pricing | (a) per-minute add-on; (b) bundled minutes; (c) decide after Phase 0 | (c) | PENDING (founder) | Cost per call is not measured yet. Phase 0 is free to the partner. |

---

## 2. CEO scope summary

### Vision (10x check)

The 10x idea is not "Radioso has voice". It is "one governed agent, every channel, rules written once". Voice is the hardest test of that claim: no retraction, no citations, a live hand-off. The mouth versus brain split is the right foundation, and it rejects the two-brain design for the right reasons. The 10x levers are a faster planner, which helps every channel, and a channel-scope axis on directives, which serves voice and email. An owned audio runtime is parity infrastructure, not differentiation. The proposal passes the 10x check on architecture. It fails it on demand evidence.

### Scope decisions

| # | Proposal item | Effort | Recommendation | Reasoning |
|---|---|---|---|---|
| 1 | Voice door, OpenAI-compatible stream | M | ACCEPTED | Build as a sibling of the agent-channel route, with bearer grant auth (D14). |
| 2 | Call id to conversation mapping | S | ACCEPTED | Scope the key to the grant; expire after the call. |
| 3 | `transfer_call` / `request_callback` on hand-off | S | ACCEPTED | Destination fixed in vendor config, never in model output. |
| 4 | `sourceChannel: voice` plus contract variant | S | ACCEPTED | Needed for inbox, metering, trace. Contract review applies. |
| 5 | Latency-triggered bridge | S | ACCEPTED | A timer in the door presenter. Chat service untouched. |
| 6 | Publish-time bridge phrases | M | DEFERRED | An LLM-drafted, operator-reviewed set is enough for one partner (D7). |
| 7 | Per-minute usage counter | M | DEFERRED | The partner-owned vendor account carries minutes (D4). |
| 8 | Vendor setup docs | S | ACCEPTED | Docs are product surface. |
| 9 | Barge-in cancel and supersede (added) | M | ACCEPTED | Today the interrupted turn runs on and blocks the next. |
| 10 | Voice turn ceiling (added) | S | ACCEPTED | Planner times out at 12 s, then runs staged fallbacks. |
| 11 | Operator-owned turn mapping (added) | S | ACCEPTED | Replaces a repeating "waiting" message with transfer or callback. |
| 12 | Planner fast model plus `quick_reply` | L | DEFERRED | Phase 1, only if Phase 0 shows callers stay. |
| 13 | Sentence-level flush | S | DEFERRED | Verify first whether the vendor already buffers to sentences. |
| 14 | Skip the two text-only gates | S | SKIPPED | They are governance gates (D8). |
| 15 | Stream routine replies | M | DEFERRED | Build in the engine path with #507 (D13). |
| 16 | Directive surface `voice` | S | SKIPPED | Replace with a channel-scope axis in Phase 1 (D9). |
| 17 | Voice persona settings | M | DEFERRED | The vendor holds voice and rate; Radioso holds hours and phrases only. |
| 18 | Voice eval cases | M | DEFERRED | Land with the planner schema change. |
| 19 | Call transcripts in the inbox | S | ACCEPTED | Already conversations; add a channel label. |
| 20 | Own voice worker, WebRTC button, SIP, pre-warm | XL | DEFERRED | Only when an EU-only or self-hosted buyer asks. |
| 21 | Recordings and retention in Radioso | M | DEFERRED | Vendor zero-retention mode covers Phase 0. |
| 22 | Per-minute plan quotas | M | DEFERRED | After cost per call is measured (D16). |
| 23 | Phase 3: outbound calls, semantic end of turn, listen-in, voice analytics | XL | DEFERRED | Outbound needs consent and toll-fraud controls first. |

### Accepted scope (reduced Phase 0)

- One phone line for one partner, reaching the existing agent through a managed EU vendor.
- A voice door: OpenAI-compatible streaming, bearer grant auth, call id mapped per grant.
- A bridge phrase fired from the door after a configurable delay, from an operator-reviewed set.
- Hand-off as `transfer_call` in hours and `request_callback` outside, including operator-owned turns.
- Voice cancellation: abort on disconnect, supersede after emission, mark the interrupted answer.
- A voice turn ceiling that ends in a hand-off, never in silence.
- `sourceChannel: voice`, a `voice` channel-context variant, an inbox channel label.
- OpenAPI entry, SDK snapshot sync, `docs/voice-channel.md`, a vendor setup guide.
- Metrics and spans listed in section 8.

### Deferred

- Publish-time phrase generation, persona settings, per-minute counter and plan quotas.
- Planner fast model, `quick_reply`, sentence flush, routine streaming, voice evals (Phase 1).
- Channel-scope directives (Phase 1, shared with email).
- Owned runtime, WebRTC embed button, SIP numbers, pre-warm, recordings (Phase 2).
- Everything in Phase 3.

### Reviewer concerns

1. **Demand is unproven.** No issue, spec, doc, or customer quote mentions voice. The trigger is a latency question, not a buyer.
2. **The barge-in mechanism in section 6.1 is wrong.** On disconnect the turn keeps running for up to 120 s (`behaviorConfig.ts:218`). A new turn supersedes only before emission; after that it waits (`conversationTurnRegistry.ts:146-175`). History then stores an answer the caller never heard.
3. **The "text-only gates" are governance gates.** The head carries the coverage verdict and the `answer` / `no_support` / `out_of_scope` outcome. The grounding gate holds unsourced prose. The head also precedes the answer in generation order, so skipping it saves little unless the schema is reordered.
4. **The 1 s bridge is measured at Radioso, not at the caller.** Add vendor endpointing, transcription and speech legs, and the caller hears about 1.5 to 2.3 s of silence first. Phase 0 real answers land at about 4 to 6 s.
5. **Ananda's dominant turns are routine turns, and routine replies are not streamed.** A slot answer like "my name is Roberta" gets a bridge and a multi-second wait. Phase 0 will measure Phase 0 latency, not voice demand, unless the learning question is restated.
6. **Silence cliffs exist.** The planner times out at 12 s, then runs four staged fallback calls. A human-owned conversation generates a waiting message on every utterance.
7. **Security gaps.** The proposal puts the token in the URL path. The transfer destination must be operator-fixed to prevent toll fraud. Call ids must be scoped to the grant.
8. **A `voice` generation surface mixes two axes.** Voice steering is a channel concern; email (#1403) is adding a channel-context variant in parallel.
9. **Phase 1 deepens the #507 shortcut** if voice-mode branches land in `streamAnswer` instead of the engine contract.
10. **"One door covers the market" holds for the wire format only.** Call-id location, retry behaviour, and transfer tool semantics differ per vendor.

---

## 3. Review

### Step 0A. Premise challenge

- **The real problem.** The proposal frames latency as the problem. Latency is the constraint. The buyer problem would be calls to a small business that go unanswered after hours or at peaks.
- **Target outcome.** One partner's real calls answered by the same agent, with measured resolution, transfer rate, and hang-ups.
- **Do-nothing cost.** Low near term: per the proposal's appendix, Ananda's 30 most recent conversations are all `website_embed`. Medium long term: Zendesk (GA September 2026), Intercom, and Decagon ship voice. "Has voice" becomes a checklist line for support buyers.
- **Direct or proxy.** The proposal answers the founder's architecture question well. It solves the proxy "can Radioso talk fast enough", not the buyer pain. Phase 0 is the right instrument only if it measures answered calls and avoided transfers, not just tolerance of bridges.

### Step 0B. Existing code leverage

| Sub-problem | Existing code (verified unless marked) | Proposal builds | Assessment |
|---|---|---|---|
| Voice door | `agentChannelChatRoute.ts` (135 lines): grant credential middleware, rate limiters, request context, pinned revision, SSE via `sendChatSse` with disconnect abort | New first-class door | Mostly a new presenter (OpenAI chunk format) plus a call-id map over this route's pipeline. Smaller than the proposal implies. |
| Voice interaction mode | None. `ChatAnswerInput` has no mode field. | `interactionMode` per turn | Not needed in Phase 0. In Phase 1 it belongs in the conversation contract. |
| Bridge phrases | Nearest analog: operator-reviewed greetings (`propose_greeting` tool). Not inspected further. | Publish-time LLM generation, revision field, migration | Defer the pipeline; a reviewed phrase set gives the same governance. |
| Planner `quick_reply` | `turnPlanService.ts`, `turnPlanCoordinator.ts`, `behaviorConfig.ts` (`timeoutMs: 12_000`); failure falls back to four staged calls | New outcome, fast model | Correct place. Speed is unproven (section 7). |
| Directive surface | `generationSurface.ts`: `answer`, `suggested_questions`. No channel reference in `modules/directives`. | Add `voice` surface | Wrong axis. Needs a channel scope. |
| Hand-off mapping | `modules/handoff` (ownership, transfer notice), `contactRoutine.ts`, `handoffOnRetrievalMiss` agent setting; human-owned branch in `chatService.ts` near line 1377 | `transfer_call` / `request_callback` tool calls | Good reuse. Add the operator-owned case. |
| Metering | `reserveAnswer` already passes `surface: input.sourceChannel` (`chatService.ts:1367-1373`) | `surface: voice`, minute counter | Surface is free once the channel exists. Minute counter deferred. |
| Persona settings | Agent settings and publish pipeline (not inspected) | New revision fields | Deferred; vendor holds voice settings in Phase 0. |
| Runtime | None. `modules/realtime` is SSE workspace invalidation, not audio. | Vendor in Phase 0, own worker in Phase 2 | Agree with the sequencing. |
| Cancellation | `conversationTurnRegistry.ts` (in-memory, per process), 120 s disconnect ceiling | "Cancel via #868" | The cited path does not do this today. Needs a voice policy. |

**(1) A new door instead of a `ConnectorPlugin`.** Agree. `createConnectorChatPort` calls `chatService.answer` with `stream: false` (`connectorChatPort.ts:24-40`, verified). Making that port stream would change the connector contract package and trigger the cross-service review. That is worse. The refinement: the door is a wire-format variant of the agent channel, not a fresh stack. It should compose the existing credential and rate-limit middleware.

**(2) A third consumer of the streaming path that bypasses the engine (#507).** Calling `streamAnswer` from a third route adds no third copy. The duplication is `answer` (engine) versus `streamAnswer` (shortcut), noted at `turnSkillSelector.ts:88-95`. The real risk is Phase 1: every voice-mode branch added to the shortcut widens the gap. Phase 0 can avoid this entirely by putting the bridge timer and hand-off mapping in the door presenter. Phase 1 should carry `interactionMode` in the conversation contract and land routine streaming through #507 (D13).

**(3) Bridge phrases at publish time versus a runtime LLM call.** The proposal is right to reject a runtime call. A mini-model call races a sub-second trigger and becomes a second author. It has not justified publish time over a simpler store. Publish time adds a revision field, a migration, a new publish failure mode, and a language-coverage question. For one partner with a single-language agent, an LLM-drafted, operator-reviewed set is equivalent in governance (D7). Publish-time regeneration earns its cost when directives change often and many tenants use voice.

### Step 0C. Dream state mapping

**CURRENT STATE → THIS PLAN → 12-MONTH IDEAL**

**Current state.** Radioso answers through the web app, embed, REST, SDK, MCP, and Slack; email is in flight (#1403). Text turns take 2 to 8 s, with a local TTFT p50 of 3.6 s. The planner is a mandatory serial call at p50 1.6 to 3.8 s. Streaming bypasses the conversation engine (#507). No audio code exists, and no customer has asked for voice on record.

**This plan (reduced).** One partner's phone line reaches the same agent through a managed EU vendor and a thin OpenAI-compatible door. Callers hear a bridge, then the agent's answer, or a transfer or callback. Transcripts land in the inbox like any conversation. The team learns whether callers stay through 4 to 6 s answers, what they ask, and what a call costs. Nothing in the chat service changes except the voice cancellation policy.

**12-month ideal.** The operator writes rules once, and channel-scoped directives shape output for chat, email, and voice. Conversational turns reach first audio in about 1 s as heard by the caller, because the planner got fast for every channel. Streaming runs through the engine, and #507 is closed. Voice is sold as minutes on the plan catalog. An owned EU runtime exists only if EU-only or self-hosted buyers asked for it. Any vendor's mouth can sit in front of the brain.

### Step 0E. Mode selection

**SCOPE REDUCTION.**
- Demand is unproven: no issue, spec, or customer quote asks for voice, and no partner is named.
- Phase 0 bundles items whose value exists only after demand is proven: publish-time phrases, a minute counter, persona settings.
- Phase 0 also misses three must-haves (barge-in, turn ceiling, operator-owned turns); reducing scope pays for them.

### Step 0G. Scope reduction analysis

**Minimum core.** One door, one partner, one line, one vendor. The brain is unchanged except for voice cancellation. Every turn ends audibly in an answer, a transfer, or a callback capture.

**Keep or defer menu, phases 0 to 3**

| Item | Phase | Keep or Defer | Unlock condition for deferred items |
|---|---|---|---|
| Voice door, call-id map, hand-off tool calls, channel literal | 0 | Keep | none |
| Latency-triggered bridge (presenter timer) | 0 | Keep | none |
| Voice cancellation, turn ceiling, operator-owned mapping (added) | 0 | Keep | none |
| Vendor setup docs, OpenAPI, SDK sync | 0 | Keep | none |
| Publish-time bridge phrase generation | 0 | Defer | A second voice tenant, or directives changing the phrases |
| Per-minute usage counter | 0 | Defer | Radioso owns a vendor account (D4b) or Phase 2 starts |
| Planner fast model and `quick_reply` | 1 | Defer | Phase 0 hits D6's continue line and planner p50 under 500 ms is shown on a real prompt |
| Sentence flush | 1 | Defer | Vendor spike shows it does not buffer sentences |
| Gate bypass | 1 | Skip | A voice-safe grounding design that keeps the verdict before speech |
| Routine streaming | 1 | Defer | #507 lands, or the speed epic takes it for chat |
| Channel-scope directives (replaces `voice` surface) | 1 | Defer | Phase 1 starts or email needs it first |
| Voice persona settings | 1 | Defer | More than one voice tenant |
| Voice eval cases | 1 | Defer | Planner schema changes |
| Inbox channel label | 1 | Keep (moved to 0) | none |
| Own voice worker, WebRTC button, SIP numbers | 2 | Defer | A paying EU-only or self-hosted buyer |
| Interim-transcript pre-warm | 2 | Defer | Own runtime exists |
| Recordings and retention in Radioso | 2 | Defer | Radioso holds audio |
| Plan-catalog minute quotas | 2 | Defer | D16 decided with measured cost per call |
| Outbound calls from routines | 3 | Defer | Consent, number allow-list, and fraud controls designed |
| Semantic end of turn, listen-in, voice analytics | 3 | Defer | Vendor features prove insufficient |

**Zero silent failures, Phase 0**

| # | Error class | Trigger | Handler | Caller hears | Test that proves it |
|---|---|---|---|---|---|
| E1 | Vendor timeout | Turn exceeds the vendor's custom-LLM timeout (value unknown until the spike) | Voice ceiling set below the vendor timeout; door cancels the turn and emits `request_callback` or `transfer_call` | Bridge, the reviewed hand-off phrase, then transfer or callback capture | Supertest: stub `streamAnswer` never settles; assert tool call and `finish_reason` before the ceiling, lease cancelled |
| E2 | Planner timeout | Planner passes 12 s, then four staged fallback calls start | Same voice ceiling; lower planner timeout under voice via config | Same as E1 | Unit: planner stub sleeps past the ceiling; assert ceiling outcome and `voice_turn_ceiling_total` |
| E3 | Hand-off with no transfer number, or out of hours | Routine `handoff` ending, re-ask exhaustion, or retrieval miss with `handoffOnRetrievalMiss` | Map to `request_callback` through the contact-request path; if no contact path, end with the hand-off phrase and count `kind=unavailable` | The agent offers a call back, or says it cannot connect now | Table test: three hand-off sources × {in hours with transfer, out of hours, nothing configured} |
| E4 | Barge-in mid-stream | Vendor closes the HTTP stream while chunks flow | Voice disconnect cancels at once (no 120 s ceiling); registry supersedes after emission for voice; answer marked interrupted | The new utterance is answered without waiting for the old answer | Supertest: abort after the first chunk, post the next utterance; assert fast first delta and cancellation reason `barge_in` |
| E5 | Call id with no conversation | First utterance, missing id, id from another grant, expired id | First utterance creates a conversation keyed by (grant, call id); missing id returns 400 and counts; other grants never resolve | Normal answer; a missing id hits the vendor's own error path, visible in Radioso metrics | Repository unit tests; Supertest for the 400 |
| E6 | Metering cap reached | `reserveAnswer` refuses mid-call | Door maps the limit error to `request_callback` with the hand-off phrase; never a hang or a bare 500 | Hand-off phrase and callback capture | Supertest with a usage policy stub that throws the limit error |
| E7 | Unsupported language | Caller language has no phrase set, or the vendor voice cannot speak it | Bridge falls back to the agent's default locale; the planner still picks the answer language; mismatch counted | Bridge in the default language; known limitation logged | Unit: phrase selection with an unknown locale returns the default set |
| E8 | Empty or non-user last message | Vendor sends a silence reprompt, tool result, or empty text | No turn and no message; empty completion; counted | Vendor's own reprompt | Supertest |
| E9 | Duplicate utterance | Vendor retries the same request | Dedupe by (call id, normalized text, short window) before prepare | One answer | Supertest double post |
| E10 | Operator owns the conversation | Operator claimed it in the inbox | Map to transfer or callback instead of the waiting message | Transfer or callback | Door unit test with an ownership stub |
| E11 | Vendor ignores the tool call | Transfer tool misconfigured at the vendor | Hand-off phrase is spoken before the tool call; staging smoke per vendor | The hand-off phrase; the call may end without transfer | Vendor smoke script on the staging number |

### Step 0I. Temporal interrogation, Phase 0 only

| Hours | Block | Work | Done when |
|---|---|---|---|
| 0 to 4 | Foundations: spike | Point a vendor test agent at a stub endpoint. Record call-id location, history shape, timeout, retry, abort, and transfer tool behaviour. | A one-page vendor contract note exists in `.context/` |
| 4 to 10 | Foundations | `voice` channel literal; `voice` channel-context variant (cross-service review note); voice grant scope; call-id map and phrase set storage, one migration, both DB snapshots | Types compile; repository tests pass |
| 10 to 20 | Core | Request schema in Zod; newest-user-message extraction; route composing agent-channel middleware; OpenAI chunk presenter over `streamAnswer`; bridge timer; hand-off and operator-owned mapping to tool calls | E3, E5, E8, E10 pass |
| 20 to 28 | Core hardening | Voice cancellation policy in the registry and presenter; voice turn ceiling; dedupe; limit-error mapping | E1, E2, E4, E6, E9 pass |
| 28 to 36 | Integration | OpenAPI entry and `pnpm run sync`; metrics and spans; staging deploy behind the flag; end-to-end call on a staging number | A staging call transfers and a second one captures a callback |
| 36 to 44 | Polish | `docs/voice-channel.md`, vendor guide, readme channel list; draft and review the partner phrase set; go-live checklist (AI disclosure, recording notice, zero retention, DPA) | Partner signs off on phrases and the checklist |

| Blocker | Resolution |
|---|---|
| Vendor call-id location and timeout unknown | The hour 0 to 4 spike; the door keeps vendor field names in a small edge adapter |
| Vendor account ownership and cost exposure | Founder decision D4 before hour 0 |
| Partner transfer number and hours | Collected in the partner conversation (D2, D11) |
| Per-process turn registry across Cloud Run instances | Disconnect cancel is instance-local, which covers barge-in; overlap gets a detection metric now and a Postgres lease in Phase 1 if it fires |
| AI disclosure and recording notice wording | Vendor first message set to the agent's reviewed greeting; counsel confirms the disclosure duty |
| Operator-facing config needs a copilot descriptor or exclusion | State a coverage-map exclusion: staff-configured for one design partner in Phase 0 |

### Section 1. Architecture

The door belongs in `backend/src/app/http/routes/` beside `agentChannelChatRoute.ts`, with an OpenAI chunk presenter beside `chatPresenter.ts`. It knows the wire format, grant auth, the call-id map, the bridge timer, and the hand-off to tool-call mapping. It must not leak vendor field names past a small edge adapter. The chat service learns one narrow thing in Phase 0: a voice cancellation policy (cancel on disconnect, supersede after emission). The conversation contract gains a `voice` channel variant; the engine stays transport-agnostic. Dependencies point inward: door to chat service and access grants, never the reverse. Expect about 12 to 15 files including tests and docs; that is defensible for a new door.

### Section 2. Error and rescue map

See the Phase 0 table in Step 0G. The rescue rule is that every turn ends audibly in one of three ways: an answer, a transfer, or a callback capture. No path may leave the caller in silence past the voice ceiling. The proposal's own error handling covers only bridge misfires and first-turn language; E1, E2, E4, E6, E9, E10, and E11 are new.

### Section 3. Security and threat model

| Threat | Vector | Mitigation | Phase |
|---|---|---|---|
| Token leak | Proposal puts the token in the URL path; paths land in request logs and vendor dashboards | Bearer header with an access grant scoped to voice; per-grant rate limits and rotation already exist | 0 |
| Call-id spoofing | A grant holder sends another call's id to pull its history through the agent ("what is my booking?") | Map key is (grant, call id); never resolve across grants; expire after the call | 0 |
| Caller ID spoofing | Phone numbers are forgeable | Never treat the caller number as identity for visitor profiles or for acting skills; never log it | 0 |
| Prompt injection | The transcript is untrusted visitor text; vendor messages can carry their own system prompt | Same defences as chat; the door ignores every vendor message except the newest user turn | 0 |
| Toll fraud | A caller or the model names a transfer number | Transfer destination fixed in vendor config; tool call carries no number | 0 |
| Recordings | Audio and transcripts at the vendor | EU region, zero-retention mode, DPA and subprocessor list update; Radioso stores transcripts as messages only | 0 |
| Disclosure and consent | AI disclosure and recording-consent duties vary by country | Disclosure in the first spoken line; counsel confirms per partner country | 0 |
| Outbound abuse | Routines placing calls | Number allow-list, rate limits, consent records before any outbound work | 3 |

### Section 4. Data flow edge cases

| Case | Today (verified where noted) | Required voice behaviour |
|---|---|---|
| Empty transcript | Not verified for the agent-channel schema | No turn, no message, empty completion, counted |
| Duplicate utterance | A second request supersedes only before emission, otherwise waits; the user message is written twice (registry verified, write path not) | Dedupe before prepare |
| Two turns in flight | `InMemoryConversationTurnRegistry` is per process; instances do not coordinate (verified) | Cancel on disconnect covers barge-in; add an overlap metric; Postgres lease in Phase 1 if needed |
| Operator takes over mid-call | Human-owned turns generate a waiting message each time (`chatService.ts` near 1377 to 1395, verified) | Map to transfer or callback (D12); inbox labels live calls |
| Interrupted answer in history | The full answer is committed even if unheard | Mark interrupted; in Phase 1 use the vendor's replayed spoken prefix if it sends one (not verified) |

### Section 7. Performance

| Leg | Range | Source |
|---|---|---|
| End-of-speech detection | 300 to 700 ms | proposal section 4 |
| Transcript finalisation | 150 to 300 ms | proposal section 4 |
| Network and prepare | tens of ms | proposal section 3; network unmeasured |
| Bridge trigger | about 900 ms | proposal section 5 |
| First speech audio | 100 to 300 ms | proposal section 4 |
| **Caller hears the bridge after** | **about 1.5 to 2.3 s** | sum |
| Caller hears the real answer after (Phase 0) | about 4 to 6 s | TTFT p50 3.6 s local, 4.5 s Ananda routine turn, plus vendor legs |

The 1 s bridge is credible only as a Radioso-side number. For the caller to hear something near 1 s, five things must be true. First, planner p50 under about 500 ms on the voice model with a cached prefix, measured on a real fused prompt. Today's p50 is 1.6 to 3.8 s, so that is a 3x to 7x speedup with no evidence yet. Second, `quick_reply` accuracy holds on that model under the eval gate. Third, the bridge fires at about 300 to 400 ms for turns that are not quick replies. Fourth, vendor endpointing stays under 500 ms. Fifth, time to first audio is measured from end of speech at the vendor, not from Radioso's first delta. Bypassing the head gate does not help much: the head is generated before the answer, so its cost remains unless the schema is reordered.

### Section 8. Observability

Metrics, all low cardinality: `voice_door_requests_total{status}`, `voice_first_delta_ms{kind=bridge|answer|handoff}`, `voice_bridge_total`, `voice_handoff_total{kind,source}`, `voice_turn_ceiling_total`, `voice_call_id_rejected_total{reason}`, `voice_turn_overlap_total`. Reuse `chat_turn_cancellations_total` with a new reason `barge_in`. Add a `voice.turn` span carrying conversation id and call id as attributes, never as metric labels. Never log caller numbers, transcript text, phrase text, or recording URLs; log a phrase id instead. Audit events: voice grant create, rotate, revoke (existing grant audit) and transfer-availability changes. Caller-perceived time to first audio and call minutes come from the vendor in Phase 0; Radioso cannot see the audio legs.

### Section 9. Deployment and rollout

The door returns 404 unless the workspace has voice enabled and a voice-scoped grant; it is off by default in cloud and self-hosted builds. Enablement is staff-only for the design partner. Roll out in three steps: a staging number, then the partner's after-hours line with callback only, then business hours with transfer. Ananda runs in the EU stack, and the vendor region must match; the two production regions deploy separately. Minute caps: under D4(a) the partner's vendor account carries minutes, and Radioso relies on per-grant rate limits and conversation metering. Under D4(b), a hard vendor spend cap and a daily call cap must exist before a real number. Rollback is revoking the grant; the vendor falls back to voicemail. Phase 0 needs no new service and no new infrastructure secret.

### Section 10. Long-term trajectory

| Phase | Reversibility (1 hard, 5 easy) | Why |
|---|---|---|
| 0 | 4 | A route, a grant scope, a channel literal; stored voice conversations remain as data |
| 1 | 3 | Planner schema and contract changes ripple into evals and the engine |
| 2 | 2 | A new service, carrier numbers, recordings, and retention duties |

Vendor path dependency is low at the wire format and real at the edges: call-id location, retries, transfer semantics, and endpointing differ per vendor. Keep those in a per-vendor adapter at the door. The mouth versus brain split holds for 12 months while governance needs verbatim text and cascades stay viable. The pressure is commercial. Speech-to-speech models answer in under 300 ms at a fraction of the cost. If knowledge turns stay at 4 to 6 s, buyers will compare Radioso with talker-reasoner vendors. The split survives if Phase 1 makes most turns quick replies. If not, the next step is a governed cache of pre-computed answers, not a second persona. The proposal's tripwire, revisiting when a speech-to-speech model gains a verbatim mode, is the right one.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---|---|---|---|
| CEO Review | `/plan-ceo-review` | Scope and strategy | 1 | ISSUES_OPEN | Mode SCOPE REDUCTION; 23 scope items (10 accepted, 11 deferred, 2 skipped); 10 concerns; 16 founder decisions pending |
| Office Hours | `/office-hours` | Demand and wedge | 0 | NOT FOUND | Proposal links `review-office-hours.md`; the file is absent |
| Eng Review | `/plan-eng-review` | Architecture and tests, required before build | 0 | NOT RUN | none |
| Design Review | `/plan-design-review` | UI and UX gaps | 0 | NOT APPLICABLE | Reduced Phase 0 has no UI |
| Outside Voice | second-model review | Independent challenge | 0 | NOT RUN | none |

**VERDICT: NOT CLEARED.** Demand and partner decisions (D1, D2, D4, D5, D6) are open. Three Phase 0 correctness gaps are outside the proposal's scope: barge-in, the turn ceiling, and operator-owned turns. The gate bypass and the `voice` generation surface need redesign before Phase 1. Cleared only for a one-day vendor spike and the partner conversation.

**UNRESOLVED DECISIONS:**
- D1 Go or no-go on Phase 0 (recommended: only after a written partner commitment)
- D2 Design partner (recommended: Ananda after-hours line)
- D3 Phone or browser first (recommended: phone)
- D4 Vendor account owner (recommended: partner-owned, Radioso sets it up)
- D5 First vendor (recommended: ElevenLabs EU after a one-day spike)
- D6 Phase 0 kill and continue lines (recommended: set before start)
- D7 Bridge phrase source (recommended: LLM-drafted, operator-reviewed set)
- D8 Text gates in voice (recommended: keep both)
- D9 Voice steering axis (recommended: channel scope on directives, Phase 1)
- D10 Barge-in semantics (recommended: cancel on disconnect, supersede after emission)
- D11 Hand-off policy (recommended: transfer in hours, callback outside)
- D12 Operator claim during a live call (recommended: claim triggers transfer or callback)
- D13 Phase 1 code location (recommended: conversation contract and #507)
- D14 Door authentication (recommended: bearer header with a voice-scoped grant)
- D15 Managed vendor for EU cloud (recommended: acceptable in Phase 0)
- D16 Pricing (recommended: decide after Phase 0)
