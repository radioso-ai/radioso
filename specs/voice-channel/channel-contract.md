# Voice channel contract (vendor-neutral)

Date: 2026-10-12 · Companion: [plan.md](plan.md), [proposal.md](proposal.md)

The voice channel is a Radioso-owned domain with a narrow port. Vendors are adapters that bind that port to a wire. ElevenLabs is the first adapter configuration, not the shape of the channel.

## 1. What each layer knows

| Layer | Knows | Must not know |
|---|---|---|
| **Voice channel domain** (`backend/src/modules/voiceChannel/`) | a session is a call or browser voice session tied to one conversation; an utterance is one finished transcript; a reply is speakable text delivered in sentence-sized pieces; a turn can be bridged, time-limited, interrupted, and ends in a typed outcome; the agent's voice settings | any vendor's field names, tool names, SSE or WebSocket framing, audio |
| **Vendor adapters** (`voiceChannel/adapters/*`) | one wire protocol and its dialects: where the session key travels, how tools are named, how the vendor signals interruption; or one vendor's session-start API (`adapters/elevenlabs/`: the signed-URL request, its header and its validity) | planning, retrieval, routines, settings semantics, persistence, where the vendor key is stored |
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

What the port does inside, in order: resolve or create the conversation for `(agentId, vendor, sessionKey)`; reserve usage with `surface: "voice"`; start the chat turn with `sourceChannel: "voice"` and a `channelContext` of provider `voice`; apply the turn policy (section 4) over the chat event stream; derive the outcome from the reply envelope (section 5). A newer request of the same session is the interruption: the newest utterance wins, the turn in flight is superseded even mid-reply, one superseded before its reply started leaves no user message, and one superseded mid-reply keeps, as its reply, the sentences the caller heard whole, by the newer request's `heardUntil` (chat asks the turn through the request's `deliveredReply` and stores that part marked `partial`). An identical utterance after a reply the caller lost hears the stored answer again, and `heardUntil` marks the stored reply as interrupted (the message's `interruption` field in history: heard and spoken character counts) and is recorded as a `voice.reply_interrupted` audit note.

## 3. The adapter contract

```ts
interface VoiceVendorAdapter {
  id: string;                                    // "openai-completions" | "twilio-conversation-relay" | "retell" | ...
  mount(router: Router, deps: { turns: VoiceTurnPort; auth: AgentChannelAuth; dialects: DialectRegistry }): void;
}
```

An adapter translates in both directions and nothing else:

- **Inbound**: authenticate with the existing agent-channel grant; extract `sessionKey`, `utterance`, `locale` (the session's), `turnLanguage` (the turn's own, when the request reports one), `callerId` and `heardUntil`; build `VoiceTurnInput`; fire the port's `hungUp` signal when the runtime closes the request before the outcome was sent.
- **Outbound**: render `bridge` and `speech` events on the vendor's wire; render `outcome` as the vendor's command or tool call; honour the vendor's abort as `signal` cancellation.

Adapters are registered in composition. Promoting the contract into `packages/connector-api` beside `ConnectorPlugin` is a Phase 0 decision; the demo keeps it in the module.

### Dialects

Several vendors share one wire but differ in field and tool names. A dialect is data, not code:

```ts
interface CompletionsDialect {
  id: "elevenlabs" | "vapi" | "generic";
  sessionKeyFrom: { header?: string; bodyPath?: string };   // e.g. bodyPath "elevenlabs_extra_body.session_key", minted by the client at session start
  localeFrom: { header?: string; bodyPath?: string };       // the session's language, e.g. "elevenlabs_extra_body.locale"
  turnLocaleFrom: { languageSwitch?: { tool: string; argument: string; result: { field: string; success: string; errorFlag: string } };
                    field?: { header?: string; bodyPath?: string } };
                                                            // one turn's language: the newest switch a vendor tool made in the replayed history, or a per-turn field
  callerIdFrom?: { bodyPath?: string };
  tools: { transfer: string; end?: string };                // the vendor's own tool names, e.g. "transfer_to_number", "end_call"
}
```

The adapter echoes the vendor's tool name exactly as it appeared in the request's `tools` array; the dialect only says which one means transfer.

On `elevenlabs`, Radioso calls none of the runtime's tools, so a call keeps its starting language and its lines follow the session locale. A turn's language is structured data, never guessed from the utterance, and this is what the adapter reads when a request reports one. On `elevenlabs`: the `language` argument of the newest `language_detection` call (the vendor's system tool that switches the call's voice and transcription, https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/language-detection) in an assistant message's `tool_calls`, paired with the nearest `role: "tool"` result after it with its `tool_call_id`; a result object reads as the vendor's system tool result (`is_error`, `status: "success"`; the conversation API's `LanguageDetectionToolResultModel`), a plain-text result as the error the vendor gives for a refused switch. A refused switch is skipped and the one before it stands; the first switch the search cannot read (no result, a result object of another shape or unparseable JSON, arguments without a tag) ends it with no turn language and `unreadable`. A request whose newest message is a `tool` result is the runtime's follow-up after a tool call, not a turn: the adapter answers it with an empty completion (`stop`, outcome `continue`) and runs nothing. On `generic`: the `X-Radioso-Voice-Turn-Locale` header, then `metadata.turn_locale`, always this request's own. The source is `vendor_detected` or `turn_field`, and `VoiceTurnInput.turnLanguageIsNew` says whether it is news on the request (a per-turn field, or a switch after the caller's previous utterance); `languageReport` (`blocked`, `unreadable`) names a newest switch that was not taken. The cut-off reply (`heardUntil`) is the assistant message said right before the newest user message, past any tool result or tool-call-only assistant message between them.

## 4. Turn policy (vendor-neutral, pure)

Implemented as wrappers over `AsyncIterable<ChatStreamEvent>`, like the existing disconnect-ceiling wrapper, with fake-timer tests.

| Rule | Behaviour | Source of truth |
|---|---|---|
| Sentence pieces | `chunk` text is re-cut at sentence boundaries into `speech` events; the final piece carries `last: true` | composition constant |
| Bridge | one `bridge` event from the agent's authored lines when the turn starts searching, 400 ms after it starts composing with no speech yet, or after 2.5 s with no phase at all (so a planner quick reply, up to about 2 s, never gets a bridge; only a stalled planner reaches it); style by routine state (acknowledgement inside a routine, check outside), language from the turn's own report, else the session's locale, else the agent default, else `en`; none on a turn whose conversation is human-owned at turn start, so chat's waiting message comes alone | agent settings `voice.bridgeLines`; composition constants |
| Turn limit | on a turn the agent owns, no `speech` within 10 s → `speech` with the authored fallback line, then `outcome: continue` (`callback_requested` after the limit needs a callback path, Phase 0); a turn whose conversation is human-owned at turn start has no limit, so chat's waiting message is never talked over. 10 s, not 8: at 8 s the limit cut off about one grounded turn in fifteen in local sessions, and the `elevenlabs` keep-alive holds the stream through the wait | agent settings `voice.fallbackLine`; composition constant |
| Interruption | a new request for a session whose turn is still in flight cancels that turn even after emission started (the chat lease's `latest_input_wins` mode); one still setting up ends before its chat turn starts; a turn cancelled before emission leaves no user message; one cancelled after keeps it and stores the reply's whole sentences the caller heard, as the composer wrote them: by the newer request's `heardUntil` (the runtime's record of what it played), else every sentence that reached the runtime on a streamed response before the newer request arrived; marked `interruption: { heardCharacterCount, spokenCharacterCount, partial: true }` and audited as `voice.reply_interrupted` in the same transaction, or no reply when no sentence was heard whole (a response with `stream: false` reaches the runtime only at its outcome, so it stores none); a hang-up alone cancels nothing, so the turn stores its whole reply unmarked, or nothing if the post-disconnect ceiling aborts it; a teammate's reply counts as spoken once its turn's outcome reached the runtime, or once the newer request's `heardUntil` shows it played to its end, and goes back to pending otherwise for the turn that cut in; a bridge never follows a superseded turn's bridge within `bridgeAfterMs`; an identical utterance within 30 s of a hung-up or overtaken turn with a stored whole answer replays that answer (a stored heard part is not replayed: the utterance runs a new turn); `heardUntil` (the truncated reply in replayed history) marks the stored reply as interrupted (heard and spoken character counts, the message's `interruption` field) and is recorded as `voice.reply_interrupted` | turn lease cancellation mode, in-process session memory (PR 4), chat's `ReplyInterruptionMarker` port and `DeliveredReplyReader` (asked by `recordSupersession`, stored through the `CutReplyStore` port) |
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
| conversation already human-owned at turn start | `transfer` or `callback_requested` (never the "a teammate is joining" line) | `continue`; the speech is the teammate's pending Inbox replies, else chat's waiting line (silence once a teammate has written); the page shows the human-owned state |
| otherwise | `continue` | `continue` |

`end` is reserved for an explicit routine ending that says the session is complete; not in the demo.

A teammate's Inbox reply reaches a web call on the caller's next completions request; there is no push channel. Chat stores it as pending speech and owns the one port the voice channel uses, `OperatorReplySpeechClaims`: `claimPendingOperatorReplies({ workspaceId, conversationId, claimTurnId })` claims and reads the pending replies in one conditional UPDATE (→ `[{ messageId, text }]`, oldest first; a claim past `VOICE_BEHAVIOR.operatorReplyClaimExpiryMs` counts as pending), and `markOperatorRepliesSpoken`, `skipOperatorReplies` and `releaseOperatorReplies` settle what the turn still holds; composition's `operatorRepliesSpoken` note audits `voice.operator_reply_spoken` with the marked ids. The turn (`services/operatorReplySpeaker.ts`) speaks the replies (as speech text) ahead of chat's answer whoever owns the conversation, so a hand-back needs no special case, and settles them as its outcome leaves: spoken when the outcome left before the turn was cut off, otherwise back to pending; a newer request of the session on the same instance takes over the claim of the turn it overtook before that turn's outcome left. The outcome is derived from chat's `done` as above; a human-owned turn that spoke them ends `continue`.

## 5a. Transports

Both transports reach the same port through the same adapters; only outcome derivation (above) and the booth setup differ.

- **Web voice** (primary for the demo): the vendor's browser SDK or widget on a page, microphone in, audio out, bound to the same agent and the same completions adapter. No telephony, no number, no carrier. The page either opens the session itself or asks Radioso to: `POST /api/v1/public/chat/:token/voice/sessions` (cross-origin through the frontend proxy `/api/public/chat/:token/voice/sessions`), behind the website embed's public session and only for that channel, returns `{ vendor, signedUrl, sessionKey, locale, expiresAt? }`. `VoiceSessionStartService` reads the agent's `voice.enabled` and `voice.runtime`, reads the workspace's key for that vendor through the `VoiceVendorCredentialReader` port (composition: the workspace credential store's `getApiKey`, with no deployment fallback), mints the session key and records it with the visitor's public session and visitor key through `VoiceSessionStartRegistry` (a `voice_sessions` row with no conversation yet, until a 60-minute expiry that outlives the signed URL's 15 minutes), then asks the vendor's `VoiceSessionStarter` port (`startSession({ vendorAgentId, region, credential })` → `{ signedUrl, expiresAt? }`; one adapter per vendor, composed with `fetch`). The vendor key never leaves the backend; the signed URL is a bearer credential for its 15 minutes; the session key is a correlation handle the first turn uses to join the website visitor. Every failure past the agent's settings is one `503 voice_unavailable` to the visitor. Starts spend per-session, per-source and per-workspace budgets before the vendor call. A "Talk" launcher inside the Radioso website embed calls the same start.
- **Phone** (optional, same channel): a number or SIP trunk on the vendor side pointing at the same agent. Adds `callerId` and the `transfer` outcome. Can be switched on later without touching the domain.

## 6. Agent settings (`voice` block)

| Key | Type | Notes |
|---|---|---|
| `enabled` | boolean | off by default |
| `bridgeLines` | `Record<locale, { acknowledge: string[]; check: string[] }>` | operator-authored; LLM-drafted default offered at setup |
| `fallbackLine` | `Record<locale, string>` | spoken when the turn limit fires |
| `runtime` | `{ vendor: "elevenlabs"; agentId: string; region: "us" \| "eu" \| "in" \| "sg" } \| null` | the vendor agent a Radioso-started session opens; `agentId` is the vendor's own id (1 to 128 of `[A-Za-z0-9_-]`), `region` the vendor account's data residency region (default `us`; the adapter maps it to the vendor host), and any other key is refused; `null` binds none and is the default. A session start needs it and `enabled`. A written or stored block without the key reads as `null` |
| `transfer.target` | string | E.164 number or SIP URI; the only source of a transfer destination |
| `transfer.hours` | optional schedule | outside hours → callback instead of transfer; Phase 0 |

Bridge delay and turn limit are composition constants, not settings. The block is settings-as-data (spec 079).

Lines are keyed by language tag and picked in the turn's language: the turn language the request reports (§3), else the session's locale, else the agent's `assistantDefaultLocale`, else `en` (`languageSource`: `vendor_detected`, `turn_field`, `session`, `agent_default`, `builtin_default`). The first present wins, and the lines match it by full tag, then primary subtag, then any tag of the same language. The bridge is in that language or silent, and so is the fallback line, except on a turn that reports its own language, where the fallback line is the first written for the turn language, the session's, the agent default or `en`, in that order. The turn language reaches chat as the turn's `userExpectedLocale` only when it is news on the request; the session locale and a switch an earlier turn made do not, so a caller who moves on is answered in the language they speak. No setting governs mid-call language, and the turn language is never stored. On `elevenlabs` no switch reaches the history while the adapter calls no tools, so the lines follow the session locale. `recordingNotice` is chosen at the session start and follows the session's locale.

Operators edit it in the **Voice** card on the agent's Channels → API page (`frontend/components/dashboard/settings/voice-channel-card.tsx`), which saves `voice` and the agent's `mechanicsReplies` block together through `PUT /api/v1/agents/:agentId`, each replaced whole. Its **Runtime** section edits `runtime` (vendor select, vendor agent id; a blank id saves `null`). The vendor's API key is a workspace credential, not part of the block: **Settings → Providers → Voice runtime keys** writes it through `PUT /api/v1/settings/credentials/elevenlabs`. The card states one rule inline: a bridge or fallback line is one full sentence of at least `ELEVENLABS_MIN_RELEASABLE_SENTENCE_CHARS` characters (45, exported from `voiceChannel/public.ts` and read by the `elevenlabs` dialect), the shortest first sentence that dialect speaks before the answer arrives. It warns under a shorter line without blocking the save, since other dialects have no floor. The frontend mirrors the number in `frontend/lib/voice-settings-form.ts`, and `tests/unit/voice-channel-dialects.test.ts` pins the mirror to the export.

Ray's descriptors: both blocks are entries of `agentInputFieldSchemas` and of `agentReviewedSettingsPatchSchema` (`backend/src/modules/agents/agentInputSchema.ts`), so `propose_agent_setting` (`settingKey: "voice"` or `"mechanicsReplies"`) and `prepare_agent_settings` carry each as a whole-block, live, reach-neutral change. Both descriptions carry `agentSettingWholeBlockNote` (`operatorCopilot/tools/shared.ts`, which states the same floor from the same export, what `runtime` binds, and that the vendor key is the operator's to enter in Settings: it is on the never-list as `provider_credential_writes`), and `agent_configuration` returns the stored `voice` block beside the portable config so a proposal starts from what is stored.

## 7. Conversation record

- `sourceChannel: "voice"`, `callerKind: "human"`.
- `channelContext: { provider: "voice", vendor, sessionKey, transport, callerId? }` as a new member of the `ConversationChannelContext` union, following the `email` precedent.
- `voice_sessions (agent_id, vendor, session_key) → conversation_id`, unique on the triple, mirroring the email thread table.
- A reply the caller spoke over is stored whole once it finished. How much of it the caller heard is marked on the message (`metadata_json.interruption`, written through chat's `ReplyInterruptionMarker` and read back by history as the assistant message's `interruption: { heardCharacterCount, spokenCharacterCount, partial: false }`) and recorded as a `voice.reply_interrupted` audit note on that reply; the Inbox shows the reply with an Interrupted badge. A reply cut off while it was still streaming is stored as far as the caller heard it: the composer's text of the whole sentences the runtime's `heardUntil` covers (every sentence that reached the runtime when the newer request carries none), cut at each sentence's end in the written text, citation markers and delimiters left open removed, born with `interruption: { heardCharacterCount, spokenCharacterCount, partial: true }` (heard by `heardUntil`, spoken as reached; equal without `heardUntil`) in the same transaction as the turn's cancelled `chat.answer` event (`partialReplyStored: true`) and its `voice.reply_interrupted` audit event; a later `heardUntil` for it changes nothing, and it is never replayed. The Inbox badge on it says only the heard part is stored; Quality leaves it out of its turns and eval capture refuses it. A turn whose caller heard no sentence of the reply whole keeps the caller's message without a reply.
- Recordings stay with the vendor. A Radioso-started session records the vendor agent it opened on and that account's data residency region (`voice_sessions.vendor_agent_id`, `vendor_region`) at the start, and the page that opened it reports the vendor's own id for the call once (`voice_sessions.vendor_conversation_id`, migration 230, unique per vendor and region; accepted only from the public session the start was for, while the start is unexpired, and stored only once the vendor's `describeConversation` names that vendor agent). A row that names a recording outlives its agent and its conversation (`agent_id` and `conversation_id` are `ON DELETE SET NULL`; a session whose conversation is gone binds the next one its turns start), and the next start's cleanup keeps it. Together they name the recording. The domain's `VoiceRecordingSource` port (`describeConversation({ vendorConversationId, region, credential }) → { vendorAgentId }`, `fetchRecording({ vendorConversationId, region, credential, range?, signal? }) → { status, body, contentType, contentLength?, contentRange? }`, `deleteRecording(...) → "deleted" | "already_absent"`) has one adapter per vendor (`adapters/elevenlabs/recordingSource.ts`), on the same region host table as the session starter. The conversation detail tells a dashboard session `recording: { available }` from these records alone; `GET /api/v1/conversations/:conversationId/recording` streams the audio and audits each play as `conversation.recording_played`; conversation, visitor, workspace and organization deletion erase the vendor's copy through the shared `VendorHeldConversationDataEraser` port (`shared/domain/conversationDataErasure.ts`; the privacy module's erasure reads and locks the rows in its own transaction before its erasers run, a visitor's erasure by the visitor's key too, and the `voice-channel` eraser then removes the rows; a read that fails fails the erasure), auditing `conversation.recording_deleted`. A conversation deleted some other way leaves the row, with its conversation link cleared, for the workspace's deletion.

## 8. Vendor matrix

| Vendor | Adapter | Session key | Interruption signal | Transfer | Confirm in vendor test |
|---|---|---|---|---|---|
| ElevenLabs Agents | `openai-completions`, dialect `elevenlabs` (sends a space plus a zero-width space after each sentence piece so speech starts without waiting for the next chunk) | `elevenlabs_extra_body.session_key`, minted by Radioso's session start or by the page that starts the session | no HTTP abort; the next request for the same session arrives while the previous turn may still stream, and its replayed history carries the interrupted reply truncated to what was heard (source of `heardUntil`) | `transfer_to_number` tool call | confirmed 2026-10-12 in text mode; audio floor pending |
| Vapi | `openai-completions`, dialect `vapi` | call object in the request body | HTTP abort | vendor transfer tool | body field names, tool names |
| LiveKit Agents, Pipecat, Deepgram Voice Agent | `openai-completions`, dialect `generic` | header set by our own runtime config | HTTP abort | function we define | none; we control both ends |
| Twilio ConversationRelay | `twilio-conversation-relay` (WebSocket) | `setup` message call sid | `interrupt` message with `utteranceUntilInterrupt` → `heardUntil` | end session with handoff data, then TwiML dial | message schema versions |
| Retell | `retell` (WebSocket) | handshake call id | protocol event | protocol tool call | protocol names |
| Radioso-owned runtime (Phase 2) | `openai-completions` `generic`, or a native adapter | ours | ours | ours | — |

The demo ships the `openai-completions` adapter with the `elevenlabs` and `generic` dialects. Choosing ElevenLabs for the booth is a configuration choice that can change without touching the domain.
