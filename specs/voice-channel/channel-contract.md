# Voice channel contract (vendor-neutral)

Date: 2026-10-12 · Companion: [plan.md](plan.md), [proposal.md](proposal.md)

The voice channel is a Radioso-owned domain with a narrow port. Vendors are adapters that bind that port to a wire. ElevenLabs is the first adapter configuration, not the shape of the channel.

## 1. What each layer knows

| Layer | Knows | Must not know |
|---|---|---|
| **Voice channel domain** (`backend/src/modules/voiceChannel/`) | a session is a call or browser voice session tied to one conversation; an utterance is one finished transcript; a reply is speakable text delivered in sentence-sized pieces; a turn can be bridged, time-limited, interrupted, and ends in a typed outcome; the agent's voice settings | any vendor's field names, tool names, SSE or WebSocket framing, audio |
| **Vendor adapters** (`voiceChannel/adapters/*`) | one wire protocol and its dialects: where the session key travels, how tools are named, how the vendor signals interruption | planning, retrieval, routines, settings semantics, persistence |
| **Chat service** | nothing new except the `sourceChannel` literal and the `latest_input_wins` supersession mode: the turn lease cancels a turn after emission when both turns ask for it, and the lifecycle deletes the user message of a turn a newer input replaced before it emitted | that voice exists |

Dependency direction: `adapter → voice domain port → chat service`. Composition wires adapters to the port. The domain never imports an adapter.

## 2. The port

```ts
// backend/src/modules/voiceChannel/domain.ts (sketch)

type VoiceTransport = "phone" | "web";

interface VoiceSessionRef {
  workspaceId: string;
  agentId: string;
  vendor: string;        // the namespace of the session key: a dialect id ("elevenlabs", "generic") or an adapter id ("twilio-conversation-relay")
  sessionKey: string;    // the vendor's call or session id, opaque to Radioso
}

interface VoiceTurnInput {
  session: VoiceSessionRef;
  transport: VoiceTransport;
  utterance: string;              // the final transcript of one caller turn
  locale?: string;                // BCP 47 when the vendor detected it
  callerId?: string;              // E.164 when the transport is phone; becomes a context variable
  heardUntil?: string;            // the previous reply as far as the caller heard it before speaking over it, when the vendor reports it; recorded as an audit note
  minReleasableSentenceChars?: number; // from the dialect: the shortest first sentence the runtime speaks before more text arrives; bridge lines that reach it are preferred
}

type VoiceTurnEvent =
  | { type: "conversation"; conversationId: string } // first, so adapters can name the conversation before any speech
  | { type: "bridge"; text: string }                 // authored line, emitted by policy while the brain works
  | { type: "speech"; text: string; last: boolean }  // speakable piece of the agent's reply, verbatim
  | { type: "outcome"; outcome: VoiceTurnOutcome };  // exactly one, always last, and the events end with it; a superseded turn ends with `continue`

type VoiceTurnOutcome =
  | { kind: "continue" }
  | { kind: "transfer"; target: string }   // from agent settings only, never from the model
  | { kind: "end" }
  | { kind: "callback_requested"; handoffReason?: string };
// domain.ts implements `continue | callback_requested`; `transfer` and `end` arrive with the phone column (Phase 0).

interface VoiceTurnPort {
  // hungUp: the runtime closed the request before the outcome reached it; the turn runs on and is stored
  runTurn(input: VoiceTurnInput, signal: AbortSignal, hungUp?: AbortSignal): AsyncIterable<VoiceTurnEvent>;
}
```

What the port does inside, in order: resolve or create the conversation for `(agentId, vendor, sessionKey)`; reserve usage with `surface: "voice"`; start the chat turn with `sourceChannel: "voice"` and a `channelContext` of provider `voice`; apply the turn policy (section 4) over the chat event stream; derive the outcome from the reply envelope (section 5). A newer request of the same session is the interruption: the newest utterance wins, the turn in flight is superseded even mid-reply, and one superseded before its reply started leaves no user message. An identical utterance after a reply the caller lost hears the stored answer again, and `heardUntil` marks the stored reply as interrupted (the message's `interruption` field in history: heard and spoken character counts) and is recorded as a `voice.reply_interrupted` audit note.

## 3. The adapter contract

```ts
interface VoiceVendorAdapter {
  id: string;                                    // "openai-completions" | "twilio-conversation-relay" | "retell" | ...
  mount(router: Router, deps: { turns: VoiceTurnPort; auth: AgentChannelAuth; dialects: DialectRegistry }): void;
}
```

An adapter translates in both directions and nothing else:

- **Inbound**: authenticate with the existing agent-channel grant; extract `sessionKey`, `utterance`, `locale`, `callerId` and `heardUntil`; build `VoiceTurnInput`; fire the port's `hungUp` signal when the runtime closes the request before the outcome was sent.
- **Outbound**: render `bridge` and `speech` events on the vendor's wire; render `outcome` as the vendor's command or tool call; honour the vendor's abort as `signal` cancellation.

Adapters are registered in composition. Promoting the contract into `packages/connector-api` beside `ConnectorPlugin` is a Phase 0 decision; the demo keeps it in the module.

### Dialects

Several vendors share one wire but differ in field and tool names. A dialect is data, not code:

```ts
interface CompletionsDialect {
  id: "elevenlabs" | "vapi" | "generic";
  sessionKeyFrom: { header?: string; bodyPath?: string };   // e.g. bodyPath "elevenlabs_extra_body.session_key", minted by the client at session start
  callerIdFrom?: { bodyPath?: string };
  tools: { transfer: string; end?: string };                // the vendor's own tool names, e.g. "transfer_to_number", "end_call"
}
```

The adapter echoes the vendor's tool name exactly as it appeared in the request's `tools` array; the dialect only says which one means transfer.

## 4. Turn policy (vendor-neutral, pure)

Implemented as wrappers over `AsyncIterable<ChatStreamEvent>`, like the existing disconnect-ceiling wrapper, with fake-timer tests.

| Rule | Behaviour | Source of truth |
|---|---|---|
| Sentence pieces | `chunk` text is re-cut at sentence boundaries into `speech` events; the final piece carries `last: true` | composition constant |
| Bridge | one `bridge` event from the agent's authored lines when the turn starts searching, 400 ms after it starts composing with no speech yet, or after 2.5 s with no phase at all (so a planner quick reply, up to about 2 s, never gets a bridge; only a stalled planner reaches it); style by routine state (acknowledgement inside a routine, check outside), locale from the input or the agent default; none on a turn whose conversation is human-owned at turn start, so chat's waiting message comes alone | agent settings `voice.bridgeLines`; composition constants |
| Turn limit | on a turn the agent owns, no `speech` within 10 s → `speech` with the authored fallback line, then `outcome: continue` (`callback_requested` after the limit needs a callback path, Phase 0); a turn whose conversation is human-owned at turn start has no limit, so chat's waiting message is never talked over. 10 s, not 8: at 8 s the limit cut off about one grounded turn in fifteen in local sessions, and the `elevenlabs` keep-alive holds the stream through the wait | agent settings `voice.fallbackLine`; composition constant |
| Interruption | a new request for a session whose turn is still in flight cancels that turn even after emission started (the chat lease's `latest_input_wins` mode); one still setting up ends before its chat turn starts; a turn cancelled before emission leaves no user message, one cancelled after keeps it and stores no reply; a bridge never follows a superseded turn's bridge within `bridgeAfterMs`; an identical utterance within 30 s of a hung-up or overtaken turn with a stored answer replays that answer; `heardUntil` (the truncated reply in replayed history) marks the stored reply as interrupted (heard and spoken character counts, the message's `interruption` field) and is recorded as `voice.reply_interrupted` | turn lease cancellation mode, in-process session memory (PR 4), chat's `ReplyInterruptionMarker` port |
| Governance gates | unchanged; the coverage head and grounding gate run before any `speech` | chat service |

## 5. Outcome derivation

Outcomes depend on the transport, because a hand-off means different things on a phone line and in a browser.

Implemented: the `web` column (PR 3), for every transport. `phone` gets the same derivation, which matches its rows only while no transfer target exists; the `phone` column's `transfer` rows, `voice.transfer.target` and the `tool_calls` transfer frame are Phase 0.

"Contact details were captured" is structural: chat's `done` event carries `handoff: { reason, collectedSlotCount }` on a turn that handed off, where `collectedSlotCount` counts the declared slots the ending routine held a value for (the keys of the engine's `handoff.collected`); `callback_requested` needs at least one. No slot key or value is read for meaning. The agent reply envelope (`AgentReplyEnvelopeCore`) exposes no captured slots, so the count is a chat reply field the HTTP presenters drop; OpenAPI is unchanged. `handoffReason` is the hand-off's reason (`routine_handoff`, `routine_stuck`, `retrieval_miss`).

The completions adapter ends both web outcomes with `stop` and `[DONE]`, with no tool call, and names the outcome kind in `X-Radioso-Voice-Outcome`: a response header without streaming, an HTTP trailer on a stream.

| Reply envelope | `phone` | `web` (implemented) |
|---|---|---|
| `ownership.state === "human_owned"` and not suppressed, transfer target configured | `transfer` | `callback_requested` when contact details were captured, else `continue`; the conversation is human-owned and the operator continues it in text from the inbox |
| same, no target configured | `callback_requested` when contact details were captured, else `continue` | same as above |
| conversation already human-owned at turn start | `transfer` or `callback_requested` (never the "a teammate is joining" line) | `continue` with the reply text; the page shows the human-owned state |
| otherwise | `continue` | `continue` |

`end` is reserved for an explicit routine ending that says the session is complete; not in the demo.

## 5a. Transports

Both transports reach the same port through the same adapters; only outcome derivation (above) and the booth setup differ.

- **Web voice** (primary for the demo): the vendor's browser SDK or widget on a page, microphone in, audio out, bound to the same agent and the same completions adapter. No telephony, no number, no carrier. A "Talk" launcher inside the Radioso website embed is a later addition: the embed would only need the vendor session URL as a setting.
- **Phone** (optional, same channel): a number or SIP trunk on the vendor side pointing at the same agent. Adds `callerId` and the `transfer` outcome. Can be switched on later without touching the domain.

## 6. Agent settings (`voice` block)

| Key | Type | Notes |
|---|---|---|
| `enabled` | boolean | off by default |
| `bridgeLines` | `Record<locale, { acknowledge: string[]; check: string[] }>` | operator-authored; LLM-drafted default offered at setup |
| `fallbackLine` | `Record<locale, string>` | spoken when the turn limit fires |
| `transfer.target` | string | E.164 number or SIP URI; the only source of a transfer destination |
| `transfer.hours` | optional schedule | outside hours → callback instead of transfer; Phase 0 |

Bridge delay and turn limit are composition constants, not settings. The block is settings-as-data (spec 079).

Operators edit it in the **Voice** card on the agent's Channels → API page (`frontend/components/dashboard/settings/voice-channel-card.tsx`), which saves `voice` and the agent's `mechanicsReplies` block together through `PUT /api/v1/agents/:agentId`, each replaced whole. The card states one rule inline: a bridge or fallback line is one full sentence of at least `ELEVENLABS_MIN_RELEASABLE_SENTENCE_CHARS` characters (45, exported from `voiceChannel/public.ts` and read by the `elevenlabs` dialect), the shortest first sentence that dialect speaks before the answer arrives. It warns under a shorter line without blocking the save, since other dialects have no floor. The frontend mirrors the number in `frontend/lib/voice-settings-form.ts`, and `tests/unit/voice-channel-dialects.test.ts` pins the mirror to the export.

Ray's descriptors: both blocks are entries of `agentInputFieldSchemas` and of `agentReviewedSettingsPatchSchema` (`backend/src/modules/agents/agentInputSchema.ts`), so `propose_agent_setting` (`settingKey: "voice"` or `"mechanicsReplies"`) and `prepare_agent_settings` carry each as a whole-block, live, reach-neutral change. Both descriptions carry `agentSettingWholeBlockNote` (`operatorCopilot/tools/shared.ts`, which states the same floor from the same export), and `agent_configuration` returns the stored `voice` block beside the portable config so a proposal starts from what is stored.

## 7. Conversation record

- `sourceChannel: "voice"`, `callerKind: "human"`.
- `channelContext: { provider: "voice", vendor, sessionKey, transport, callerId? }` as a new member of the `ConversationChannelContext` union, following the `email` precedent.
- `voice_sessions (agent_id, vendor, session_key) → conversation_id`, unique on the triple, mirroring the email thread table.
- A reply the caller spoke over is stored whole once it finished. How much of it the caller heard is marked on the message (`metadata_json.interruption`, written through chat's `ReplyInterruptionMarker` and read back by history as the assistant message's `interruption: { heardCharacterCount, spokenCharacterCount }`) and recorded as a `voice.reply_interrupted` audit note on that reply; the Inbox shows the reply with an Interrupted badge. A reply cut off while it was still streaming is not stored: the conversation keeps the caller's message without a reply.

## 8. Vendor matrix

| Vendor | Adapter | Session key | Interruption signal | Transfer | Confirm in vendor test |
|---|---|---|---|---|---|
| ElevenLabs Agents | `openai-completions`, dialect `elevenlabs` (sends a space plus a zero-width space after each sentence piece so speech starts without waiting for the next chunk) | `elevenlabs_extra_body.session_key`, minted by the client at session start | no HTTP abort; the next request for the same session arrives while the previous turn may still stream, and its replayed history carries the interrupted reply truncated to what was heard (source of `heardUntil`) | `transfer_to_number` tool call | confirmed 2026-10-12 in text mode; audio floor pending |
| Vapi | `openai-completions`, dialect `vapi` | call object in the request body | HTTP abort | vendor transfer tool | body field names, tool names |
| LiveKit Agents, Pipecat, Deepgram Voice Agent | `openai-completions`, dialect `generic` | header set by our own runtime config | HTTP abort | function we define | none; we control both ends |
| Twilio ConversationRelay | `twilio-conversation-relay` (WebSocket) | `setup` message call sid | `interrupt` message with `utteranceUntilInterrupt` → `heardUntil` | end session with handoff data, then TwiML dial | message schema versions |
| Retell | `retell` (WebSocket) | handshake call id | protocol event | protocol tool call | protocol names |
| Radioso-owned runtime (Phase 2) | `openai-completions` `generic`, or a native adapter | ours | ours | ours | — |

The demo ships the `openai-completions` adapter with the `elevenlabs` and `generic` dialects. Choosing ElevenLabs for the booth is a configuration choice that can change without touching the domain.
