---
title: "Voice Channel"
description: "Let a voice runtime such as ElevenLabs Agents speak for a Radioso agent through an OpenAI-compatible chat-completions endpoint, with sessions Radioso starts on your vendor key, one conversation per voice session, authored lines that cover the wait, and the call's recording in the Inbox."
last_updated: 2026-10-17
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

A voice session runs over two connections. The voice runtime calls Radioso
on every turn, with a REST credential for the agent. The page where the caller
presses talk opens the session on the runtime, which takes the vendor's key
and a session key. Radioso can open that session for the page, so your vendor
key stays in the workspace; or your own backend can open it.

### Connect the runtime to Radioso

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

ElevenLabs Agents uses the `elevenlabs` dialect. Three settings on the
ElevenLabs agent connect it to a Radioso agent: the URL, the credential, and
permission for each session to carry its session key.

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

**The session key.** ElevenLabs sends no conversation id of its own, so each
session starts with a session key that ElevenLabs sends back on every turn in
the custom LLM extra body. Allow that on the agent with
`platform_settings.overrides.custom_llm_extra_body: true`. Radioso reads
`elevenlabs_extra_body.session_key`, and `elevenlabs_extra_body.locale` when
the session names the caller's language.

### Start sessions from Radioso

Radioso holds your ElevenLabs API key and opens each session for the page, so
the page never sees the key and you run no backend of your own for it. The
page talks to your Radioso app host, the one that serves `/radioso-embed.js`
(`https://app.radioso.ai` on Radioso Cloud), the same way the website embed
does.

1. In **Settings → Providers**, under **Voice runtime keys**, set the
   ElevenLabs API key. Radioso encrypts it with `CONNECTOR_ENCRYPTION_KEY`,
   like the model provider keys, and never shows it again. Workspace owners
   and admins can set and remove it; `PUT` and `DELETE`
   `/api/v1/settings/credentials/elevenlabs` do the same from the dashboard
   session.
2. On the agent's **Voice** card, turn on **Voice channel**. Under
   **Runtime**, keep **ElevenLabs**, enter the ElevenLabs agent id (the
   `agent_…` id of the agent you connected above), and pick the **Data
   residency** of your ElevenLabs account: United States (the default),
   European Union, India or Singapore. An account on ElevenLabs data residency
   lives only on its region's host (`api.eu.residency.elevenlabs.io` for the
   EU), so a wrong region reads like a wrong key. Then select **Save voice
   settings**.
3. Add the page's origin to the website embed's allowed origins. Only a
   website embed session can start a call, because only its origin is checked.
4. Put the website embed on the page. Turn on **Offer calls on the website**
   and the embed shows a **Talk** button and runs the call itself; see
   [Talk from the website embed](#talk-from-the-website-embed). A page with
   its own call controls leaves that switch off, starts a website embed
   session, asks Radioso for a voice session with it, then opens the session
   with the ElevenLabs client:

   ```js
   import { Conversation } from '@elevenlabs/client'

   const appHost = 'https://app.radioso.ai'
   const embed = await fetch(`${appHost}/api/embed/session/${launchToken}`, {
     method: 'POST',
     headers: { 'content-type': 'application/json' },
     body: JSON.stringify({}),
   }).then((response) => response.json())

   const start = await fetch(`${appHost}/api/public/chat/${launchToken}/voice/sessions`, {
     method: 'POST',
     headers: { 'content-type': 'application/json', 'x-radioso-public-session': embed.publicSessionToken },
     body: JSON.stringify({ locale: 'it' }),
   }).then((response) => response.json())

   const conversation = await Conversation.startSession({
     signedUrl: start.signedUrl,
     customLlmExtraBody: { session_key: start.sessionKey, locale: start.locale },
   })

   await fetch(`${appHost}/api/public/chat/${launchToken}/voice/sessions/${start.sessionKey}/vendor-conversation`, {
     method: 'POST',
     headers: { 'content-type': 'application/json', 'x-radioso-public-session': embed.publicSessionToken },
     body: JSON.stringify({ vendorConversationId: conversation.getId() }),
   })
   ```

   `launchToken` is the website embed token in your embed snippet. A page that
   already runs the embed can reuse the embed's public session. The last
   request tells Radioso which ElevenLabs conversation the call is, so the
   Inbox can play its recording; a page that leaves it out still talks, and
   its calls have no recording in Radioso. See [Recordings](#recordings).

The start answers with the session the page opens:

```json
{
  "vendor": "elevenlabs",
  "signedUrl": "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_01jxk2v9qbe8n7r6t5w4&conversation_signature=…",
  "sessionKey": "3f0c2a8e-5b1d-4c47-9a1e-0d6b2f7c9e41",
  "locale": "it",
  "expiresAt": "2026-10-16T12:15:00.000Z",
  "recordingNotice": "Questa chiamata viene registrata per il nostro team."
}
```

`signedUrl` is valid until `expiresAt`, which Radioso sets 15 minutes after
the start from the validity ElevenLabs documents, and
ElevenLabs lets anyone holding it open sessions on your agent until then. Treat
it as a credential: hand it to the ElevenLabs client once, and never store, log
or share it. The response carries `Cache-Control: no-store`.

`sessionKey` is a correlation handle, not a credential. ElevenLabs sends it
back on every turn, so the call is one conversation, and the call's first turn
joins the website visitor who started it, so the Inbox and Activity show the
call next to that visitor's chats. Radioso remembers that visitor for an hour
after the start, well past the URL's 15 minutes; a call whose first turn comes
later still is its own conversation with no visitor. Each start mints a new key. `locale` is
optional in the request. It tells Radioso which language the caller speaks, so
bridge and fallback lines come in that language; leave it out and the response
carries the agent's default locale, or `en`. `recordingNotice` is the agent's
recording notice for the call, present when the agent wrote one: show it to
the caller as the call starts. See [The recording notice](#the-recording-notice).

Every start opens a session ElevenLabs bills to your account, so starts spend
their own small budgets before ElevenLabs is called: by default 3 per visitor
session and 3 per visitor address every 10 minutes, so minting a new public
session for each start runs out just the same, and 30 a minute per workspace.
Operators tune them with `PUBLIC_VOICE_SESSION_START_RATE_LIMIT_MAX_ATTEMPTS`,
`PUBLIC_VOICE_SESSION_START_SOURCE_RATE_LIMIT_MAX_ATTEMPTS`,
`PUBLIC_VOICE_SESSION_START_RATE_LIMIT_WINDOW_MS`,
`PUBLIC_VOICE_SESSION_START_WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS` and
`PUBLIC_VOICE_SESSION_START_WORKSPACE_RATE_LIMIT_WINDOW_MS`. Visitors behind
one office network share an address, and so share its budget. Set the
ElevenLabs agent's concurrency and daily call limits too: they bound what a
leaked signed URL or a busy day can cost.

| Status | `error.code` | What it means |
|---|---|---|
| `404` | `not_found` | The public session is missing, is not a website embed session, or is not valid from this origin; or the **Voice channel** is off for the agent, or no runtime is bound. |
| `429` | `rate_limit_exceeded` | The visitor session or the workspace used up its session-start budget. |
| `503` | `voice_unavailable` | The session could not be started. |

A visitor sees one `503` whatever the reason. The backend log line `Voice
session start failed` names it as `outcome`: `credential_missing` (no
ElevenLabs key under **Voice runtime keys**), `credential_unreadable` (a key
is stored but cannot be decrypted, usually after `CONNECTOR_ENCRYPTION_KEY`
changed; enter it again), `credential_read_failed` or `registration_failed`
(Radioso could not reach its database), or `vendor_failed` (ElevenLabs refused
the start or did not answer within 5 seconds; `vendorStatus: 401` means the
stored key is wrong). The `voice_session_start_total` metric counts the same
outcomes.

Ray can bind the runtime: ask it to connect the agent to your ElevenLabs agent
and it drafts the whole `voice` block with `propose_agent_setting` for you to
review. The API key is yours to enter in Settings; Ray never asks for it.

### Talk from the website embed

The website embed is a ready-made page for voice calls. Offering them is your
choice, and it starts off:

1. Get the agent's voice ready: the **Voice channel** on, an ElevenLabs agent
   bound under **Runtime**, and an ElevenLabs key under **Voice runtime
   keys**, as above.
2. On the agent's **Web chat** page, under **Website widget**, turn on
   **Offer calls on the website**. You can turn it on once voice is ready;
   until then it names the piece still missing. You can turn it off at any
   time.

The embed's composer then shows a microphone button, **Talk**, beside Send.
The switch governs only the widget: a page of your own that starts sessions
keeps working with it off, and getting voice ready for that page puts nothing
on the widget. Browsers
give a microphone only to pages served over https (or from `localhost`), so a
page served over plain http shows no button. The embed snippet stays the same.
The embed learns about the switch from its config, which a browser keeps for a
minute. Radioso Cloud's CDN keeps it for up to five, and Radioso drops the
CDN's copy whenever the agent's settings change or the workspace stores or
removes its ElevenLabs key, so the button appears or disappears within about a
minute of a change.

Ray can draft the agent's `voice` block, but it leaves this switch to you: it
decides whether every visitor to your live site sees **Talk** and a microphone
prompt. The switch is `surfaceSettings.websiteEmbed.voiceCallsOffered` on
`PUT /api/v1/agents/:agentId`, `false` unless you set it, and each change is
recorded in the audit log as `website_embed.voice_calls_offered.changed`. An
agent bundle always exports it as `false`, so an imported agent offers no calls
until you turn them on. For a dashboard session, `GET /api/v1/agents/:agentId`
also returns `voiceCallReadiness`: `{ "ready": true, "missing": null }`, or the
first missing piece as `voice_channel`, `runtime`, `vendor_key` or
`encryption` (a key is stored but `CONNECTOR_ENCRYPTION_KEY` is not set).

When a visitor presses **Talk**:

1. The embed loads the ElevenLabs client. A client that cannot load ends the
   call before it spends a start.
2. The embed asks Radioso for a session with its public session, in the
   language it asked the greeting in when it knows one, and opens the session
   with the ElevenLabs client, which asks the browser for the microphone. A
   visitor who refuses it, or has none, reads "Talking needs your
   microphone."; that call's start still counts against the visitor's
   budget. On an iPhone or iPad the embed loads the client as soon as the
   panel offers **Talk**: there the client creates its audio on the page's
   first tap and discards it after 30 seconds, so a call's audio plays only
   when the session opens within 30 seconds of that tap.
3. The composer gives way to a call bar that reads **Connecting…**, then
   **Listening** while the visitor talks and **Speaking** while the agent
   answers, with **End call** beside it. When the agent has a recording
   notice for the call's language, it sits above the bar for the whole call.
   Once ElevenLabs has opened the session, the embed tells Radioso which
   ElevenLabs conversation it is, so the Inbox can play the call later. The visitor can talk over the agent:
   ElevenLabs stops the reply, and the Inbox marks it as interrupted.
4. Each thing the visitor says and each reply appears in the panel as it
   happens, marked **Spoken**. A reply the visitor talked over is cut to the
   part ElevenLabs actually spoke. Those lines belong to the open panel; after
   a reload the panel shows the text chat alone.

The call ends when the visitor selects **End call**, closes the panel, or
ElevenLabs closes the session; the panel then reads "Call ended" and offers
**Talk** again. **End call** while the call is still connecting goes straight
back to **Talk**; the start it made still counts against the visitor's
budget. A start that Radioso turns down (any status in the table above), an
error ElevenLabs reports during the call, and an ElevenLabs handshake that
gets no answer within 10 seconds of the microphone being granted all end the
call with "Talking isn't available right now. Try again later." The call
is its own conversation: the Inbox and Activity list it with the source
**Voice**, next to the visitor's text chats.

The embed's chat runs in an iframe on your Radioso app host, so the launcher
grants that iframe the microphone with `allow="microphone"` when the agent
takes voice calls. A host page that sends a `Permissions-Policy` header
denying the microphone, such as `microphone=()`, takes it away again. Chrome
and Edge show the frame the policy, and the embed then shows no **Talk**
button; Firefox and Safari do not show it, so there the embed hides **Talk**
only when the browser reports the microphone permission as denied, and
otherwise the visitor reads the microphone line on pressing it. Allow the
microphone for the app host instead:

```text
Permissions-Policy: microphone=(self "https://app.radioso.ai")
```

Browsers that cannot set the microphone's sample rate, Firefox among them,
resample the call's audio with a small WebAssembly module that the app host
serves; the chat frame's content security policy allows it to compile
(`'wasm-unsafe-eval'`, on the frame alone).

The voice controls' wording is part of the embed copy, translated into the
embed's built-in languages: `publicChatTalkLabel`, `publicChatEndCallLabel`,
`publicChatVoiceConnectingStatus`, `publicChatVoiceListeningStatus`,
`publicChatVoiceSpeakingStatus`, `publicChatVoiceEndedStatus`,
`publicChatVoiceMicrophoneError`, `publicChatVoiceUnavailableError` and
`publicChatSpokenLabel`. Override them like any other embed string, with
`data-radioso-copy` on the script tag or in the agent's per-language copy
packs.

### Start sessions from your own page

When your page or backend opens the session itself, it mints the session key.
The key only keeps the call in one conversation; such a call joins no website
visitor.
A public ElevenLabs agent starts from its agent id; a private one needs a
signed URL your backend requests with its ElevenLabs key:

```js
import { Conversation } from '@elevenlabs/client'

const conversation = await Conversation.startSession({
  agentId: '<elevenlabs-agent-id>',
  customLlmExtraBody: { session_key: crypto.randomUUID(), locale: 'it' },
})
```

Over the WebSocket API, send the same object as `custom_llm_extra_body` in
the `conversation_initiation_client_data` message. ElevenLabs then sends it
on every turn of the session as `elevenlabs_extra_body`. Mint the key in the
page: a dynamic variable such as `{{system__conversation_id}}` inside the
extra body arrives as that literal text, which would put every call in one
conversation. Radioso answers a session key that is a whole `{{…}}`
placeholder with `400`.

## Bridge lines and the turn limit

On a call, silence sounds like a dropped line. A grounded answer can take a
second or two to start, so you give the agent a few short lines to say while
it works, and one line to say if the answer takes far too long.

You write them in the **Voice** card, below the Agent API card on the agent's
**Channels → API** page:

1. Turn on **Voice channel**.
2. Add a language, such as English. Each language carries its own lines.
3. Under **Bridge lines**, add **Check** lines, which the agent says while it
   looks an answer up, and **Acknowledge** lines, which it says inside a
   routine once the caller has answered a step.
4. Write the **Fallback line**, which the caller hears when nothing is ready
   at 10 seconds.
5. Select **Save voice settings**.

On the `elevenlabs` dialect, bridge and fallback lines follow the
[first-sentence length rule](#elevenlabs-first-sentence-length). The card
warns under any line that falls short and still saves it, since other dialects
speak a short line at once.

The same card holds the agent's **Quick replies**: the lines it says word for
word to a greeting, thanks, farewell, or acknowledgement, in chat as well as
on calls. The card saves both blocks together.

Ray can make the same change. Ask it to turn voice on or to add a bridge line,
and it drafts the whole block with `propose_agent_setting` for you to review
and apply.

The card writes the agent's `voice` settings block, which you can also send
to the agent settings API yourself:

```json
{
  "voice": {
    "enabled": true,
    "bridgeLines": {
      "en": {
        "acknowledge": [
          "Got it, thank you, just give me a second to note that down.",
          "Thanks, I've noted that, so let me take the next step."
        ],
        "check": [
          "Let me check that for you, it only takes a moment.",
          "One moment please while I look that up in our documents."
        ]
      },
      "it": {
        "acknowledge": [
          "Perfetto, ho preso nota e ora passo al punto successivo.",
          "Grazie, l'ho annotato, dammi solo un secondo per proseguire."
        ],
        "check": [
          "Controllo subito per te, ci vorrà solo un momento.",
          "Un attimo per favore, sto cercando nei nostri documenti."
        ]
      }
    },
    "fallbackLine": {
      "en": "Sorry, this is taking much longer than it should, could you ask me again?",
      "it": "Scusa, ci sto mettendo troppo, puoi ripetere la domanda per favore?"
    },
    "recordingNotice": {
      "en": "This call is recorded so our team can review it.",
      "it": "Questa chiamata viene registrata per il nostro team."
    },
    "runtime": { "vendor": "elevenlabs", "agentId": "agent_01jxk2v9qbe8n7r6t5w4" }
  }
}
```

Send it with a personal token or a service-account credential from
**Settings → API access**:

```bash
curl -sS -X PUT \
  "https://api.radioso.ai/api/v1/agents/<agent-id>" \
  -H "Authorization: Bearer <personal-token>" \
  -H "Content-Type: application/json" \
  -d @voice.json
```

where `voice.json` holds the object above. `GET /api/v1/agents/<agent-id>`
returns the block as `voice`, and the quick replies as `mechanicsReplies`.

The block is replaced whole, whether the card, Ray, or your own request
writes it: a request that carries `voice` must carry `enabled`,
`bridgeLines` and `fallbackLine`, a `voice` without `runtime` binds no vendor
agent, a `voice` without `recordingNotice` shows no notice, and a request
without `voice` keeps the stored one. To turn voice off, send the block back with
`"enabled": false`. Keys are language tags such as `en`, `it` or `pt-BR`, up
to 10 for each map. Each style holds up to 5 lines, and every line is 1 to 200
characters. The lines above follow the
[first-sentence length rule](#elevenlabs-first-sentence-length) for the
`elevenlabs` dialect. `runtime` is the vendor agent a Radioso-started session
opens: `vendor` is `elevenlabs`, `agentId` is the vendor's own agent id, 1 to
128 letters, digits, underscores and hyphens, and `region` is the ElevenLabs
account's data residency region, `us` (the default when you leave it out),
`eu`, `in` or `sg`; any other key in it is refused, as is any key the `voice`
block itself does not name. `null` binds none. A new agent
starts with `"enabled": false`, empty maps and `"runtime": null`.

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
  turn and keeps it. A reply that was still being saved when the newer request
  arrived, with none of it sent yet, counts as not started.
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
conversation keeps the full reply and marks it with how many characters the
caller heard (`heardCharacterCount`) and how long the spoken reply was
(`spokenCharacterCount`). A bridge line spoken before the reply does not count
toward either. The audit trail records the same counts as
`voice.reply_interrupted`.

In the Inbox, that reply carries an **Interrupted** badge. Hover it to read
"The caller spoke over this reply. About 37% was heard." Both counts measure
the reply as it was spoken, after links, lists and other formatting became
speech, so the percentage tells you roughly how far the caller got, not where
in the written text they stopped. The conversation history API returns the
counts on the reply as `interruption`, and the dashboard's conversation tail
returns the reply again once it is marked, so a conversation you have open
shows the badge within a poll.

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

The session key must name one call. A value that spans calls, such as a
user id, would run every call of that user in one conversation, so no dialect
falls back to one.

Use `generic` for a runtime you control, such as LiveKit Agents or Pipecat:
set the header to your own session id on every request of the session. A
session key is opaque to Radioso and can be up to 256 characters.

### ElevenLabs first-sentence length

ElevenLabs holds the first sentence of a reply until it has about 45
characters of text (observed 2026-10-13: 26 characters waited for the next
sentence, 46 and 57 did not; invisible padding and two short sentences do not
count). Write every bridge line and fallback line as a full sentence of at
least 45 characters, or the caller hears it only together with the answer. On
this dialect, a style that has lines of both lengths speaks only its lines of
45 characters or more. A style with none that long still speaks its shorter
line, and the server logs `voice.bridge_line_below_vendor_minimum` at warn once
per agent, naming the agent and the two lengths.

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

A call started through Radioso's session start also records the data
residency region of the ElevenLabs account and, once the page reports it,
ElevenLabs's id for the call. Together they name the call's recording; see
[Recordings](#recordings).

## Recordings

ElevenLabs records each call and keeps the audio in your ElevenLabs account.
Radioso keeps no audio. What it keeps is where to find it: when the website
embed (or [your own page](#start-sessions-from-your-own-page)) has opened a
session that Radioso started, it reports ElevenLabs's id for the call with
`POST /api/v1/public/chat/{token}/voice/sessions/{sessionKey}/vendor-conversation`
and `{ "vendorConversationId": "conv_…" }`. Before storing it, Radioso asks
ElevenLabs, with the workspace's key and on the account's region host, which
agent the conversation was held on, and stores the id only when that is the
ElevenLabs agent the session was started on. So a visitor cannot attach
another call from the same ElevenLabs account. Radioso takes the id once, from the same website
embed public session the session was started for, within an hour of the
start, and only ever uses it to look the recording up with the workspace's
own key. A session your page starts without Radioso's session start has no
recording in Radioso.

| Status | `error.code` | What it means |
|---|---|---|
| `204` | | The id is stored. |
| `400` | `validation_error` | The session key is not a UUID, or the id is not 1 to 128 letters, digits, underscores and hyphens. |
| `404` | `not_found` | No session this public session started waits for an id (it has one, its start expired, or Radioso never started it), or ElevenLabs says the conversation was held on another agent. Sending it again changes nothing. |
| `503` | `voice_unavailable` | Radioso could not check the id with ElevenLabs now: ElevenLabs does not show the conversation yet (as can happen right after the call connects), the key cannot be read, or ElevenLabs did not answer. Send it again. |

The website embed sends the report with `keepalive`, so it still goes out
when the page closes, including for a call stopped while ElevenLabs was still
opening it. It tries once more when the report does not get through, leaves a
throttled (`429`) report for the call's end, and sends it again as the call
ends if no `204` came back. The log line
`Voice vendor conversation report was refused` or `… could not be checked`
names the `outcome` (`no_session`, `vendor_agent_mismatch`,
`vendor_not_found`, `already_reported`, `credential_*`, `vendor_failed`,
`store_failed`), and `voice_vendor_conversation_report_total` counts them,
`recorded` included.

### Listen in the Inbox

Teammates who can read the workspace's conversations hear the call from the
Inbox: a voice conversation whose call has a recording shows **Listen** in
the header, and the call plays in the pane. Each conversation starts silent,
so going back to one never resumes its player. Behind it, a dashboard
session's conversation detail (`GET /api/v1/history/chat/{conversationId}`)
carries `recording: { "available": true }` when the page reported the call
and the workspace holds an ElevenLabs key Radioso can read. Radioso answers
that from its own records, without asking ElevenLabs, so a call that has just
ended can read as available a little before ElevenLabs has its audio. Machine
credentials get no `recording`. Ray's `conversation_transcript` says the same
as `recordingAvailable`, and Ray never hears the audio.

The player streams from
`GET /api/v1/conversations/{conversationId}/recording`: Radioso asks
ElevenLabs for the call's audio (`audio/mpeg`, unencoded) on the host of the
account's data residency region, with the workspace's key, and passes it on
with `Cache-Control: private, no-store`. The key, the ElevenLabs URL and the
ElevenLabs id never reach the browser. The route takes dashboard sessions
only, with the history read permission, and only from the dashboard's own
pages. A browser request whose `Sec-Fetch-Site` is anything but
`same-origin` gets `403`, so a link on another site cannot start a play
under a teammate's name. `HEAD` gets `405`. An `<audio>` element cannot send
`X-Workspace-Id`, so the workspace may come as a `workspaceId` query
parameter, checked against the session the same way. A `Range` header naming
one byte range (`bytes=1000-`, `bytes=1000-1999` or `bytes=-500`) goes on to
ElevenLabs. The answer is `206` with ElevenLabs's `Content-Range` when
ElevenLabs honours it, and the whole recording with `200` when it ignores
the range. A stream that stops sending for 15 seconds while the player waits
for it is closed.

| Status | `error.code` | What it means |
|---|---|---|
| `404` | `not_found` | The conversation has no recording in Radioso, or ElevenLabs holds no audio for the call yet (it finishes the recording shortly after the call ends). |
| `416` | | The byte range lies past the end of the recording; `Content-Range` names its length. |
| `503` | `recording_unavailable` | There is a recording and it could not be read now. |

The backend log line `Voice recording could not be read` says why, as
`outcome`: `store_failed` or `credential_read_failed` (Radioso could not
reach its database), `vendor_not_found`, `credential_missing`,
`credential_unreadable` (enter the ElevenLabs key again), `vendor_failed`
(ElevenLabs refused, did not answer within 5 seconds, or answered with
something that is not audio; `vendorStatus: 401` means the stored key is
wrong), or `audit_failed`. The `voice_recording_fetch_total` metric counts
every outcome, `served`, `no_recording` and `range_not_satisfiable`
included. A teammate who closes the player or seeks while ElevenLabs is
still answering leaves no log line, no count and no audit event. Log lines
and metrics carry ids only.

### Every play is audited

Every answer that carries audio first records a `conversation.recording_played`
audit event with the conversation id, the teammate's user id, the vendor, and
`partial: true` when the audio sent starts past the first byte, as it does
when the player seeks. A player that reads a recording in parts leaves one
event per part. When the audit event cannot be written, the recording does
not play.

### Deletion and retention

The recording lives in your ElevenLabs account until it is deleted there,
by you or by the retention you set on the ElevenLabs agent, or until Radioso
deletes it. Deleting a workspace or the organization asks ElevenLabs to
delete each call's conversation, audio included, on the account's region
host, after the deletion has gone through. That includes a call whose first
turn never came, which has no conversation in Radioso. Radioso reads the
recordings and the key first, because the deletion takes both with it.
Deleting an agent deletes no recording: its conversations stay, and so do
their recordings, which still play from the Inbox and go when their
workspace does. Radioso's record of where a recording is also outlives the
call's conversation, so a workspace deletion still reaches a recording whose
conversation was deleted before it.

Each recording Radioso deletes is recorded as a
`conversation.recording_deleted` audit event with the conversation id, the
vendor, `outcome` (`deleted`, or `already_absent` when ElevenLabs no longer
held it) and `deletedWorkspaceId`. When a workspace is deleted, the event
belongs to the organization, so the organization keeps its proof of erasure.
When the organization itself is deleted, the event names it as
`deletedAccountId`.

The deletion never waits on ElevenLabs. An organization's workspaces are
worked through in order, four calls at a time, for at most 20 seconds in
all. A recording ElevenLabs refuses to delete or does not answer for, and
every recording not yet deleted when the time runs out (a delete still
waiting on ElevenLabs is let go of then), stays in your ElevenLabs account and is logged as `Voice recording was left at the vendor`
with its `conversationId` and `vendorConversationId`. Radioso does not try
again, so delete those from the ElevenLabs dashboard by that id.
`voice_recording_delete_total` counts each outcome.

Recordings are deleted with the workspace's ElevenLabs key. Once you remove
that key, or replace it with a key for another ElevenLabs account, Radioso
can neither play nor delete the recordings made on the old account. They
stay there until you delete them in ElevenLabs.

### Data residency

The recording stays in the data residency region of the ElevenLabs account
bound under **Runtime**, and Radioso reads and deletes it on that region's
host only. For a workspace whose data must stay in the EU, use an
ElevenLabs account on EU data residency and pick **European Union** under
**Data residency**; a US account keeps EU callers' recordings in the US.

### The recording notice

Some jurisdictions require telling a caller the call is recorded. Write the
notice per language on the agent's **Voice** card, under **Recording
notice**, or as `recordingNotice` in the `voice` block, keyed by language tag
like `fallbackLine`, one line of 1 to 200 characters each. The website embed
shows the notice above the call bar for the whole call, and a session start
hands your own page the same line as `recordingNotice`. The notice is in the
call's language. When the agent has none in that language, it is in the
agent's default language, then English, then whichever notice you wrote
first, so a caller is always told when the agent has a notice at all. The
agent does not speak it: the caller first hears ElevenLabs's own first
message, so to have the call say it out loud, put the same words in the
ElevenLabs agent's first message.

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
  the session and joins its conversation. One conversation per session is
  therefore guaranteed within an instance; across instances, only the
  session's binding is shared.
- `400` means the body is not a chat-completions request, it has no `user`
  message with text, the utterance is longer than 4,000 characters, or the
  dialect found no session key. Check that the runtime sends the field the
  dialect table names.
- `404` means the dialect in the path is not one of the dialects above.
- Whether a turn gets a bridge line and the 10-second limit depends on who owns
  the conversation when the turn starts, and the voice channel reads that a few
  milliseconds before the agent does. A hand-off or takeover that lands in
  between can give that one turn a bridge line before the waiting line, or
  leave a slow agent answer without a bridge line or a limit.
- After a turn limit, the conversation stores the agent's full reply while the
  caller heard the fallback line. Read the reply in Activity to see what the
  caller missed.
- An agent bundle does not carry the `voice` block, so an agent created from a
  bundle import starts with voice off.
- If the runtime hangs up mid-reply, the turn still finishes and is saved,
  the same as a REST agent-channel client that disconnects, and the same
  utterance sent again within 30 seconds hears the saved reply. A turn still
  running well after the disconnect is cancelled.
- The completions endpoint speaks the OpenAI chat-completions format voice
  runtimes call, not Radioso's own API contract, so it is described on this
  page rather than in the OpenAPI document or the TypeScript SDK. The session
  start is Radioso's own contract: it is the `createPublicVoiceSession`
  operation in the OpenAPI document.
