# Voice Channel: Competitive and Technology Landscape

Research date: 2026-10-07. Compiled from vendor docs, pricing pages, and engineering
blogs where available; third-party review/aggregator sites are used for numbers
without a found primary source and are flagged **[secondary]**. Treat all
per-minute cost figures as directional — vendors change pricing frequently and
components (STT/LLM/TTS) are usually billed separately even under a single
"platform" sticker price.

---

## A1. Customer-support agent platforms — voice posture

| Vendor | Voice? | Latency claim | Fast model for voice? | Slow-op bridging | Human handoff |
|---|---|---|---|---|---|
| **Intercom Fin Voice** | Yes, Fin Voice 2 (2025) | ~0.43s faster than v1 after a dedicated 2025 speed effort; 30–40% latency cut since launch | Yes — "Apex Flash," a model built specifically for latency-sensitive turns, distinct from Fin's main reasoning model | Not detailed publicly beyond the Apex Flash split | Rule-based escalation (frustration, repeated loops, explicit request); warm transfer with spoken announcement + context summary attached to the conversation; options include transfer to teammate, callback offer, or forward to workflow |
| **Sierra** | Yes | Targets sub-400ms Time-to-First-Audio (TTFA) in production; treats TTFA, not generic "latency," as the north-star metric | Yes — orchestrates multiple models per task/locale, routing simple turns to fast models and complex reasoning elsewhere; explicitly flags that routing through several models **adds** latency, a tradeoff they call out themselves | Context-aware interim responses ("Let me pull up your order details"), speculative prefetch for known customers, parallel execution of abuse checks/retrieval/API calls, multi-provider request hedging | Not detailed in the engineering posts reviewed; product pages describe configurable escalation policies per workspace |
| **Decagon** | Yes — Voice 2.0, Sept 2025 | 65% latency reduction vs. Voice 1.0 (self-reported) | Partnered with ElevenLabs (2025) for the voice layer rather than building a bespoke fast model in-house | Not publicly detailed | Calls can end in full resolution or a "warm handoff to a human agent," using the same action-oriented-policy (AOP) logic that governs chat/email |
| **PolyAI** | Yes — core product since founding; Dialog-RSN-1 (2026) | Vendor claims <300ms for Dialog-RSN-1 in production; independent lab testing (2025) measured ~750–780ms end-to-end and ~240ms time-to-first-token — a large gap between vendor and third-party numbers **[mixed primary/secondary]** | Yes, architecturally — Dialog-RSN-1 fuses turn-taking, ASR, function-calling, and response generation into one model that reasons directly over raw audio, replacing a cascade | In-house full-stack (STT/LLM/TTS built, not stitched from third parties) to control latency directly; chunked/streamed output | Enterprise-managed deployment model; PolyAI's team configures escalation rules per client, no single published default |
| **Parloa** | Yes | 700–900ms typical response, varying with call load/translation **[secondary, trade-press]** | Multi-agent/"Subtask Agents" architecture with a supervisor and task agents; Parloa's own blog warns a supervisor hop costs "hundreds of ms" | Predictive turn-end projection to close gaps between turns; proprietary telephony stack (own SBCs, voice gateway) to shave network hops | Not detailed in sources reviewed |
| **Cognigy** (acquired by NICE/Avaya ecosystem partner) | Yes, as one of 30+ channels | No official number; independent/implementation-partner testing: 700–900ms, sometimes near 1s **[secondary]** | No dedicated fast model — relies on third-party STT/TTS (Google/Azure) plus phrase-by-phrase streaming to mask latency rather than a separate fast brain | Configurable phrase-by-phrase response streaming | Native deep integrations with Genesys, Avaya, Five9, Amazon Connect for live-agent transfer |
| **Zendesk AI agents (voice)** | Yes — GA September 2026 (EAP opened Feb 12, 2026) | Not published | Not disclosed | Not disclosed | On resolution: transcript/AI summary/call-log link attached to ticket. On failure: transcript+summary posted, call routed to human queue |
| **Ada** | Yes (chat/voice/email/social from one platform) | Not published | Not disclosed | Not disclosed | Not detailed in sources reviewed; positions ~83% autonomous resolution rate |
| **Kore.ai** | Yes | Independent reviews place it at 800–1000ms, with multi-second spikes when Azure TTS or chained third-party calls are involved **[secondary]** | No — treats voice as one of many channels; latency "is not the platform's strongest area" per third-party reviews | Not detailed | Enterprise contact-center integrations (telephony-agnostic) |
| **Crescendo** | Yes — rebuilt on Amazon Nova Sonic (partnership announced July 2025) | Sub-300ms cited for the Nova-Sonic-powered path (vendor claim) | Yes — delegated the speech-to-speech layer to Nova Sonic rather than a cascade | Not detailed | Not detailed; October 2025 "Multimodal AI" lets a conversation move between voice/chat/photo in one thread |
| **Observe.AI** | Primarily agent-assist/QA, not a headline voice-agent product in the sources found | No vendor-specific number found | — | — | — |
| **Cresta** | Yes — Voice Virtual Agent + agent-assist | No end-to-end voice-agent latency number found; agent-assist hints delivered to live human agents in "sub-200ms" | Multi-model system: 20+ task-specific models split across transcription, intent, response generation, guardrails | Real-time translation layer so agents/customers can speak different languages without a human interpreter | Human-in-the-loop by design for the agent-assist product; AI Agent product automates full conversations in 30+ languages |

**Pattern across the category**: every vendor with a public latency number is
explicitly chasing Time-to-First-Audio/token, not full-task completion time, and
every multi-model architecture (Sierra, Parloa, Cresta) acknowledges in its own
writing that routing/supervisor hops are a latency cost, not a free win. Filler/interim
utterances ("let me pull that up," "just a moment") are the near-universal device for
covering backend latency on calls more than a second or two long.

Sources: [Fin Voice 2](https://fin.ai/voice) · [Deploy Fin Voice](https://www.intercom.com/help/en/articles/10697275-deploy-fin-ai-agent-over-phone) · [Fin Voice handoff](https://www.intercom.com/help/en/articles/10697275-deploy-fin-voice) · [Sierra: Engineering low-latency voice agents (Oct 9, 2025)](https://sierra.ai/blog/voice-latency) · [Sierra: Improving voice performance with post-training](https://sierra.ai/blog/voice-post-training) · [Decagon x ElevenLabs](https://elevenlabs.io/blog/decagon) · [Decagon $4.5B/Series D](https://sacra.com/c/decagon/) · [PolyAI Dialog-RSN-1](https://www.cmswire.com/customer-experience/polyai-debuts-dialogrsn1-audionative-voice-ai-model/) · [Retell latency face-off 2025](https://www.retellai.com/resources/ai-voice-agent-latency-face-off-2025) · [Parloa: the latency paradox (May 28, 2026)](https://www.parloa.com/labs/insights/the-latency-paradox/) · [Parloa: Subtask Agents](https://www.parloa.com/labs/insights/multi-agent-architecture-for-voice/) · [Cognigy voice features](https://www.cognigy.com/product-updates/contact-center-ai-voice-features) · [Zendesk voice AI agents EAP](https://support.zendesk.com/hc/en-us/articles/10231529954074-Announcing-voice-AI-agents-EAP) · [Zendesk voice config GA](https://support.zendesk.com/hc/en-us/articles/10849624262170-Announcing-voice-configuration-for-voice-AI-agents) · [Ada AI](https://www.ada.cx/blog/build-out-loud-ai-voice-agents-product-updates/) · [Crescendo x Nova Sonic](https://www.crescendo.ai/news/crescendo-amazon-nova-sonic-voice-ai-customer-service) · [Cresta voice stack](https://cresta.com/blog/understanding-crestas-voice-platform-the-voice-stack) · [Cresta real-time translation](https://cresta.com/blog/cresta-expands-global-reach-with-real-time-voice-translation-and-multilingual-ai-across-the-platform)

---

## A2. Voice-agent infrastructure vendors

| Vendor | Pipeline | Latency claim | Pricing (platform fee only, unless noted) | Custom LLM/backend | Barge-in | Telephony/SIP | EU residency |
|---|---|---|---|---|---|---|---|
| **Vapi** | Orchestrator over BYO STT/LLM/TTS (cascade) | "Sub-500ms average" with WebRTC (vendor); all-in production cost ~$0.18–0.33/min once providers are added **[secondary for all-in figure]** | $0.05/min platform fee; providers billed on top | OpenAI-compatible custom endpoint; function/tool calling passthrough; BYO API key | Standard interrupt handling via streaming cascade | Twilio SIP trunk or Telnyx; can provision numbers directly | Partial — SCCs/DPA only, no dedicated EU region; US/AWS hosting |
| **Retell AI** | Cascade (voice infra + LLM + TTS as separate line items) | ~800ms average reported independently **[secondary]**; vendor range $0.07–$0.31/min implies wide quality tiers | $0.055/min voice infra + $0.003–$0.08/min LLM + $0.015–$0.04/min TTS; $0 extra for BYO LLM/telephony | Custom LLM via websocket; BYO LLM zeroes the LLM line item | Supported | Native number provisioning or BYO carrier | "No" per vendor — US-only, DPA/SCCs, not EU-hosted **[secondary aggregator]** |
| **Bland AI** | Cascade, proprietary self-hosted models option | Vendor claims ~400ms on proprietary models; independent reviews report ~800ms real-world **[secondary]** | $0.11–$0.14/min tiered (Start/Build/Scale), all-inclusive of STT+LLM+TTS+telephony | Less customizable than Vapi/Retell per third-party comparisons | Supported | Built-in telephony | Not found as a dedicated offering |
| **ElevenLabs Conversational AI / ElevenAgents** | Cascade, but with ElevenLabs' own STT (Scribe) + Flash v2.5 TTS tightly integrated | Flash v2.5 model latency ~75ms (vendor, TTS-only); ~240ms end-of-turn-to-response-start measured in review **[secondary]** | TTS ~$0.08/min after bundle at pay-as-you-go tier (post May 2026 price cuts: TTS −55%, STT −45%, agents platform −20%); LLM billed separately | LLM-agnostic: BYO model, call any frontier API, or use hosted models; custom LLM via Speech Engine SDK websocket; webhook "server tools" | Supported | Native SIP trunking (inbound/outbound), Twilio integration docs | Yes — dedicated EU/India/Singapore data-storage locations, Zero Retention Mode; the one vendor in this set with real EU regions, not just contracts |
| **Deepgram Voice Agent API** | Integrated STT+TTS (own infra) + BYO LLM in the middle | Sub-300ms claimed; Flux model posts "lowest end-of-speech detection latency" as of May 2026 (vendor) | Bundled $4.50/hr flat (no separate STT/TTS line), or PAYG $0.075–$0.163/min for STT/TTS alone | Any LLM can be slotted into the middle of the agent loop | Supported via streaming | Not a telephony provider itself — pairs with Twilio/SIP partners | Not confirmed in sources reviewed |
| **OpenAI Realtime API (gpt-realtime)** | Native speech-to-speech | Vendor speech-to-speech; LiveKit cites sub-300ms achievable with this class of native model | $32/1M audio input tokens, $64/1M audio output tokens (gpt-realtime); mini tier $10 in/$20 out; effective ~$0.05–0.15/min full model, ~$0.02–0.05/min mini, after caching | Function/tool calling native; can delegate out to an external backend as a tool call | Client detects `input_audio_buffer.speech_started`, sends `conversation.item.truncate`; WebRTC/SIP auto-truncates server-side | Native SIP calling support shipped with gpt-realtime | EU region endpoint (`eu.api.openai.com`) available for storage/processing, but tracing is explicitly **not** EU-compliant yet for `/v1/realtime` — a real gap to check before relying on it |
| **Google Gemini Live API (incl. 3.8 Live, Sept 2026)** | Native speech-to-speech | 100–200ms model processing latency (vendor benchmark) | Gemini 3.8 Live: audio in $3/1M tokens (~$0.005/min), audio out $12/1M tokens (~$0.018/min) — the cheapest native speech-to-speech found | Function calling with background tool execution while audio is in flight; a known gap — if the user is already speaking as the model's turn begins, no `interrupted` event fires and the model's turn plays out |
| **Amazon Nova Sonic (2 / 2.5)** | Native speech-to-speech on Bedrock | <500ms (vendor); March 2026 refresh cut p50 user-perceived latency ~150ms, improved 8kHz telephony turn-taking | ~$0.017/min combined speech in/out (vendor-derived), claimed ~80% cheaper than OpenAI Realtime | Via Bedrock tool use | Supported | Bedrock-side; telephony via partner integration (used by Crescendo) | AWS-region dependent; EU regions available via Bedrock region selection |
| **Twilio ConversationRelay** | Transport/orchestration layer (WebSocket) sitting in front of any STT/LLM/TTS stack | Vendor: median <0.5s, p95 <0.725s | Starts at $0.07/min on top of standard Twilio voice minutes | Bring your own LLM via WebSocket; Twilio just carries audio+events | Native support, cited as a design goal | This *is* the SIP/PSTN layer — Twilio's core telephony product | Twilio has EU data-residency options at the platform level (separate from any single AI vendor) |
| **LiveKit Agents** | Framework supporting both cascade and native speech-to-speech | Sub-500ms end-to-end cited as the 2026 default target; cascade budget ~VAD 50ms + STT 150ms + LLM TTFT 400ms + TTS 150ms + network 50ms (~800ms ceiling); native models can get under 300ms | Open-source framework; LiveKit Cloud charges for hosting/transport, not the agent logic itself | Explicit plugin model for OpenAI Realtime, Gemini Live, or any cascade combination; first-class tool calling | Built-in turn-detector + interruption handling | Native SIP support | Self-hostable, so EU residency is an infra choice, not a vendor constraint |
| **Pipecat (Daily)** | Open-source Python framework, frame-based pipeline, cascade or native | Round-trip ~500–800ms typical; sub-500ms p95 achievable with the 12 documented optimizations (streaming STT partials, partial-token TTS, prompt-prefix caching) | Open source; Daily charges for transport/hosting | Any STT/LLM/TTS provider pluggable; benchmarked 23 STT models in 2026 with no single winner | Documented interruption handling in the pipeline | Via Daily or partner SIP/telephony integrations | Self-hostable |
| **Hume EVI (3 / 4-mini)** | Native speech-to-speech with emotion modeling | EVI 3: practical latency ~1.2s mouth-to-ear (vendor); EVI 4-mini: ~100ms faster than prior version | Subscription tiers (Free/Starter $3/Creator $14) plus a cited ~$0.07/min usage rate **[secondary for the per-minute figure]** | API-based; less documented on BYO-LLM/tool-calling depth than Vapi/Retell/ElevenLabs | Supported | Not a primary telephony vendor | Not confirmed |
| **Cartesia (Sonic 3 / 3.5 / 3.6 TTS)** | TTS component only (pairs with any STT+LLM) | Vendor: Sonic-3 ~90ms TTFA, Sonic Turbo ~40ms (model-level, ideal conditions); independent measurement ~166–190ms real-world **[secondary for real-world figure]** | ~$33–49 per 1M characters (varies by model/tier); $299/mo Scale tier ≈ 10,667 TTS minutes | N/A — pure TTS layer, pairs with any LLM | N/A | N/A | Not confirmed |
| **AssemblyAI (Universal-Streaming / Voice Agent API)** | STT component, or bundled Voice Agent API | Sub-second streaming claimed; benchmarked median ~247–249ms time-to-final-segment (Sept 2026 internal benchmark) | Universal-Streaming from $0.15/hr; Universal-3.6 Pro Realtime $0.45/hr; bundled Voice Agent API (STT+LLM+TTS+turn detection+tools) flat $4.50/hr | Bundled API lets you plug in any LLM | Via turn-detection signals | N/A (STT vendor, not telephony) | Not confirmed |
| **Speechmatics** | STT component | Not benchmarked for latency in sources reviewed | Free tier 480 min/mo; Pro ~$0.0067/min real-time streaming, $0.005/min batch | N/A | N/A | N/A | Explicit multi-region (US/EU/Australia) with GDPR compliance — the clearest EU story among pure-STT vendors |
| **Azure Voice Live API** | Flexible: native speech-to-speech (GPT-Realtime) or cascade with Azure Speech, tiered Pro/Standard/Lite | Vendor: Azure's own realtime speech-to-speech model runs ~100ms faster than GPT-Realtime 1.5 | Pro tier native audio with GPT-4o-Realtime: $44/1M input, $88/1M output; cheaper Standard/Lite tiers available; billing started July 1, 2025 | Any Azure OpenAI-deployed model; Azure Speech-standard cascade option as a cheaper fallback | Supported, with "end-of-utterance detection" tuned to avoid premature interruption | Via Azure Communication Services | Full Azure regional model — EU regions available natively, likely the strongest enterprise-EU story of the realtime-model options |

Sources: [Vapi pricing breakdown](https://www.cloudtalk.io/blog/vapi-ai-pricing/) · [Vapi custom LLM docs](https://docs.vapi.ai/customization/custom-llm/using-your-server) · [Vapi SIP (Telnyx)](https://docs.vapi.ai/advanced/sip/telnyx) · [Retell latency face-off](https://www.retellai.com/resources/ai-voice-agent-latency-face-off-2025) · [Retell pricing](https://thunderphone.com/guides/retell-pricing) · [Bland AI pricing](https://pxlpeak.com/blog/ai-tools/bland-ai-pricing) · [ElevenLabs pricing May 2026 cuts](https://www.cloudzero.com/blog/elevenlabs-pricing/) · [ElevenLabs SIP trunking](https://elevenlabs.io/docs/agents-platform/phone-numbers/sip-trunking) · [ElevenLabs custom LLM](https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/custom-llm-integration) · [ElevenLabs data residency](https://elevenlabs.io/docs/overview/administration/data-residency) · [Deepgram Voice Agent API](https://deepgram.com/product/voice-agent-api) · [OpenAI gpt-realtime launch](https://openai.com/index/introducing-gpt-realtime/) · [OpenAI data residency](https://help.openai.com/en/articles/10503543-data-residency-for-the-openai-api) · [Gemini 3.8 Live GA, Sept 15 2026](https://foundrysoft.co/blog/gemini-3-8-live-voice-agent-latency-pricing) · [Gemini Live API overview](https://ai.google.dev/gemini-api/docs/live-api) · [Gemini Live interruption gap (dev forum)](https://discuss.ai.google.dev/t/gemini-3-1-flash-live-preview-live-api-server-never-emits-interrupted-barge-in-when-the-user-is-already-speaking-as-the-models-turn-begins/174346) · [Amazon Nova 2.5 Sonic announcement](https://aws.amazon.com/about-aws/whats-new/2026/10/amazon-nova-2.5-Sonic/) · [Nova 2 Sonic pricing/latency](https://miraflow.ai/blog/amazon-nova-2-sonic-speech-to-speech-explained-2026) · [Twilio ConversationRelay](https://www.twilio.com/en-us/products/conversational-ai/conversationrelay) · [Twilio low-latency layer blog](https://www.twilio.com/en-us/blog/insights/low-latency-layer-conversational-ai) · [LiveKit talker-reasoner](https://livekit.com/blog/talker-reasoner-pattern-voice-agents) · [LiveKit latency optimization](https://futureagi.com/blog/how-to-optimize-livekit-latency-2026/) · [Pipecat GitHub](https://github.com/pipecat-ai/pipecat) · [Pipecat STT benchmark](https://hackernoon.com/pipecat-benchmarked-23-real-time-stt-models-for-voice-agents-there-isnt-one-winner) · [Hume EVI 3](https://callsphere.ai/blog/vw1a-hume-evi-3-emotion-aware-voice-agents) · [Cartesia Sonic 3.6](https://www.marktechpost.com/2026/08/18/cartesia-ships-sonic-3-6-a-streaming-tts-model-that-now-leads-both-artificial-analysis-speech-arenas/) · [AssemblyAI Voice Agent API](https://www.assemblyai.com/blog/best-speech-to-speech-voice-agent-api) · [AssemblyAI Universal-3.6 pricing](https://www.assemblyai.com/blog/speech-to-text-api-pricing) · [Speechmatics pricing/residency](https://www.speechmatics.com/company/articles-and-news/best-speech-to-text-ai-guide-apis-platforms-and-services-compared) · [Azure Voice Live pricing announcement](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/azure-ai-voice-live-api-what%E2%80%99s-new-and-the-pricing-announcement/4428687)

---

## B. Latency engineering patterns for slow RAG/agentic backends

**The baseline everyone designs against**: median human conversational turn gap
is ~200ms across languages (Stivers et al., 2009, PNAS, cited repeatedly in 2026
vendor engineering posts). Working thresholds converged on across multiple
independent sources: **<300ms** reads as human, **300–500ms** reads as responsive,
**500ms–1s** is consciously noticed but tolerated, **beyond ~1s** without any signal
breaks conversational flow. [LiveKit's cascade budget](https://futureagi.com/blog/how-to-optimize-livekit-latency-2026/)
breaks an 800ms budget into VAD (50ms) + STT (150ms) + LLM TTFT (400ms) + TTS (150ms)
+ network (50ms); Pipecat's published budget is similar (~500–800ms round trip).
[Parloa](https://www.parloa.com/labs/insights/the-latency-paradox/) (May 2026) frames
600–1,200ms mouth-to-ear as the workable zone and argues latency should be "a budget,
not a target" — the right pause length varies by what's being said, not a single
number.

**Fast path / slow path ("talker-reasoner")**. The dominant pattern for bridging a
genuinely slow backend: run a small, low-latency model as the "talker" that owns
every conversational turn and never blocks, and delegate actual reasoning/retrieval
to a second, more capable "reasoner" model running asynchronously in the
background. [LiveKit's writeup](https://livekit.com/blog/talker-reasoner-pattern-voice-agents)
is explicit: the talker "initiates delegation through an async tool that
acknowledges the request immediately and releases the conversation," and the
reasoner's result "arrives later as a follow-up reply once it's ready." This traces
to the ["Agents Thinking Fast and Slow" paper](https://arxiv.org/pdf/2410.08328) (Google,
2024) that coined "talker-reasoner." A parallel academic pattern,
[VoiceAgentRAG](https://arxiv.org/html/2603.02206v1), decouples retrieval the same
way: a background "Slow Thinker" predicts likely follow-up topics and prefetches
chunks into a semantic cache, while the foreground "Fast Talker" only ever reads
from that cache, bypassing the vector database on the hot path entirely.

**Speculative/early retrieval on partial transcripts.** Because ASR streams partial
hypotheses while the user is still talking, several 2025–2026 papers (e.g.
["Hiding Tool Latency ... through Speculative Execution"](https://arxiv.org/html/2610.07641))
predict the likely tool/retrieval call from a partial transcript and start executing
it before the user finishes speaking, caching the result for injection once the
final transcript confirms intent — explicitly trading wasted speculative calls for
latency. Sierra's production pipeline does a related thing operationally:
predictive data prefetching for known customers, before they've asked anything
specific.

**Endpointing / semantic turn detection.** Pure silence-based VAD imposes a
200–500ms "silence tail" before the system is confident the user is done talking.
2025–2026 shipped semantic alternatives that read grammar/prosody/context instead
of just silence duration: OpenAI's Semantic VAD in the Realtime API, Pipecat's
open-source Smart Turn v3, LiveKit's Turn Detector v1 (fuses semantic+acoustic
signals, free on LiveKit Cloud inference, 14 languages), and Deepgram Flux. These
run on sub-500M-parameter models specifically so the turn-detection step itself adds
negligible latency.

**Filler utterances / "thinking sounds."** Backed by ACM CUI 2025 research cited in
multiple 2026 engineering posts: a filler ("Let me check that," "Just a moment")
read as **thinking**, not broken, and the effect is strongest once true latency
exceeds ~4 seconds — naked silence that long is "fatal" to the interaction, but a
filler converts the same wait into perceived thoroughness. Practical guidance
converges on recorded human fillers rather than TTS-synthesized "um" (which reads as
a glitch), and on OpenAI's and LiveKit's recommendation to run audio and tool calls
in parallel behind a short spoken preamble. LiveKit also ships ambient background
audio (keyboard typing, office ambience) as an alternative anchor during longer
waits. Sierra's production system goes further with context-aware interim
responses tied to the actual operation ("Let me pull up your order details") rather
than generic filler.

**Streaming TTS of the first sentence.** Universal across every serious vendor:
synthesize and play the first sentence/clause as soon as it's generated rather than
waiting for the full LLM response, overlapping TTS with ongoing LLM generation.
Cartesia, ElevenLabs Flash, and Deepgram all lead with this as a headline latency
number (sub-100ms time-to-first-byte on the TTS leg specifically).

**Tool-call latency budgets and async callbacks.** The consistent prescription:
treat each tool/retrieval call as its own latency-budgeted step with a hard timeout,
return an interim acknowledgment if the budget is exceeded, and let results come
back asynchronously as a new conversational turn rather than blocking the turn loop.
Gemini Live's background tool execution (continue speaking while a tool runs,
auto-cancel the pending call if the user interrupts with something new) and OpenAI's
async function-calling pattern in the Realtime API are the two productized versions
of this.

**Barge-in/interruption** is table stakes but implemented differently: OpenAI
Realtime requires the client to detect `input_audio_buffer.speech_started` and send
`conversation.item.truncate` (auto-truncated server-side over WebRTC/SIP); Gemini
Live sets a server-side `interrupted` flag — but as of the versions tested in 2026
forum reports, it has a known gap where it never fires if the user is already
speaking when the model's turn begins, so the model's full response plays out
regardless.

Sources: [LiveKit talker-reasoner pattern](https://livekit.com/blog/talker-reasoner-pattern-voice-agents) · [Sierra: Engineering low-latency voice agents](https://sierra.ai/blog/voice-latency) · [Parloa: the latency paradox](https://www.parloa.com/labs/insights/the-latency-paradox/) · [Parloa: Subtask Agents](https://www.parloa.com/labs/insights/multi-agent-architecture-for-voice/) · [VoiceAgentRAG](https://arxiv.org/html/2603.02206v1) · [Agents Thinking Fast and Slow (talker-reasoner origin paper)](https://arxiv.org/pdf/2410.08328) · [Speculative tool execution paper](https://arxiv.org/html/2610.07641) · [LiveKit latency optimization guide](https://futureagi.com/blog/how-to-optimize-livekit-latency-2026/) · [Pipecat latency optimization guide](https://futureagi.com/blog/how-to-optimize-pipecat-latency-2026/) · [Filler-phrase/latency-masking roundup](https://dev.to/kenimo49/your-voice-agent-is-slow-here-are-5-tricks-to-hide-it-3pcb) · [Human turn-gap research summary](https://hamming.ai/resources/voice-ai-latency-whats-fast-whats-slow-how-to-fix-it) · [Semantic VAD overview](https://gradium.ai/content/semantic-vad-voice-agents-turn-detection-2026) · [Gemini Live background tool cancellation](https://discuss.ai.google.dev/t/handling-user-interruptions-with-gemini-live-2-5-flash-vertex-ai-model/94924) · [OpenAI/Gemini barge-in mechanics comparison](https://zylos.ai/research/2026-07-19-realtime-voice-api-protocol-adaptation/)

---

## C. Market signals, 2025–2026

- **a16z, "AI Voice Agents: 2025 Update"** (Jan 29, 2025): documents ~90 voice-agent
  companies through YC since 2020, 10 in the W25 batch alone (22% of that cohort);
  ~69% of founders building phone-first business tools; verticals skew B2B
  (financial services, insurance, government, support) with healthcare (~18%) as the
  largest single vertical; frames voice as a "wedge" into a broader agent platform
  rather than the end product. a16z also separately projects **"Three Major
  Predictions for AI Agents in 2026"** including voice agents moving from demo to
  large-scale deployment.
- **OpenAI's December 2024 price cuts** (60% input / 87.5% output on GPT-4o
  Realtime) are repeatedly cited across 2025–2026 sources as the inflection point
  that made voice-agent unit economics viable for mainstream deployment — not a
  single later cut, but the one that unlocked the current wave.
- **Funding, 2025–2026** (order of scale):
  - **Sierra**: $350M at $10B (Sept 2025) → $950M Series E at $15.8B (May 2026, led
    by Tiger/GV). ARR crossed $100M (Nov 2025) and was near $200M annualized by
    mid-2026.
  - **ElevenLabs**: $180M Series C at $3.3B (Jan 2025) → $500M Series D at $11B
    (Feb 2026, led by Sequoia; a16z and ICONIQ increased stakes). 2025 ended at
    >$330M ARR; crossed $500M ARR by April 2026. A ~$22B secondary sale was reported
    under discussion mid-2026 **[secondary, unconfirmed]**.
  - **Decagon**: $250M Series D at $4.5B (Jan 2026, led by Coatue/Index).
  - **PolyAI**: $86M at $750M (late 2025).
  - Crescendo (not primarily a funding story in sources found) was tracking toward
    >$100M ARR by end of 2025, less than two years after founding — illustrating how
    fast voice-specific CX vendors are scaling revenue, not just valuation.
- **Adoption** (aggregator/survey sources, treat as directional, **[secondary]**):
  88% of contact centers report using some form of AI; only ~25% have it fully
  embedded in daily workflows vs. 38% still in pilot/partial rollout; one survey
  claims voice AI grew from ~6% to ~19% of inbound contact-center volume between
  2024 and 2026, and ~340% YoY growth in production voice-AI deployments in 2025.
  These numbers vary significantly by source and should be treated as showing
  *direction and magnitude of a trend*, not precise levels.
- **What buyers ask for**: phone-first is still dominant in the enterprise/contact-center
  segment (a16z's 69% figure, plus the weight of investment in telephony/SIP
  infrastructure — Twilio ConversationRelay, native SIP on OpenAI/ElevenLabs/Vapi);
  web/embed voice is more associated with consumer and B2B SaaS product surfaces.
  Language coverage (50+ languages is now a baseline claim for Ada, Crescendo,
  Cresta) and compliance/data-residency (explicit EU-region asks visible in
  ElevenLabs', Azure's, and Speechmatics' product pages, and in the OpenAI Realtime
  EU-tracing gap being called out in developer forums) are recurring, concrete buyer
  requirements rather than nice-to-haves.

Sources: [a16z: AI Voice Agents 2025 Update](https://a16z.com/ai-voice-agents-2025-update/) · [a16z 2026 predictions coverage](https://www.itiger.com/news/1130507746) · [Sierra $10B](https://www.bloomberg.com/news/articles/2025-09-04/bret-taylor-s-ai-startup-sierra-reaches-10-billion-valuation) · [Sierra $15.8B Series E](https://techstartups.com/2026/05/04/bret-taylors-ai-startup-sierra-raises-950m-at-15-8b-valuation-as-demand-for-ai-agents-surges/) · [ElevenLabs Series D $11B](https://www.cnbc.com/2026/02/04/nvidia-backed-ai-startup-elevenlabs-11-billion-valuation.html) · [ElevenLabs Series C $3.3B](https://www.finsmes.com/2026/02/elevenlabs-raises-500m-in-series-d-funding.html) · [Decagon $4.5B](https://sacra.com/c/decagon/) · [PolyAI $750M](https://www.cmswire.com/customer-experience/polyai-debuts-dialogrsn1-audionative-voice-ai-model/) · [Crescendo $100M ARR](https://www.crescendo.ai/news/crescendo-to-exceed-100m-arr-as-global-adoption-of-its-first-ai-native-contact-center-accelerates) · [Contact-center adoption roundup](https://frejun.com/call-center-ai/) · [Enterprise voice AI adoption report](https://agxntsix.ai/reports/state-of-enterprise-voice-ai-adoption-2026)

---

## D. Cost model (approximate per-minute, 2026)

All figures are blended/estimated from vendor pricing pages plus third-party
breakdowns; actual cost depends heavily on model tier, caching, and call mix
(silence, barge-in, tool calls). Treat as order-of-magnitude, not a quote.

| Approach | Components | Approx. $/min | Notes |
|---|---|---|---|
| **Cascade, budget tier** | Deepgram/AssemblyAI STT + small/mini LLM + Cartesia/ElevenLabs Flash TTS | **$0.05–0.12** | Bundled STT+TTS options (Deepgram $4.50/hr ≈ $0.075/min, AssemblyAI Voice Agent API flat $4.50/hr) absorb two of the three legs; mini-LLM calls add a few cents |
| **Cascade, production tier** | Higher-accuracy streaming STT + mid-tier LLM (e.g., GPT-4o-class) + higher-quality TTS | **$0.15–0.30** | This is the range most managed vendors (Retell, Vapi) land in once all components are summed, despite headline "$0.05/min" platform fees |
| **Speech-to-speech (OpenAI gpt-realtime)** | Single model, no cascade | **~$0.05–0.15** (full model) / **~$0.02–0.05** (mini) | Audio-token pricing ($32/$64 per 1M in/out full; $10/$20 mini) with prompt caching reducing effective cost; SIP support reduces the need for a separate telephony-to-model bridge |
| **Speech-to-speech (Gemini 3.8 Live)** | Single model | **~$0.02–0.03** blended (input ~$0.005/min, output ~$0.018/min) | Cheapest native speech-to-speech found in this research |
| **Speech-to-speech (Amazon Nova Sonic 2/2.5)** | Single model, Bedrock | **~$0.017** | Vendor-cited ~80% cheaper than OpenAI Realtime; telephony and EU region depend on Bedrock region choice |
| **Managed platform, all-in (Vapi/Retell/Bland)** | Platform fee + pass-through STT/LLM/TTS + telephony | **$0.11–0.33** | Wide range reflects model-tier choice and whether BYO keys are used; Bland's flat $0.11–$0.14/min tiers are the simplest to budget against |
| **Managed platform (ElevenLabs agents)** | ElevenLabs STT+TTS (post May-2026 price cuts) + separately billed LLM | **~$0.08+ TTS/STT** plus LLM | LLM cost is the variable; BYO-LLM lets you control that leg directly |

**Takeaway for budgeting**: native speech-to-speech models (OpenAI, Gemini, Nova
Sonic) are now the cheapest *and* lowest-latency option on paper, but they couple
you to a single vendor's reasoning quality and tool-calling semantics for the
real-time leg — which is exactly the tension Radioso's own fast-path/slow-path
design will have to resolve (a cheap/fast model carries the live mic, while the
existing retrieval+planning+directive pipeline runs as the "reasoner" behind an
async tool call). Pure cascades remain more expensive per minute but keep each
component (and each vendor relationship, and each region's compliance posture)
independently swappable — closer to Radioso's existing provider-adapter pattern.

Sources: [Deepgram Voice Agent API pricing](https://deepgram.com/product/voice-agent-api) · [AssemblyAI pricing](https://www.assemblyai.com/blog/speech-to-text-api-pricing) · [Vapi cost breakdown](https://www.cloudtalk.io/blog/vapi-ai-pricing/) · [Retell pricing](https://thunderphone.com/guides/retell-pricing) · [Bland AI pricing](https://pxlpeak.com/blog/ai-tools/bland-ai-pricing) · [OpenAI gpt-realtime pricing](https://openai.com/index/introducing-gpt-realtime/) · [Gemini 3.8 Live pricing](https://foundrysoft.co/blog/gemini-3-8-live-voice-agent-latency-pricing) · [Nova 2 Sonic pricing](https://miraflow.ai/blog/amazon-nova-2-sonic-speech-to-speech-explained-2026) · [ElevenLabs pricing May 2026](https://www.cloudzero.com/blog/elevenlabs-pricing/)

---

## Open questions / caveats

- Several "all-in" per-minute figures (Vapi, Retell, Hume) trace to SEO-style review
  aggregators rather than vendor pricing pages; the component-level vendor prices
  are solid, the "typical blended cost" roll-ups are estimates by third parties and
  should be re-validated against current vendor pricing calculators before using in
  any external-facing comparison.
- PolyAI's self-reported <300ms vs. independently measured ~750–780ms end-to-end is
  the starkest vendor-claim-vs-measured-reality gap found; treat any vendor's own
  latency number as a best-case/lab condition unless it comes with a measurement
  methodology.
- Gemini Live's interruption-handling gap (no `interrupted` event if the user is
  already speaking when the model's turn starts) was reported on Google's own
  developer forum in 2026 and may be model-version-specific; worth re-checking
  against the exact model version before depending on it.
- OpenAI Realtime's EU region covers storage/processing but explicitly excludes
  tracing for `/v1/realtime` as of the sources reviewed — a compliance detail that
  matters if Radioso's EU deployment relies on OpenAI Realtime and needs full
  observability.
