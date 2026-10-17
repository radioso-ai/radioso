# Office hours review: Voice for Radioso

Date: 2026-10-07
Mode: startup, non-interactive. The founder was not present, so every answer below is drawn from the documents and the repo.
Reviewed: `proposal.md`, `competitive-landscape.md`, `CLAUDE.md`, `readme.md`
Reviewer: Claude (Opus 5.5), running gstack `/office-hours`

## Phase 1: Context

Radioso is an open-source, self-hostable platform for customer-facing agents that answer, act and hand off inside rules the operator authors. Today every surface is text: the website embed, the web app, REST, the TypeScript SDK and MCP. The proposal asks Dmitri to approve voice as a new channel of the same agent. Its central design choice is "mouth vs. brain": a voice runtime handles audio, and the existing agent stays the only author of words. It asks for five decisions: an OpenAI-compatible streaming "voice door", a voice mode in the turn pipeline, no second fast agent, a managed vendor for Phase 0 with a design partner, and voice as a channel with its own directives, hand-off and metering. The trigger, in the proposal's own words, is latency: text turns take 2 to 8 s, fine in chat and unusable in speech. The first candidate partner is Ananda, an Italian retreat centre whose agent runs only in the website embed today.

## Phase 2A: The six forcing questions

### Q1 Demand Reality

> "What's the strongest evidence you have that someone actually wants this — not interested, not on a waitlist, but genuinely upset if it vanished?"

**Best answer from the evidence.** There is none yet. A GitHub search for "voice" and "phone" returns only unrelated issues about directive scoping and routine slots. No spec or doc mentions voice as a channel, and the proposal admits this in section 11.1. Ananda has not asked for voice on record. Its 30 most recent conversations all came through the website embed. Its booking flow ends in an email to the reception, and phone is an optional slot. The market evidence (Sierra at $15.8B, ElevenLabs at $11B) shows investors like the category. It does not show a buyer asking Radioso. The proposal's own trigger is an engineering observation about latency.

**Grade: weak.** Nothing here is paying, expanding or scrambling behaviour.

**Founder-only gap.** Who said "I want my agent to answer the phone", and in what words? Has any prospect made voice a condition of buying? Would Ananda be upset if voice never shipped? Without one real yes, every later phase is a guess.

### Q2 Status Quo

> "What are your users doing right now to solve this problem—even badly? What's the cost?"

**Best answer from the evidence.** Inferred, not observed. Ananda's directives send availability and booking questions to "the reception". The reception presumably answers the phone in office hours. After hours, calls probably go to voicemail or ring out. Web visitors already have a text agent that runs a booking routine and emails the reception. So phone callers get a human or nothing. Web visitors get a chat that works.

**Grade: weak.** No call volume, no missed-call count, no staff hours, no lost bookings.

**Founder-only gap.** How many calls does the reception take a week? What share arrive after hours or go unanswered? What do callers ask? Does a missed call become a lost booking? These numbers decide whether voice is a product or a feature nobody uses.

### Q3 Desperate Specificity

> "Name the actual human who needs this most. Title? What gets them promoted or fired? What keeps them awake?"

**Best answer from the evidence.** The person who staffs Ananda's reception and receives the booking hand-off emails. The plausible pain: the phone rings during courses and after hours, and the same date and room questions repeat. A missed call may be a booking that went elsewhere. But this is a role guessed from directives, not a person who told us.

There is a second problem. The voice market in the memo buys through contact centres: financial services, insurance, healthcare, enterprise support. Ananda is a small retreat centre with a reception inbox. The partner and the market point at different humans. They need different hand-off, pricing and compliance.

**Grade: weak.** A named organisation, an unnamed person, no stated consequence.

**Founder-only gap.** Name the person at Ananda who answers the phone, and ask what a missed call costs them. Then decide whether Radioso's voice buyer is a small operator like Ananda or a contact-centre lead.

### Q4 Narrowest Wedge

> "What's the smallest version someone would pay for this week—not after the full platform ships?"

**Best answer from the evidence.** Phase 0 is the closest thing in the proposal: one partner, one number, a managed vendor, about two weeks. It is not the narrowest. It includes publish-time bridge generation (a new revision field and a migration), a per-minute counter in billing, and a `transfer_call` tool contract. None of these are needed to learn whether callers want voice. Narrower still is an after-hours line at Ananda. It takes one spoken message and turns it into the same structured booking hand-off the reception already gets from chat (Approach C below). That needs days and no live latency work.

**Grade: medium.** Gating Phase 0 on a named partner and a named line is strong discipline. The scope is wider than the question it tests.

**Founder-only gap.** Would Ananda switch on, or pay for, an after-hours line this month? If not even that, the wedge is not there.

### Q5 Observation & Surprise

> "Have you watched someone use this without helping? What surprised you?"

**Best answer from the evidence.** Nobody has watched a caller use a Radioso voice agent, because none exists. Every observation so far is text. A traced Ananda booking turn took about 4.5 s. Earlier Test Chat runs of the booking routine did surprise: always-on directives overrode the step question in two of three sessions, and a slot over-filled from "book a stay". Those were found only by watching. Voice will have surprises of its own. One is predictable now: the routine asks for an email address, and spelled-out email addresses through speech-to-text fail often, in Italian more so. Another: the English agent's contact block is instructed to be "a bulleted list with emojis", which cannot be spoken.

**Grade: weak.** No voice observation. The text precedent shows how much watching reveals.

**Founder-only gap.** Run a Wizard-of-Oz call before any code. The reception person phones you with a real question. You type it into Test Chat and read the reply aloud, pausing as long as the turn takes. Note where they hesitate, interrupt or ask you to repeat. It costs an afternoon.

### Q6 Future-Fit

> "If the world changes meaningfully in 3 years, does your product become more essential or less?"

**Best answer from the evidence.** The mouth is commoditising fast. The memo shows speech-to-speech near $0.02 a minute, and every cascade accepts a custom brain. What stays scarce is a brain that follows the operator's rules, speaks Exact Words verbatim, keeps one trace, and runs in the EU or on-premise. If that holds, a governed brain behind any mouth becomes more essential as mouths multiply. The planner speed work also helps chat whether or not voice ships.

The counter-case is real. The leaders sell brain and mouth as one product: Fin Voice, Sierra, Decagon with ElevenLabs. If buyers keep buying bundles, "bring your own mouth" is an integration, not a reason to choose Radioso. And if a speech-to-speech model gains a reliable verbatim mode, the cascade premise flips.

**Grade: medium.** It makes a specific claim about what commoditises and what does not. There is no evidence yet that Radioso's buyers will assemble a two-vendor stack.

**Founder-only gap.** Will your buyer accept "Radioso plus a voice vendor", or do they expect one product and one bill? The answer decides whether Phase 2, the owned runtime, is the product or an optional extra.

## Phase 3: Premise challenge

PREMISES:
1. Voice latency must be solved inside one governed brain, not a second agent — agree/disagree?
   Verdict: **agree on governance, unproven on latency.** One author is the moat. But `quick_reply` only helps if the planner drops from 1.6 to 3.8 s p50 to under about 800 ms, and nobody has measured that.
2. A bridged 3 to 5 s answer is acceptable to callers — agree/disagree?
   Verdict: **unproven, and optimistic for Phase 0.** Phase 0 has no planner work, chat TTFT is 3.6 s p50 before audio overhead, and routine replies are not streamed. Expect 5 to 6 s on a phone, with a bridge on most turns of a seven-slot booking.
3. Cascade beats speech-to-speech for Radioso because of verbatim text — agree/disagree?
   Verdict: **agree.** Exact Words, directive adherence and the trace all assume the caller hears the text the brain wrote. The higher per-minute cost is the price of the product's promise.
4. A managed vendor is acceptable for Phase 0 — agree/disagree?
   Verdict: **agree, with conditions.** EU region, zero-retention mode, a signed DPA, and no vendor-authored words: greeting, fillers, timeout prompts and goodbyes must come from the agent or be off.
5. Phone beats browser voice as the wedge — agree/disagree?
   Verdict: **unproven.** The 69% figure counts voice-agent founders in January 2025, not buyers. Ananda's traffic is all embed today. Phone has the stronger status quo only if calls go unanswered, and nobody has counted them.
6. The OpenAI-compatible door covers the market — agree/disagree?
   Verdict: **disagree as stated.** The memo lists Retell's custom LLM as a WebSocket protocol and ConversationRelay as bring-your-own WebSocket, and section 6.4 concedes ConversationRelay needs a bridge. It covers most, not all; design the door so a second wire format is an adapter.
7. Someone wants voice now (implicit) — agree/disagree?
   Verdict: **unproven.** No issue, spec, doc or customer quote. Every other premise rests on this one.
8. Ananda is the right first partner (implicit) — agree/disagree?
   Verdict: **unproven.** Team notes from 2026-10-06 say its text booking routine was still unpublished and hand-off recipients were not set. Voice would carry a flow that has not yet run live in text.
9. The voice work pays for itself in chat even if voice fails (section 6.2) — agree/disagree?
   Verdict: **partly agree.** Planner speed and routine streaming help chat, and epic #856 wants them. The gate bypass, bridge, door and runtime do not.
10. Warm transfer is the hand-off small operators need (section 6.3) — agree/disagree?
    Verdict: **disagree for Ananda-shaped customers.** In office hours the reception answers its own phone. After hours nobody can take a transfer. Callback capture is the hand-off that matters.
11. Pricing can stay an open question (section 11.6) — agree/disagree?
    Verdict: **disagree.** Satellite earns about €0.15 a conversation (€149 for 1,000). A 4-minute call costs $0.40 to $0.80 in vendor fees alone. Even at two conversations per call, every call loses money.

## Phase 4: Alternatives

APPROACH A: Thin door, managed mouth
  Summary: Point one managed vendor, in its EU region, at a thin OpenAI-compatible adapter over the existing streaming chat path. One Ananda number, after hours only. No planner change, no publish-time phrase generation, no Radioso minute counter. A bridge line per language is an operator-authored agent setting, like the greeting, played when the first token is late. Hand-off is callback capture through the existing contact routine, keyed on caller ID. The vendor enforces a hard minute cap.
  Effort: S to M (one to two weeks)
  Risk: Med. A 5 to 6 s wait on routine turns may sink the test. That is itself a useful answer.
  Pros: Tests the proposal's central question with real callers. No audio infrastructure. Reversible. Produces transcripts and latency traces. The door, call-id mapping and `voice` source label all survive into B.
  Cons: Sounds slow until Phase 1 lands. A vendor sits in the audio path. It becomes a third consumer of the duplicated streaming path unless the shared door helper is extracted first. It does not test `quick_reply`.
  Reuses: SSE chunk stream, session preparer, turn cancellation (#868), contact routine, hand-off with collected slots (#1291), inbox.

APPROACH B: Voice door, voice mode, then own runtime (the proposal as written)
  Summary: Phase 0 adds the door with `transfer_call`, publish-time bridge phrases and a per-minute counter. Phase 1 moves the planner to a fast model with `quick_reply`, adds sentence flush, gate bypass, routine streaming and a `voice` directive surface. Phase 2 builds a Radioso voice worker on LiveKit, a WebRTC embed button, SIP numbers and retention. Phase 3 adds outbound calls and voice analytics.
  Effort: XL (14 to 17 weeks before Phase 3)
  Risk: High. Demand is unproven. Carriers, recordings and media servers are a new operational discipline. Contract changes span the conversation contract, OpenAPI, the SDK snapshot and the plan catalog.
  Pros: The right long-term shape. One brain, one trace, one set of rules. Voice for self-hosted and EU-only tenants. Chat time-to-first-token drops as a side effect.
  Cons: Touches about a dozen areas (section 8), which the repo's design discipline treats as a smell. Large opportunity cost against the email channel (PR #1436 is open) and post-billing work. It plans Phase 2 before any call has happened.
  Reuses: Everything listed in proposal section 8.

APPROACH C: After-hours booking line (voice in, prepared callback out)
  Summary: Outside office hours, Ananda's line takes one spoken message: who you are, which course, which dates, what you want to know. The telephony provider transcribes it. A small adapter posts the transcript to Radioso as a human turn on a `voice` source, with the caller's number as a context variable. A one-step intake routine extracts whatever slots the message holds and ends in a hand-off. The reception gets the hand-off email it already receives from chat, with collected slots, transcript and number. The agent's grounded reply sits in the inbox, so the reception reads it before calling back. No model speaks, so latency stops mattering.
  Effort: S (days)
  Risk: Low
  Pros: Targets the likely real pain, after-hours bookings lost to voicemail, without a live audio loop. Full governance. The reception gets structured requests instead of voicemails. It measures exactly what B needs: call volume, after-hours share, language mix, question mix, and how many questions the documents can answer. Transcripts become voice eval cases.
  Cons: Not conversational voice, and the caller waits until morning. It does not test tolerance for bridged answers. Some callers will hear it as voicemail. It needs a check that a routine can fill several slots from one message and end without asking a follow-up.
  Reuses: Routine slot extraction, hand-off notification with collected slots (#1291), contact delivery, inbox, Audience Pulse for the question mix, and the `voice` source label A and B need anyway.

RECOMMENDATION: Choose C because nobody has asked for voice yet, and C measures real calls and helps the reception within days without solving latency first.

Move to A only when C's log shows enough after-hours callers asking questions the agent can answer. Treat B's Phase 1 planner work as chat work, justified by epic #856 on its own.

## Phase 4.5: Founder signals

| Signal | Present? | Evidence |
|---|---|---|
| Named user | Partial | Ananda is named. No person at Ananda has asked for voice. |
| Pushback | No, from users | The only pushback is internal: the proposal rejects the founder's own fast/slow split. Good thinking, not a market signal. |
| Behavioural demand | No | No calls counted, no workaround observed, no payment. |
| Domain expertise | Yes | The pipeline is measured stage by stage, constraints are mapped to files, and weak sources in the memo are flagged. |
| Taste | Yes | Mouth vs. brain is a clean, mechanical boundary. The cascade is chosen for verbatim reasons. Phases are gated on evidence. |

Count: 2 of 5, plus one partial.

What it implies: all the strength is on the supply side. The engineering is ahead of the customer. That is normal for a platform adding a channel. But a plan this well argued with no demand signal is easy to approve and hard to stop. The next week belongs to the customer, not the code.

## Phase 5: Design doc delta

Do not rewrite the proposal. Make these changes.

- **ADD a "Demand evidence" section that opens the doc,** with Ananda's call counts and the exact words of anyone who asked. Why: section 11.1 admits there is none, yet the doc leads with architecture.
- **ADD a precondition that Ananda's text booking routine is published and has handled live bookings.** Why: voice should carry a flow that already works in text, not debug both at once.
- **ADD a Phase 0 phone latency budget:** endpointing, speech-to-text, chat TTFT (3.6 s p50, 4.2 s p95) and speech, about 5 to 6 s, slower on routine turns. Why: the "3 to 5 s" headline is a post-Phase-1 number and sets the wrong expectation.
- **ADD "voice changes the routine":** pass caller ID as a context variable and stop asking callers to spell email addresses. Why: Ananda's routine collects an email, and a misheard address makes the hand-off useless.
- **ADD a barge-in truth rule:** when the caller interrupts, store the assistant turn as heard, truncated or marked interrupted. Why: otherwise the trace, inbox and Exact Words audit claim the caller heard words they never heard.
- **ADD a "no vendor-authored words" checklist** for greeting, fillers, timeout prompts and goodbyes. Why: a managed mouth can quietly become the second author the proposal rejects.
- **ADD unit economics against the live plan catalog, and make a per-minute price a gate for general availability.** Why: Satellite earns about €0.15 a conversation, and a 4-minute call costs $0.40 to $0.80 in vendor fees alone.
- **ADD the copilot tool descriptor or coverage-map exclusion** for voice persona settings and the `voice` directive surface. Why: CLAUDE.md requires it in the same change, and section 8 never mentions Ray.
- **CUT publish-time LLM generation of bridge phrases.** Use an operator-authored bridge line per language, set like the greeting and draftable by Ray. Why: operator-authored copy already meets the no-hard-coded-copy rule, and generation adds a publish change and a migration.
- **CUT `transfer_call` and the in-product minute counter from Phase 0.** Use callback capture and a vendor-side hard cap. Why: after hours nobody can take a transfer, and billing work for one pilot is cost before learning.
- **CUT Phases 2 and 3 to one paragraph each with numeric entry criteria,** such as weekly calls across several workspaces or a signed EU-only buyer. Why: "only worth it once calls are happening" needs a number to work as a gate.
- **CHANGE "every serious voice stack can call that shape today" to "most".** Name the WebSocket-only stacks and add a one-day spike on the chosen vendor's custom-LLM contract. Why: the companion memo contradicts the claim, and Phase 0 rests on unverified vendor behaviour.

### Tactical tells

- **Section 8: "finish #507 or at least route voice through the same shortcut".** Issue #507 is closed as deferred, and "or at least" leaves the substrate open. Decide now: extract the shared streaming-door helper section 8 already suggests, then add voice as its consumer.
- **Section 9: bridge misfires are "acceptable in Phase 0".** On a booking call, slot answers like "my name is Roberta" are the common turn, not the edge case. A bridge before each one is the main experience, not a misfire.
- **Sections 1 and 7: "roughly two weeks" for Phase 0.** The scope includes a publish-pipeline change, a migration, a billing counter and a vendor tool contract. Cut scope rather than trust the estimate.
- Not tells: "Phase 0 keeps them with the vendor on purpose" and "can be revisited if a speech-to-speech model gains a verbatim mode". Both are reasoned, conditional decisions.

## Phase 6: The assignment

**This week, before any code:** get a five-working-day call log from Ananda's reception. For every inbound call, note the time, language, what the caller wanted, and whether it became a booking. Also pull last month's missed and after-hours call count from their phone provider. If after-hours calls are fewer than about ten a week, shelve voice and ship the planner speed work as chat work. If they are more, start Approach C the following Monday.

**What I noticed about how you think:** you asked an architecture question, one agent or two, before a customer question, who is calling and what they lose when nobody answers. Your instinct to keep one governed brain is exactly the moat; point the same rigour at the caller next.
