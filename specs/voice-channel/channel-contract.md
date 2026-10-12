# Voice channel contract (vendor-neutral)

Date: 2026-10-12 · Companion: [plan.md](plan.md), [proposal.md](proposal.md)

The voice channel is a Radioso-owned domain with a narrow port. Vendors are adapters that bind that port to a wire. ElevenLabs is the first adapter configuration, not the shape of the channel.

## 1. What each layer knows

| Layer | Knows | Must not know |
|---|---|---|
| **Voice channel domain** (`backend/src/modules/voiceChannel/`) | a session is a call or browser voice session tied to one conversation; an utterance is one finished transcript; a reply is speakable text delivered in sentence-sized pieces; a turn can be bridged, time-limited, interrupted, and ends in a typed outcome; the agent's voice settings | any vendor's field names, tool names, SSE or WebSocket framing, audio |
| **Vendor adapters** (`voiceChannel/adapters/*`) | one wire protocol and its dialects: where the session key travels, how tools are named, how the vendor signals interruption | planning, retrieval, routines, settings semantics, persistence |
| **Chat service** | nothing new except the `sourceChannel` literal and, for interruption, a cancellation mode on the turn lease | that voice exists |

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
  interruptsPrevious?: boolean;   // the caller spoke over the agent; cancel the in-flight turn
  heardUntil?: string;            // the agent text the caller actually heard before interrupting, when the vendor reports it
}

type VoiceTurnEvent =
  | { type: "conversation"; conversationId: string } // first, so adapters can name the conversation before any speech
  | { type: "bridge"; text: string }                 // authored line, emitted by policy while the brain works
  | { type: "speech"; text: string; last: boolean }  // speakable piece of the agent's reply, verbatim
  | { type: "outcome"; outcome: VoiceTurnOutcome }   // exactly one, always last
  | { type: "interrupted"; deliveredText: string };  // the turn was cancelled; what history will store

type VoiceTurnOutcome =
  | { kind: "continue" }
  | { kind: "transfer"; target: string }   // from agent settings only, never from the model
  | { kind: "end" }
  | { kind: "callback_requested" };

interface VoiceTurnPort {
  runTurn(input: VoiceTurnInput, signal: AbortSignal): AsyncIterable<VoiceTurnEvent>;
}
```

What the port does inside, in order: resolve or create the conversation for `(agentId, vendor, sessionKey)`; reserve usage with `surface: "voice"`; start the chat turn with `sourceChannel: "voice"` and a `channelContext` of provider `voice`; apply the turn policy (section 4) over the chat event stream; derive the outcome from the reply envelope (section 5); persist the interruption marker when cancelled.

## 3. The adapter contract

```ts
interface VoiceVendorAdapter {
  id: string;                                    // "openai-completions" | "twilio-conversation-relay" | "retell" | ...
  mount(router: Router, deps: { turns: VoiceTurnPort; auth: AgentChannelAuth; dialects: DialectRegistry }): void;
}
```

An adapter translates in both directions and nothing else:

- **Inbound**: authenticate with the existing agent-channel grant; extract `sessionKey`, `utterance`, `locale`, `callerId`, interruption signals; build `VoiceTurnInput`.
- **Outbound**: render `bridge` and `speech` events on the vendor's wire; render `outcome` as the vendor's command or tool call; honour the vendor's abort as `signal` cancellation.

Adapters are registered in composition. Promoting the contract into `packages/connector-api` beside `ConnectorPlugin` is a Phase 0 decision; the demo keeps it in the module.

### Dialects

Several vendors share one wire but differ in field and tool names. A dialect is data, not code:

```ts
interface CompletionsDialect {
  id: "elevenlabs" | "vapi" | "generic";
  sessionKeyFrom: { header?: string; bodyPath?: string };   // e.g. bodyPath "elevenlabs_extra_body.conversation_id"
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
| Bridge | no `speech` within 900 ms → one `bridge` event from the agent's authored lines, style by routine state (acknowledgement inside a routine, check outside), locale from the input or the agent default | agent settings `voice.bridgeLines` |
| Turn limit | no `speech` within 8 s → `speech` with the authored fallback line, then `outcome: callback_requested` if the agent has a callback path, else `continue` | agent settings `voice.fallbackLine`; composition constant |
| Interruption | `interruptsPrevious` or `signal` aborted → cancel the in-flight turn even after emission started; emit `interrupted` with `heardUntil` when given, else the text delivered so far | turn lease cancellation mode (PR 4) |
| Governance gates | unchanged; the coverage head and grounding gate run before any `speech` | chat service |

## 5. Outcome derivation

Outcomes depend on the transport, because a hand-off means different things on a phone line and in a browser.

| Reply envelope | `phone` | `web` |
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

Bridge delay and turn limit are composition constants, not settings. The block is settings-as-data (spec 079) and ships a Ray tool descriptor or a stated coverage-map exclusion.

## 7. Conversation record

- `sourceChannel: "voice"`, `callerKind: "human"`.
- `channelContext: { provider: "voice", vendor, sessionKey, transport, callerId? }` as a new member of the `ConversationChannelContext` union, following the `email` precedent.
- `voice_sessions (agent_id, vendor, session_key) → conversation_id`, unique on the triple, mirroring the email thread table.
- Interrupted replies are stored as delivered with an `interrupted` marker that history rendering shows.

## 8. Vendor matrix

| Vendor | Adapter | Session key | Interruption signal | Transfer | Confirm in vendor test |
|---|---|---|---|---|---|
| ElevenLabs Agents | `openai-completions`, dialect `elevenlabs` | `elevenlabs_extra_body` field | undocumented; expect HTTP abort | `transfer_to_number` tool call | abort behaviour, exact extra-body field names |
| Vapi | `openai-completions`, dialect `vapi` | call object in the request body | HTTP abort | vendor transfer tool | body field names, tool names |
| LiveKit Agents, Pipecat, Deepgram Voice Agent | `openai-completions`, dialect `generic` | header set by our own runtime config | HTTP abort | function we define | none; we control both ends |
| Twilio ConversationRelay | `twilio-conversation-relay` (WebSocket) | `setup` message call sid | `interrupt` message with `utteranceUntilInterrupt` → `heardUntil` | end session with handoff data, then TwiML dial | message schema versions |
| Retell | `retell` (WebSocket) | handshake call id | protocol event | protocol tool call | protocol names |
| Radioso-owned runtime (Phase 2) | `openai-completions` `generic`, or a native adapter | ours | ours | ours | — |

The demo ships the `openai-completions` adapter with the `elevenlabs` and `generic` dialects. Choosing ElevenLabs for the booth is a configuration choice that can change without touching the domain.
