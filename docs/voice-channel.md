---
title: "Voice Channel"
description: "Let a voice runtime such as ElevenLabs Agents speak for a Radioso agent through an OpenAI-compatible chat-completions endpoint, with one conversation per voice session and authored lines that cover the wait."
last_updated: 2026-10-14
---

# Voice Channel

The voice channel lets people talk to a Radioso agent out loud. A voice
runtime — ElevenLabs Agents, or a runtime you run yourself — handles the
microphone, speech recognition and the synthesized voice. Radioso is the
agent behind it: every finished thing the caller says becomes one agent turn,
grounded in the workspace's documents and steered by its directives and
routines, and the reply streams back a sentence at a time so the runtime can
start speaking before the whole answer is written.

The runtime reaches Radioso the way it would reach any custom LLM: an
OpenAI-compatible chat-completions endpoint. Each voice session becomes one
Radioso conversation, so the whole call reads like any other conversation in
Activity and the Inbox.

## How a turn works

1. The caller finishes speaking, and the runtime posts a chat-completions
   request with the call so far in `messages`.
2. Radioso reads the session key from where the runtime's dialect puts it
   and finds the session's conversation, or starts one on the session's first
   turn.
3. The last `user` message is the utterance. The earlier messages, including
   the runtime's own system prompt, are its replay of the call; the
   conversation already holds that history and the agent has its own
   instructions, so Radioso reads only the last one, plus, on the `elevenlabs`
   dialect, how much of the previous reply the caller heard (see
   [When the caller talks over the agent](#when-the-caller-talks-over-the-agent)).
4. The agent runs its turn. The reply comes back as `chat.completion.chunk`
   frames, one sentence per frame, ending with `finish_reason: "stop"` and
   `data: [DONE]`.
5. If you turned the agent's voice settings on, the wait is covered: when
   the agent starts looking something up, or is slow to start its answer, the
   caller hears one of your bridge lines, and when nothing is ready at 10
   seconds, they hear your fallback line and the turn ends. See
   [Bridge lines and the turn limit](#bridge-lines-and-the-turn-limit).
6. The turn ends with an outcome: `continue`, or `callback_requested` when the
   turn handed the caller to your team after a routine collected their
   details. See [Outcomes](#outcomes).

## Set it up

You need an agent and a REST credential for it.

1. Open the agent's **Channels → API** card and create a REST credential.
   Copy the secret before you close the result; Radioso stores only its hash.
2. Point the runtime's custom LLM at the endpoint for your dialect. OpenAI
   clients, ElevenLabs included, append `/chat/completions` to the URL you
   configure, so the configured URL ends in `/v1`:

   ```text
   https://api.radioso.ai/api/v1/agents/<agent-id>/voice/<dialect>/v1
   ```

   Requests then arrive at `…/voice/<dialect>/v1/chat/completions`. Use
   `https://api-us.radioso.ai` or your own self-hosted origin instead,
   matching the host where you created the credential.
3. Give the runtime the credential secret as its API key. It arrives as
   `Authorization: Bearer <secret>`.
4. Make the runtime send one session key per call, where the dialect below
   reads it. A request without one gets `400`.

The agent id in the path must match the credential's agent. A credential for
another agent, an MCP-audience credential, a personal token or a
service-account credential gets `401`.

### ElevenLabs

ElevenLabs Agents uses the `elevenlabs` dialect. Three things connect it to a
Radioso agent: the URL and the credential on the ElevenLabs agent, and a
session key from the page that starts each session.

**The URL.** Set the custom LLM URL to
`https://api.radioso.ai/api/v1/agents/<agent-id>/voice/elevenlabs/v1`.

**The credential.** ElevenLabs sends the value of one of its workspace
secrets as the bearer. Create a secret holding the Radioso credential with
`POST /v1/convai/secrets`:

```json
{ "type": "new", "name": "radioso-agent-credential", "value": "<radioso-credential-secret>" }
```

Then reference it from the agent as
`conversation_config.agent.prompt.custom_llm.api_key`:

```json
{ "secret_id": "<secret-id>" }
```

An agent with no secret sends `Authorization: Bearer not_provided`, which
Radioso answers with `401`.

**The session key.** ElevenLabs sends no conversation id of its own, so the
page that starts the session mints one and passes it in the custom LLM extra
body. Allow that on the agent with
`platform_settings.overrides.custom_llm_extra_body: true`, then start each
session with a fresh key:

```js
import { Conversation } from '@elevenlabs/client'

const conversation = await Conversation.startSession({
  agentId: '<elevenlabs-agent-id>',
  customLlmExtraBody: { session_key: crypto.randomUUID(), locale: 'it' },
})
```

`locale` is optional. It tells Radioso which language the caller speaks, so
bridge and fallback lines come in that language; leave it out and the agent's
default locale applies.

Over the WebSocket API, send the same object as `custom_llm_extra_body` in
the `conversation_initiation_client_data` message. ElevenLabs then sends it
on every turn of the session as `elevenlabs_extra_body`, and Radioso reads
`elevenlabs_extra_body.session_key`. Mint the key in the page: a dynamic
variable such as `{{system__conversation_id}}` inside the extra body arrives
as that literal text, which would put every call in one conversation.
Radioso answers a session key that is a whole `{{…}}` placeholder with `400`.

## Bridge lines and the turn limit

On a call, silence sounds like a dropped line. A grounded answer can take a
second or two to start, so you give the agent a few short lines to say while
it works, and one line to say if the answer takes far too long. They live in
the agent's `voice` settings block:

```json
{
  "voice": {
    "enabled": true,
    "bridgeLines": {
      "en": {
        "acknowledge": ["Got it.", "Thanks, noted."],
        "check": ["Let me check that for you.", "One moment, I'm looking it up."]
      },
      "it": {
        "acknowledge": ["Perfetto.", "Grazie, preso nota."],
        "check": ["Controllo subito.", "Un attimo, sto verificando."]
      }
    },
    "fallbackLine": {
      "en": "Sorry, that is taking longer than it should. Could you ask me again?",
      "it": "Scusa, ci sto mettendo troppo. Puoi ripetere la domanda?"
    }
  }
}
```

Set it with the agent settings API, using a personal token or a
service-account credential from **Settings → API access**:

```bash
curl -sS -X PUT \
  "https://api.radioso.ai/api/v1/agents/<agent-id>" \
  -H "Authorization: Bearer <personal-token>" \
  -H "Content-Type: application/json" \
  -d @voice.json
```

where `voice.json` holds the object above. `GET /api/v1/agents/<agent-id>`
returns the block as `voice`. The dashboard has no editor for it; saving other
agent settings from the dashboard leaves it as it is.

The block is replaced whole: a request that carries `voice` must carry
`enabled`, `bridgeLines` and `fallbackLine`, and a request without `voice`
keeps the stored one. To turn voice off, send the block back with
`"enabled": false`. Keys are language tags such as `en`, `it` or `pt-BR`, up
to 10 for each map. Each style holds up to 5 lines, and every line is 1 to 200
characters. A new agent starts with `"enabled": false` and empty maps.

What happens on a turn while `enabled` is true:

- **Bridge.** The bridge fires when the turn starts searching, 400 ms after
  it starts composing without speech, or after 2.5 s with no phase at all.
  Searching means the agent is looking the answer up in your documents, which
  always takes a few seconds; a short reply such as "Hi!" starts speaking well
  inside the 400 ms, so it is never preceded by a bridge. The 2.5 s case is
  for a planner that stalls: a greeting the planner answers itself takes up
  to about 2 seconds, and a knowledge question bridges as soon as the search
  starts. The caller hears one
  bridge line per turn at most, and none once the reply has started speaking.
  Once a person owns the conversation, no bridge line plays (see
  [Outcomes](#outcomes)).
  A turn that replaces one whose bridge line went out less than 2.5 s earlier
  speaks none, so bridges never stack.
  Inside a running routine (the
  agent has just asked the caller something and is taking in the answer) it
  is an `acknowledge` line; otherwise a `check` line. Lines rotate across
  turns. The rotation is shared by every call one Radioso server handles, so
  when calls run at the same time a caller can hear the same line twice in a
  row. Then the reply follows as usual.
- **Turn limit, at 10 seconds.** If the agent's reply still has not started
  speaking 10 seconds into the turn, the caller hears the fallback line and the
  turn ends, so the runtime listens for the caller again. The agent's reply
  finishes in the background and is stored in the conversation. The limit
  covers the agent's own answers: once a person owns the conversation, the
  caller hears the short waiting line however long it takes to write.
- **Language.** The lines come in the caller's language: the locale the request
  carries (see the dialect table), else the agent's default locale, else `en`.
  A line keyed `it` serves `it-IT` and `it-CH`; an exact tag such as `pt-BR`
  wins over a bare `pt`. With no line for that language and style, the caller
  hears nothing extra. With no fallback line for the language, the turn keeps
  waiting for the reply past 10 seconds.

The 400 ms, 2.5 second and 10 second marks are the same for every agent. They follow from
how long a caller tolerates silence, not from what an agent says, so they are
not settings. The limit sits at 10 seconds because slow grounded answers
reach 8 seconds on about one turn in fifteen, and by then the caller has heard
a bridge line; on the `elevenlabs` dialect the keep-alive holds the stream open
through the wait.

Bridge lines are spoken, never stored: the conversation in Activity and the
Inbox shows the caller's words and the agent's reply, the way a chat
conversation never shows its typing indicator. After a turn limit, the stored
reply is the agent's full answer, which the caller did not hear; the caller
heard the fallback line.

## When the caller talks over the agent

The newest thing the caller said wins. ElevenLabs keeps a reply's stream open
when the caller speaks over it and sends the new utterance as a new request,
so Radioso cancels the running turn as soon as a newer request of the same
session arrives, even when its reply has started speaking. The cancelled
request's response ends with `finish_reason: "stop"` and `data: [DONE]` after
whatever it had already sent, with no error frame.

What the conversation keeps depends on how far the cancelled turn got:

- **Cancelled before its reply started:** nothing. The caller's message is
  removed and no reply is stored; the audit trail keeps a cancelled
  `chat.answer` event that names the removed message and marks it
  `userMessageDiscarded: true`. This is what happens when the runtime guesses
  the end of a sentence too early and re-sends the longer transcript. Only a
  newer voice request removes the message; any other turn that starts on the
  conversation, such as an operator approving a routine step, cancels the
  turn and keeps it.
- **Cancelled after its reply started:** the caller's message stays and the
  part of the reply the caller heard is not stored. The next turn answers the
  newer utterance with that message in its history.

An unclear word can make the transcriber flap, and ElevenLabs then sends
several requests within a second or two with alternating transcripts. Each
one replaces the one before, so the conversation stores the last transcript
and one answer to it. A request that arrives while the previous one is still
being set up replaces it before its turn starts.

When the runtime loses a reply, because it hung up on the stream before the
reply finished or a newer request overtook it, it can send the same utterance
again a few seconds later. If that happens within 30 seconds and the reply
was stored, the caller hears the stored reply again: no new message in the
conversation, no bridge line, no model call. The audit trail records
`voice.reply_replayed` against the reply. If the reply is still being written
when the same utterance arrives, the new request runs as a new turn and
replaces the running one.

When the caller speaks over a reply that was stored, ElevenLabs replays that
reply in the next request cut short to what was heard, followed by `...`. The
conversation keeps the full reply; the audit trail records
`voice.reply_interrupted` against it, with how many characters the caller
heard (`heardCharacterCount`) and how long the spoken reply was
(`spokenCharacterCount`). A bridge line spoken before the reply does not count
toward either.

## Outcomes

Every turn ends with an outcome that says how the session goes on. On web
voice there are two:

- `continue`: the call goes on with the agent. Most turns end this way.
- `callback_requested`: this turn handed the conversation to your team, and
  the routine that handed off had collected at least one of its slots from the
  caller. Your team has something to follow up with.

Take a booth visitor who asks about pricing. The agent's lead-capture routine
asks for their name and email, and its hand-off end passes the conversation to
your team. That turn's reply is the routine's closing line, and the turn ends
with `callback_requested`. A hand-off with nothing collected ends with
`continue`: a routine whose hand-off end comes before any of its slots is
filled, or a grounded miss on an agent with **Hand off on retrieval miss**
turned on. Any filled slot counts, whatever it is called and whatever it holds,
so the rule works the same in every language. The two hand-off reasons from a
routine count alike: an authored hand-off end and a caller stuck on a step.
See [How handoff is requested](human-takeover.md#how-handoff-is-requested).

Both outcomes end the response the same way, with `finish_reason: "stop"` and
`data: [DONE]`, and the runtime goes on listening. The outcome is for whoever
reads the HTTP response: a page or a test that drives the endpoint itself, or
you with curl. With `stream: false`, it is the `X-Radioso-Voice-Outcome`
response header. A streamed response sends its headers with its first frame,
before the turn has an outcome, so it announces
`Trailer: X-Radioso-Voice-Outcome` and sends the field as an HTTP trailer
after `[DONE]`; `curl -i` prints it below the body:

```text
data: [DONE]

X-Radioso-Voice-Outcome: callback_requested
```

After a hand-off, the call stays open and the conversation is human-owned,
like any other hand-off: it waits in the Inbox, and the hand-off's operator
notice reaches your team. See [Human Takeover](human-takeover.md). What the
caller hears from then on:

- Each new utterance hears the agent's short waiting line, written in the
  conversation's language, until a teammate writes in the conversation; after
  that, the agent stays silent. These turns end with `continue`. No bridge
  line comes before the waiting line and no fallback line cuts in on it:
  both cover the agent's own answers.
- A teammate's reply stays in the conversation and does not reach the call.
  The Inbox offers no Send on a voice conversation, so the follow-up goes
  through the details the routine collected.

## Dialects

Runtimes speak the same OpenAI wire and differ in where they put the id of
the call and the caller's language. The dialect in the path tells Radioso
where to look. Sources are tried in order, and the first non-empty string
wins. A locale that is not a language tag is ignored.

| Dialect | Session key, in order | Locale, in order | Transport |
|---|---|---|---|
| `elevenlabs` | body `elevenlabs_extra_body.session_key` | body `elevenlabs_extra_body.locale` | `web` |
| `generic` | header `X-Radioso-Voice-Session`, then body `metadata.session_key` | header `X-Radioso-Voice-Locale`, then body `metadata.locale` | `web` |

ElevenLabs hands a sentence to speech once the terminator is followed by
whitespace and a later non-blank delta arrives; the dialect sends a space plus
a zero-width space after each sentence piece and bridge line (observed
2026-10-13). The fallback line gets the same. Without it, each sentence would
wait for the next one to start before the caller heard it. The flush travels on
the wire only; the stored reply has none.

ElevenLabs drops a custom-LLM stream that is silent for about 4 s and re-asks
with the same utterance (observed 2026-10-13); the dialect sends an invisible
keep-alive delta every 2.5 s of silence. The keep-alive is the same space plus
zero-width space, it stops at the end of the reply or when the runtime hangs
up, and the stored reply never contains it. The `generic` dialect sends
neither.

ElevenLabs also holds the first sentence of a reply until it has about 45
characters of text (observed 2026-10-13: 26 characters waited for the next
sentence, 46 and 57 did not; invisible padding and two short sentences do not
count). Write every bridge line and fallback line as a full sentence of at
least 45 characters, or the caller hears it only together with the answer.

The session key must name one call. A value that spans calls, such as a
user id, would run every call of that user in one conversation, so no dialect
falls back to one.

Use `generic` for a runtime you control, such as LiveKit Agents or Pipecat:
set the header to your own session id on every request of the session. A
session key is opaque to Radioso and can be up to 256 characters.

## Request

The body is an OpenAI chat-completions request.

| Field | Meaning |
|---|---|
| `messages` | Required. The call so far. The last message with `role: "user"` is the utterance, up to 4,000 characters; its `content` is a string or an array of content parts, of which the `text` parts are read. On `elevenlabs`, an `assistant` message right before the utterance that ends in `...` is read as the part of the previous reply the caller heard. Other earlier messages and the runtime's `system` prompt are ignored. |
| `stream` | `true` for SSE frames, `false` or absent for one JSON object. Voice runtimes send `true`. |
| `model` | Echoed back in every response. Radioso answers with the agent's own model configuration. |
| `tools` | Accepted. Replies carry text only and never call the runtime's tools. |
| `elevenlabs_extra_body`, `metadata` | Read by the dialects above. |

Other fields, such as `temperature`, `max_tokens` and `stream_options`, are
accepted and have no effect.

## Response

With `stream: true`, the response is `text/event-stream`. The first frame
carries the assistant role:

```text
data: {"id":"chatcmpl-…","object":"chat.completion.chunk","created":1760270400,"model":"radioso","choices":[{"index":0,"delta":{"role":"assistant","content":"We open at nine. "},"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","created":1760270400,"model":"radioso","choices":[{"index":0,"delta":{"content":"Do you want the address?"},"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","created":1760270400,"model":"radioso","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

A sentence ends at terminal punctuation followed by whitespace, or at a
full-width terminator such as `。`. A bridge or fallback line arrives as a
content frame like any sentence. Structural assertion markers the composer
uses for citations are removed from speech: `[1]`, `[?]`, `[[1]]` and `[[?]]`,
with the space before them, so "information.[?] If" is spoken as
"information. If". Markdown syntax is removed the same way, by structure:
emphasis (`**`, `__`, and a single `*` or `_` around a word), inline code
backticks, heading and list markers (`#`, `-`, `*`, `1.`) at the start of a
line, and link syntax, which leaves the link text. "la **versione
open-source**" is spoken as "la versione open-source"; hyphens, apostrophes,
decimals, ellipses and a `*` between numbers stay. Leaving out a bridge line
and the `elevenlabs` dialect's flush deltas, the text of the frames joined
together is what the caller hears: the agent's reply as spoken text, or the
fallback line after a turn limit.

With `stream: false`, the response is one `chat.completion` object whose
`choices[0].message.content` is the whole reply, or the fallback line after a
turn limit. It never contains a bridge line.

If the turn fails after the first frame, the stream ends with one error frame
in place of `stop`, `[DONE]` and the outcome trailer:

```text
data: {"error":{"message":"The agent could not finish this reply.","type":"server_error"}}
```

A turn that fails before its first frame answers with an HTTP error status
instead, and so does a failed turn with `stream: false`. A reply that stops
before the turn has its outcome counts as a failed turn, whatever it had
already said.

Both carry an `X-Radioso-Conversation-Id` header with the conversation the
turn ran in, so you can open the call in Activity. On a session's first turn,
a bridge line can open the stream before the conversation exists; that one
response then has no header, and the next turn's has it. The turn's outcome
travels as `X-Radioso-Voice-Outcome`: a header with `stream: false`, a trailer
after `[DONE]` with `stream: true` (see [Outcomes](#outcomes)).

Try it from a terminal with the `generic` dialect. curl gets the full path a
runtime reaches after appending `/chat/completions` to the configured URL:

```bash
curl -sS -i -X POST \
  "https://api.radioso.ai/api/v1/agents/<agent-id>/voice/generic/v1/chat/completions" \
  -H "Authorization: Bearer $RADIOSO_AGENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Radioso-Voice-Session: curl-test-1" \
  -d '{"stream":false,"messages":[{"role":"user","content":"When are you open?"}]}'
```

Send the same `X-Radioso-Voice-Session` again and the next turn continues the
same conversation.

## The conversation record

A voice conversation is stored with `sourceChannel: "voice"` and a channel
context that names the session:

```json
{
  "provider": "voice",
  "vendor": "generic",
  "sessionKey": "curl-test-1",
  "transport": "web"
}
```

`vendor` is the dialect that issued the session key, and a session key is
unique per agent and vendor. The caller is a person, so voice conversations
count as end-user traffic in Activity, Quality and Audience Pulse, the Inbox
shows them as from a caller, and each reply is metered as a customer
conversation reply, like the REST agent channel.

Deleting the conversation also forgets the session: the next request with
that session key starts a new conversation.

## Limits and failure modes

- Voice turns spend the credential's REST agent-channel turn budget: by
  default 30 turns a minute per credential
  (`AGENT_CHANNEL_CHAT_GRANT_RATE_LIMIT_MAX_ATTEMPTS`) and 300 a minute per
  workspace. The credential budget is shared by every call that uses the
  credential at the same time, so five concurrent calls share 30 turns a
  minute. Past it, the runtime gets `429`.
- The newest-utterance rule, the 30-second replay and the bridge rule hold
  within one Radioso instance. Requests of one session that land on different
  instances do not see each other there: a burst of revised transcripts split
  across two instances can store two caller messages, and a re-request that
  lands on another instance runs as a new turn.
- When a newer utterance arrives while a reply is still streaming, the caller
  has heard part of it and the vendor keeps the truncated text, but Radioso
  stores the caller's message with no reply. The Inbox shows an unanswered
  message, and the next turn (including a routine collecting slots) does not
  know what the agent started to say. The cut reply is not billed as an
  answer; its model tokens stay in the usage ledger.
- A request that replaces an unanswered one carries only its own utterance.
  When the runtime's newer transcript does not repeat the caller's earlier
  words, the agent answers without them.
- An operator who takes a voice conversation over cannot reach the caller.
  A written reply has no way onto the call, so the Inbox offers no Send on a
  voice conversation. Until an operator writes in the conversation, each new
  utterance hears the agent's short waiting line; after that, the agent stays
  silent. See [Outcomes](#outcomes).
- Some proxies drop HTTP trailers, and browsers' `fetch` does not expose
  them. When you need a turn's outcome on the client, send that request with
  `stream: false` and read the header.
- Two first turns of one session that arrive at the same moment on different
  Radioso instances can each start a conversation. The session follows the
  one bound first, and the other turn's exchange stays in a conversation of
  its own. On one instance, a second first turn waits for the first to bind
  the session and joins its conversation.
- `400` means the body is not a chat-completions request, it has no `user`
  message with text, the utterance is longer than 4,000 characters, or the
  dialect found no session key. Check that the runtime sends the field the
  dialect table names.
- `404` means the dialect in the path is not one of the dialects above.
- After a turn limit, the conversation stores the agent's full reply while the
  caller heard the fallback line. Read the reply in Activity to see what the
  caller missed.
- An agent bundle does not carry the `voice` block, so an agent created from a
  bundle import starts with voice off.
- If the runtime hangs up mid-reply, the turn still finishes and is saved,
  the same as a REST agent-channel client that disconnects, and the same
  utterance sent again within 30 seconds hears the saved reply. A turn still
  running well after the disconnect is cancelled.
- The endpoint speaks the OpenAI chat-completions format voice runtimes call,
  not Radioso's own API contract, so it is described on this page rather
  than in the OpenAPI document or the TypeScript SDK.
