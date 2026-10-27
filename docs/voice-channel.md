---
title: "Voice Channel"
description: "Let a voice runtime such as ElevenLabs Agents speak for a Radioso agent through an OpenAI-compatible chat-completions endpoint, with sessions Radioso starts on your vendor key, one conversation per voice session, authored lines that cover the wait in the language of each turn, a call that switches language with its caller, a teammate's Inbox replies spoken to the caller, the call's recording in the Inbox, and the period's call numbers on the Quality page."
last_updated: 2026-10-27
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

A voice call runs over two connections. The voice runtime calls Radioso on
every turn, with a REST credential for the agent. The page where the caller
presses Talk opens the session on the runtime, which takes the vendor's key
and a session key. With ElevenLabs, Radioso sets up both ends: you store your
ElevenLabs key and press **Connect**, and Radioso creates the ElevenLabs
agent in your account, gives it a credential, keeps it set up, and opens each
session for the page, so the key never leaves the workspace.

### Connect ElevenLabs

1. In ElevenLabs, create an API key that may read and write agents: the key's
   **Agents** permission with write access (`convai_read` and `convai_write`
   in the ElevenLabs API). A key without it reads as one that lacks the Agents
   permission on the Voice card.
2. In **Settings → Providers**, under **Voice runtime keys**, set the
   ElevenLabs API key. Radioso encrypts it with `CONNECTOR_ENCRYPTION_KEY`,
   like the model provider keys, and never shows it again. Workspace owners
   and admins can set and remove it; `PUT` and `DELETE`
   `/api/v1/settings/credentials/elevenlabs` do the same from the dashboard
   session.
3. On the agent's **Voice** card (**Channels → API**), turn on **Voice
   channel** and select **Connect ElevenLabs**. The card then reads
   **Connected to ElevenLabs · recordings stay in the European Union**, or
   whichever region your account keeps its data in. Connect takes effect at
   once; the **Voice channel** switch and the lines below it take effect when
   you select **Save voice settings**.

Connect does four things:

- It finds your account's data residency region from the key. An ElevenLabs
  account lives on exactly one region's host (`api.elevenlabs.io` for the
  United States, `api.eu.residency.elevenlabs.io` for the European Union, and
  the India and Singapore hosts), so Radioso asks all four and the one that
  knows the key is the region. Calls, recordings and their deletion all go to
  that host.
- It issues the agent a REST credential labelled **Voice calls**, with no
  expiry. It shows on the agent's **API** card next to the credentials you
  created.
- It creates an ElevenLabs agent named **Radioso · Front desk** (for an agent
  called Front desk), tagged `radioso-managed`, with the settings below.
- It binds the agent's `voice.runtime` to that ElevenLabs agent, the binding
  a Radioso-started session opens.

| What Radioso sets on the ElevenLabs agent | Value |
|---|---|
| Custom LLM | `https://api.radioso.ai/api/v1/agents/<agent-id>/voice/elevenlabs/v1`, model `radioso`, with the **Voice calls** credential in a workspace secret it sends as the bearer |
| System prompt and first message | Empty: the agent's own instructions apply, and the caller speaks first |
| Language | The language of the agent's default locale (`it` for `it-IT`, `pt-br` for `pt-BR`), or English when the agent names none or ElevenLabs Agents doesn't speak it |
| Language presets | Every other language ElevenLabs Agents offers, so a call can switch to any language an answer is written in |
| **Detect language** system tool | On. Radioso calls it only while **Switch language with the caller** is on |
| Backup LLM | Off, so every answer comes from the agent |
| Speculative turns | Off: each would run as a real turn |
| Custom LLM extra body | Allowed, so each session carries its session key |

Everything else on the ElevenLabs agent is yours to tune in ElevenLabs: the
voice, the speech model, speech recognition keywords, and call limits.
Connect leaves them as they are. Set the agent's concurrency and daily call
limits there: they bound what a leaked signed URL or a busy day can cost.

The ElevenLabs agent follows the Radioso agent. When you change the agent's
default locale, Radioso sets the ElevenLabs agent's language again. Select
**Reconnect** on the Voice card to set everything in the table again and bind
the agent once more, for example after a save cleared the binding or after
someone changed those settings in ElevenLabs. When the **Voice calls**
credential was revoked, Reconnect issues a new one, points the ElevenLabs
agent at it, and only then revokes the old one.

**Disconnect** deletes the ElevenLabs agent and its secret, revokes the
**Voice calls** credential, and unbinds the agent. When ElevenLabs can't be
reached, or no readable key is stored, Radioso still revokes the credential
and unbinds; the card says the ElevenLabs agent is left in your account, and
you delete it there. Deleting the Radioso agent revokes the credential at once
and deletes its ElevenLabs agent right after; the deletion never waits on
ElevenLabs.

When you replace the key with one for an account in another region, the
next Connect creates a new ElevenLabs agent there and revokes the old agent's
credential, so the old agent can no longer reach Radioso. The new key can't
see the old account, so delete the old agent in that account yourself.

Ray doesn't connect ElevenLabs: Connect creates an agent in your ElevenLabs
account and issues a credential, which is yours to do from the Voice card.
When Ray drafts a change to the `voice` block, it carries `runtime` over as
stored. The API key is yours to enter in Settings; Ray never asks for it.

#### When Connect fails

The Voice card names what to fix. From the API, the same answers come from
`POST /api/v1/agents/:agentId/voice/connection`:

| Status | `error.code` | What it means |
|---|---|---|
| `409` | `voice_vendor_key_missing` | No ElevenLabs key is stored under **Voice runtime keys**. |
| `409` | `voice_connection_busy` | Another Connect or Disconnect of the agent is running, from another tab or teammate. This one changed nothing; try again when it finishes. |
| `409` | `voice_vendor_key_unreadable` | A key is stored but no configured key decrypts it; see [Rotate the credential encryption key](../docs-portal/content/operators/self-hosting-operations.mdx#rotate-the-credential-encryption-key), or enter the key again. |
| `422` | `voice_vendor_key_rejected` | No ElevenLabs region accepts the key. |
| `422` | `voice_vendor_key_lacks_agents_permission` | ElevenLabs accepts the key, but it may not read and write agents. |
| `502` | `voice_vendor_failed` | ElevenLabs refused to create or update the agent. |
| `503` | `voice_vendor_unreachable` | ElevenLabs did not answer, within 5 seconds for the region check and 10 seconds for each change. |
| `503` | `voice_connection_unavailable` | The deployment has no `PUBLIC_API_BASE_URL`, the public address ElevenLabs posts each turn to. |

A failed attempt cleans up after itself: a credential issued for it is
revoked again when ElevenLabs refuses the agent, and an ElevenLabs agent
Radioso could not record is deleted again. Select Connect again after any
failure; it picks up whatever the last attempt left in place.

`GET`, `POST` and `DELETE /api/v1/agents/:agentId/voice/connection` are the
Voice card's: dashboard sessions only, with the agent manage permission, and
`X-Radioso-CSRF: 1` on `POST` and `DELETE`. One `POST` or `DELETE` of an
agent runs at a time, across every backend instance; another one meanwhile
answers `409 voice_connection_busy` at once. Each answers where the runtime
stands:

```json
{
  "vendor": "elevenlabs",
  "state": "connected",
  "region": "eu",
  "vendorKey": "stored",
  "connectAvailable": true,
  "runtime": { "vendor": "elevenlabs", "agentId": "agent_01jxk2v9qbe8n7r6t5w4", "region": "eu" }
}
```

`state` is `not_connected`, `connected` (an ElevenLabs agent Radioso
maintains) or `connected_externally` (one you set up yourself; see
[Use an ElevenLabs agent you set up yourself](#use-an-elevenlabs-agent-you-set-up-yourself)).
`runtime` is the agent's `voice.runtime` as stored: a client that saves the
whole `voice` block sends it back, or the save unbinds the agent. `DELETE`
adds `vendorAgentLeft`, true when the ElevenLabs agent may still be in your
account.

Each connect, disconnect and language update logs one line with the agent,
vendor, region, `operation` and `outcome` (`Voice runtime connected`,
`Voice runtime connect failed`, `Voice runtime language sync failed`, and an
ElevenLabs agent left behind as `Voice runtime vendor agent left at the
vendor`), never the key, the credential or a URL. The
`voice_runtime_connection_total` metric counts them by `vendor`,
`operation` and `outcome`, and the audit trail records
`agent.voice_runtime.connected` and `agent.voice_runtime.disconnected`.

On a self-hosted deployment, set `PUBLIC_API_BASE_URL` on the backend to the
origin the internet reaches its REST API on, such as
`https://api.example.com`, with the path prefix it is served under if there is
one; a trailing `/api/v1` is dropped, so the value `RADIOSO_PUBLIC_API_URL`
takes works too. ElevenLabs must reach
`{PUBLIC_API_BASE_URL}/api/v1/agents/<agent-id>/voice/elevenlabs/v1`; until
it is set, the Voice card says Connect is unavailable.

### Start sessions from Radioso

Radioso holds your ElevenLabs API key and opens each session for the page, so
the page never sees the key and you run no backend of your own for it. The
page talks to your Radioso app host, the one that serves `/radioso-embed.js`
(`https://app.radioso.ai` on Radioso Cloud), the same way the website embed
does. With the agent's voice connected:

1. Add the page's origin to the website embed's allowed origins. Only a
   website embed session can start a call, because only its origin is checked.
2. Put the website embed on the page. Turn on **Offer calls on the website**
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
optional in the request. It tells Radioso which language the call starts in,
so bridge and fallback lines come in that language until a turn reports
another (see [Mid-call language](#mid-call-language)); leave it out and the
response carries the agent's default locale, or `en`. `recordingNotice` is the agent's
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
one office network share an address, and so share its budget.

| Status | `error.code` | What it means |
|---|---|---|
| `404` | `not_found` | The public session is missing, is not a website embed session, or is not valid from this origin; or the **Voice channel** is off for the agent, or no runtime is bound. |
| `429` | `rate_limit_exceeded` | The visitor session or the workspace used up its session-start budget. |
| `503` | `voice_unavailable` | The session could not be started. |

A visitor sees one `503` whatever the reason. The backend log line `Voice
session start failed` names it as `outcome`: `credential_missing` (no
ElevenLabs key under **Voice runtime keys**), `credential_unreadable` (a key
is stored but no configured key decrypts it, usually because
`CONNECTOR_ENCRYPTION_KEY` changed and the key it replaced is missing from
`CONNECTOR_ENCRYPTION_PREVIOUS_KEYS`: add that key back, as
[Rotate the credential encryption key](../docs-portal/content/operators/self-hosting-operations.mdx#rotate-the-credential-encryption-key)
describes, or enter the ElevenLabs key again), `credential_read_failed` or `registration_failed`
(Radioso could not reach its database), or `vendor_failed` (ElevenLabs refused
the start or did not answer within 5 seconds; `vendorStatus: 401` means the
stored key is wrong). The `voice_session_start_total` metric counts the same
outcomes.

### Use an ElevenLabs agent you set up yourself

Set the ElevenLabs agent up by hand when you want to own every setting on it,
or on a deployment that has no `PUBLIC_API_BASE_URL`. Radioso then answers its
turns and opens its sessions, and leaves the agent itself to you.

#### Point the agent at Radioso

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

#### Set up the ElevenLabs agent

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
the session names the language the caller starts in.

**Language switching (optional).** For a call that changes language with its
caller, add ElevenLabs's **Detect language** system tool to the agent
(`conversation_config.agent.prompt.built_in_tools.language_detection`), list
every language it may switch to under `conversation_config.language_presets`,
and turn on **Switch language with the caller** on the Voice card. See
[Mid-call language](#mid-call-language).

#### Bind it

Bind the Radioso agent to it with `PUT /api/v1/agents/<agent-id>`: send the
whole `voice` block with `runtime` naming your ElevenLabs agent and its
account's region (the block is described under
[Bridge lines and the turn limit](#bridge-lines-and-the-turn-limit)):

```json
{ "voice": { "enabled": true, "bridgeLines": {}, "fallbackLine": {}, "runtime": { "vendor": "elevenlabs", "agentId": "agent_01jxk2v9qbe8n7r6t5w4", "region": "eu" } } }
```

An account on ElevenLabs data residency lives only on its region's host
(`api.eu.residency.elevenlabs.io` for the EU), so a wrong region reads like a
wrong key. The Voice card then reads **Uses an ElevenLabs agent set up
outside Radioso**. **Disconnect** only unbinds it and leaves your ElevenLabs
agent alone; **Let Radioso manage it** connects a new ElevenLabs agent that
Radioso maintains, and leaves yours alone too.

### Talk from the website embed

The website embed is a ready-made page for voice calls. Offering them is your
choice, and it starts off:

1. Get the agent's voice ready: an ElevenLabs key under **Voice runtime
   keys**, ElevenLabs connected under **Runtime**, and the **Voice channel**
   on, as above.
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
    "runtime": { "vendor": "elevenlabs", "agentId": "agent_01jxk2v9qbe8n7r6t5w4" },
    "languageSwitching": true
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
agent, a `voice` without `recordingNotice` shows no notice, a `voice` without
`languageSwitching` keeps every call in the language it starts in (`false`),
and a request without `voice` keeps the stored one. To turn voice off, send the block back with
`"enabled": false`. Keys are language tags such as `en`, `it` or `pt-BR`, up
to 10 for each map. Each style holds up to 5 lines, and every line is 1 to 200
characters. The lines above follow the
[first-sentence length rule](#elevenlabs-first-sentence-length) for the
`elevenlabs` dialect. `runtime` is the vendor agent a Radioso-started session
opens, which Connect writes: send it back as you read it. `vendor` is `elevenlabs`, `agentId` is the vendor's own agent id, 1 to
128 letters, digits, underscores and hyphens, and `region` is the ElevenLabs
account's data residency region, `us` (the default when you leave it out),
`eu`, `in` or `sg`; any other key in it is refused, as is any key the `voice`
block itself does not name. `null` binds none. A new agent
starts with `"enabled": false`, empty maps, `"runtime": null` and
`"languageSwitching": false`.

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
- **Language.** The lines come in the turn's language: the turn language the
  request reports (see [Mid-call language](#mid-call-language)), else the
  session locale (see the dialect table), else the agent's default locale,
  else `en`. The first of these the turn has decides; a line keyed `it` serves
  `it-IT` and `it-CH`, and an exact tag such as `pt-BR` wins over a bare `pt`.
  With no bridge line for that language and style, the caller hears nothing
  extra. The fallback line is the one written for that language. On a turn
  that reports a turn language, it is the first one written for the turn
  language, the session locale, the agent's default locale or `en`, in that
  order, so a caller who switched to a language without lines hears the
  call's other language rather than silence. With no fallback line for the
  language, the turn keeps waiting for the reply past 10 seconds.

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
- **Cancelled after its reply started:** the caller's message stays, and so
  does the reply, as far as the caller heard it: the sentences ElevenLabs had
  played to their end, as the agent wrote them, with its formatting and
  without citation markers. The reply is marked interrupted (see below), and
  the next turn answers the newer utterance with both in its history, so a
  routine collecting details knows what the agent had said. When the caller
  heard no sentence of the reply to its end, only the caller's message stays;
  a bridge line never counts as the reply.

  What the caller heard comes from ElevenLabs itself: the newer request
  replays the reply cut short to what was played, followed by `...`, and
  Radioso keeps the whole sentences inside that. Text reaches ElevenLabs well
  ahead of its speech, and the old stream stays open while the caller says
  their new sentence and it is transcribed, so what reached ElevenLabs can be
  most of the answer when the caller heard one sentence. When the newer request
  carries no such record, every sentence that reached ElevenLabs counts as
  heard. A request sent with `stream: false` gets its whole answer only at
  the end, so a cancelled one stores nothing, and its teammate replies wait
  for the next turn.

An unclear word can make the transcriber flap, and ElevenLabs then sends
several requests within a second or two with alternating transcripts. Each
one replaces the one before, so the conversation stores the last transcript
and one answer to it. A request that arrives while the previous one is still
being set up replaces it before its turn starts.

When the runtime loses a reply, because it hung up on the stream before the
reply finished or a newer request overtook it, it can send the same utterance
again a few seconds later. If that happens within 30 seconds and the reply
was stored, the caller hears the stored reply again: no new message in the
conversation, no bridge line, no model call. A reply stored as far as it was
heard is not repeated: the same utterance runs a new turn, which sees that
part in its history and finishes the answer. The audit trail records
`voice.reply_replayed` against the reply. If the reply is still being written
when the same utterance arrives, the new request runs as a new turn and
replaces the running one.

When the caller speaks over a reply that had finished streaming, ElevenLabs
replays that reply in the next request cut short to what was heard, followed
by `...`. The conversation keeps the full reply and marks it with how many
characters the caller heard (`heardCharacterCount`) and how long the spoken
reply was (`spokenCharacterCount`). A bridge line spoken before the reply does
not count toward either. The audit trail records the same counts as
`voice.reply_interrupted`, with `partial: false`.

A reply cut off while it was still streaming carries the same mark from the
moment it is stored, with `partial: true`: `heardCharacterCount` is how much
ElevenLabs played, which can reach into the sentence the caller cut, and
`spokenCharacterCount` is how much reached it. The two are equal when
ElevenLabs sent no record of what it played. A later report that the caller
heard less leaves the mark as it is. The audit trail records
`voice.reply_interrupted` with `partial: true` against that reply, in the same
transaction that stores it.

In the Inbox, either reply carries an **Interrupted** badge. On a reply that
finished, hover it to read "The caller spoke over this reply. About 37% was
heard." Both counts measure the reply as it was spoken, after links, lists
and other formatting became speech, so the percentage tells you roughly how
far the caller got, not where in the written text they stopped. On a reply
stored as far as it was spoken, the badge reads "Cut off while speaking. Only
what was heard is stored." The conversation history API returns the counts
on the reply as `interruption`, with `partial` telling the two apart, and the
dashboard's conversation tail returns a finished reply again once it is
marked, so a conversation you have open shows the badge within a poll.

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
  that, the agent stays silent. The agent looks for that reply among the
  conversation's last ten messages, so after about ten caller turns with no
  new reply from your team the waiting line comes back. These turns end with
  `continue`. No bridge line comes before the waiting line and no fallback
  line cuts in on it: both cover the agent's own answers.
- A teammate answers the caller from the Inbox, as they would a web chat. The
  reply is spoken on the caller's next turn, in place of the waiting line or
  the silence, and that turn ends with `continue`. Say the booth visitor asks
  "Can I come by at four?" while your teammate reads the transcript; they
  write "Yes, four works. Bring your badge." and press Send. The next time the
  visitor speaks, even just "Hello?", they hear those two sentences, as
  speech, with the markdown taken out.

That last point has one limit: a call speaks only when its caller does. The
voice runtime asks Radioso for something to say each time the caller finishes
an utterance, and there is no other way onto the call, so a reply waits for the
caller's next utterance. The Inbox says so beside Send ("The caller hears this
on their next turn.") and marks the reply **Pending** until a turn speaks it,
then **Spoken**. A reply written after the caller hangs up stays Pending: it
remains in the conversation for the follow-up, through the details the routine
collected. A reply with nothing a call can say, such as only formatting marks,
is never spoken and shows **Not spoken: no words to say**.

Several replies written between two utterances are spoken in the order they
were written, all on the same turn. When your teammate hands the call back
before the caller speaks again, the replies still pending are spoken first and
the agent answers that utterance right after, with its usual turn limit and no
bridge line, since the caller has just heard someone speak. When the runtime
re-sends an utterance whose answer it lost and Radioso repeats that answer
(see [When the caller talks over the agent](#when-the-caller-talks-over-the-agent)),
the replies still pending come first.

Each reply is spoken once. The turn that speaks it claims it first, in the
database, so no other turn on any Radioso instance speaks it at the same time.
It counts as spoken once that turn has completed: the runtime received the
whole response, and no newer utterance overtook it first. When the caller
speaks over the turn before then, the newer request's record of what
ElevenLabs played decides: a reply played to its end counts as spoken, and
the one the caller cut into, with any after it, goes back to Pending for the
newer turn to say whole. With no such record, every reply of that turn goes
back to Pending. So do the replies of a turn the runtime dropped, or that
failed, so the caller may hear a reply again when a turn fails after it was
already sent. A claim that outlives its turn by a minute, because the instance
running the turn stopped, also counts as Pending again.

A turn that speaks teammate replies records one `voice.operator_reply_spoken`
audit event with the conversation id and the replies' message ids, never their
text. In history, the reply carries `speech`: `{ "state": "pending" }` until it
is spoken, `{ "state": "spoken", "spokenAt": "…" }` after, where `spokenAt` is
when the turn that spoke it ended, and `{ "state": "skipped" }` for a reply
with no words to say. The dashboard tail returns the reply again when it is
spoken or skipped, so an open Inbox pane updates on its own.

## Dialects

Runtimes speak the same OpenAI wire and differ in where they put the id of
the call and the caller's language. The dialect in the path tells Radioso
where to look. Header and body sources are tried in order, and the first
non-empty string wins; for a locale, the first language tag wins, and a value
that is not one falls through to the next source.

There are two languages to look for. The session locale is the language the
call starts in, named once for the session. The turn language is the
language of one turn, which a request reports when the call's language has
changed since; see [Mid-call language](#mid-call-language). On `elevenlabs`
it comes from the history rather than a field, and only the newest
`language_detection` call counts: when Radioso cannot read it, the turn has
no turn language and the session locale applies. On `elevenlabs` Radioso can
also switch the call's language itself, by calling that tool.

| Dialect | Session key, in order | Session locale, in order | Turn language, in order | Language switch | Transport |
|---|---|---|---|---|---|
| `elevenlabs` | body `elevenlabs_extra_body.session_key` | body `elevenlabs_extra_body.locale` | the `language` argument of the newest `language_detection` tool call in `messages` that its `tool` result shows took effect | a `language_detection` tool call, when the request's `tools` offer it and the agent has `languageSwitching` on | `web` |
| `generic` | header `X-Radioso-Voice-Session`, then body `metadata.session_key` | header `X-Radioso-Voice-Locale`, then body `metadata.locale` | header `X-Radioso-Voice-Turn-Locale`, then body `metadata.turn_locale` | none: your runtime switches its own voice | `web` |

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

### Mid-call language

A caller can start a call in English and carry on in Italian. The agent's
answers follow by themselves: on every turn the agent reads the caller's
language from what they said, and its quick replies come in that language
too. What the agent does not write on the turn follows the call's language:
the bridge line, the fallback line, and on ElevenLabs the voice that speaks
and the language its speech recognition listens for.

#### Switch an ElevenLabs call's language

ElevenLabs speaks and transcribes one language at a time, the one the call
started in, until something calls its `language_detection` system tool. With
language switching on, Radioso makes that call on the turn the caller
changes language, so the answer to "A che ora aprite domani?" comes in an
Italian voice rather than in Italian words read by the English one.

Turn on **Switch language with the caller** on the agent's Voice card
(`"languageSwitching": true` in the `voice` block). An ElevenLabs agent
Radioso connected already has the **Detect language** system tool and a
preset for every language ElevenLabs Agents speaks. On an ElevenLabs agent you
set up yourself, add the tool
(`conversation_config.agent.prompt.built_in_tools.language_detection`) and
list every language the call may switch to under
`conversation_config.language_presets` first: the switch is off by default
because a switch to a language with no preset is refused.

On a turn, the agent's plan names the language the turn answers in, as a
language tag. When its primary subtag (the `it` of `it-IT`) differs from the
call's language, the request's `tools` offer `language_detection`, and the
turn is less than 4 seconds old, the turn switches the call:

1. Radioso's reply to that request is the tool call and nothing else: one
   `tool_calls` delta whose arguments are
   `{"reason":"response_language","language":"it"}`, then
   `finish_reason: "tool_calls"` and `[DONE]`. The agent's turn keeps writing
   its answer meanwhile.
2. ElevenLabs switches the voice and transcription and, about half a second
   later, sends a follow-up request whose newest message is the tool's result.
3. Radioso speaks the answer on that follow-up, as far as it is written and
   then as it streams. The follow-up is part of the same turn: when the
   answer is still a while off, the caller hears a bridge line in the new
   language, and the bridge delay and the 10-second turn limit count from the
   start of the turn, not from the follow-up.

The call's language is the newest switch ElevenLabs carried out, else the
session locale, else the agent's default locale, so the turns after a switch
stay in the new language until the caller changes again. A switching turn
costs that one round trip, about 550 ms, and the conversation keeps the
caller's message and the answer once, as on any turn.

When the language is not in `language_presets`, ElevenLabs refuses the switch
and answers with the text `Invalid language. Keep speaking English.`. Its
follow-up still comes, and Radioso speaks the answer in the voice the call
already has. Radioso does not ask again for a language ElevenLabs refused
earlier in the call.

A turn keeps the call's language when a teammate's reply from the Inbox was
spoken on its request first, when the language comes more than 4 seconds
into the turn (`VOICE_BEHAVIOR.languageSwitchDecisionMs`), when the caller
spoke again or the runtime hung up before the language came, when its plan
gives no language tag (a routine step the agent is running answers without
one), when the request carries a switch Radioso cannot read, and when one of
the two languages has a three-letter subtag, which Radioso cannot tell apart
from a two-letter one.

On a request that may switch, no bridge line plays until the turn knows its
language or the 4 seconds pass, the 2.5-second bridge for a stalled planner
included, since a line spoken first would rule the switch out. On a planned
turn the language comes within a few milliseconds of the plan, so the
trade-off only shows when the planner is slow: up to 4 seconds of silence,
held open by the keep-alive, before the bridge line.

While the turn waits, the `elevenlabs` keep-alive (a space and a zero-width
space every 2.5 s of silence) may go out before the tool call. That is safe:
ElevenLabs shows the client an `agent_response` of whitespace, replays a
whitespace-only assistant message before the tool call, which Radioso reads
as nothing said, and runs the switch (probe, 2026-10-18).

A follow-up can reach a Radioso server other than the one that asked for the
switch. It reads the call's conversation instead: it bridges in the new
language and, once the other server stores the agent's answer to the
caller's newest message, speaks it whole rather than as it streams; it
speaks the fallback line in the new language if no answer is stored by the
turn limit, ends at once without a word when the caller's newest message is
another utterance, and stops reading once the caller is gone. It finds the
answer however many teammate replies were written after the caller's
message. A follow-up for
another utterance than the one the session's switching turn answered says
nothing, and that turn's answer stays replayable.

When no follow-up comes within 30 seconds, the answer the turn wrote is the
conversation's reply, and the same utterance sent again within those 30
seconds hears it. When the caller speaks again before the follow-up and the
answer is still being written, the newer utterance cancels the turn like any
newer utterance: a turn that had not started its reply keeps neither the
caller's message nor an answer, and one that had keeps the message without
an answer, since none of it reached the caller.

#### What Radioso reads

A request reports a turn language this way:

- **`elevenlabs`:** a call of ElevenLabs's `language_detection` system tool
  in `messages`, an assistant message's OpenAI tool call whose arguments
  carry a `reason` and a `language` code such as `it`, with the `tool`
  message that answers it: the nearest one after it with the same
  `tool_call_id`. A result object (JSON) is read by its `status` (`success`)
  and `is_error`, as ElevenLabs's
  [conversation API](https://elevenlabs.io/docs/api-reference/conversations/get)
  describes system tool results; a result in plain text is the error
  ElevenLabs gives the LLM for a switch it refused. The newest call that took
  effect is the call's language, and a refused call leaves the language the
  one before it set. When Radioso reaches a call it cannot read (no result, a
  result object of another shape or JSON that does not parse, or no language
  tag in its arguments), the call may be in either language, so the turn has
  no turn language. ElevenLabs replays the calls Radioso makes with `fc_`
  before the id Radioso gave them.
- **`generic`:** the `X-Radioso-Voice-Turn-Locale` header, then
  `metadata.turn_locale`, on each request whose utterance your speech
  recognizer heard in another language.

On such a turn:

- The bridge line and the fallback line come in that language, ahead of the
  session locale (see [Bridge lines and the turn limit](#bridge-lines-and-the-turn-limit)).
- When the language is news on the request (a `generic` field, or an
  `elevenlabs` switch made after the caller's previous utterance that
  Radioso did not ask for itself), the agent gets it as the turn's locale
  hint, so a reply it writes without your
  documents, such as the one to a question they do not cover, is in that
  language too. The session locale is no hint for the agent: it says how the
  call started, not what the caller speaks now.
- The turn language belongs to its request alone: the session keeps the
  locale it started with, and nothing in the conversation or the visitor's
  profile changes with it.

#### Logs and metrics

A turn's log line names its languages in two fields:

- `reportedTurnLanguage` is the turn language the request reported, on every
  turn that reports one, voice settings on or off.
- `turnLanguage` is the language the bridge and fallback lines were picked
  in, on a turn that ran with them: voice on, the agent answering, and the
  turn still the session's newest when its reply started. `languageSource`
  beside it says where that language came from: `vendor_detected` (a switch
  in the `elevenlabs` history), `turn_field` (the `generic` field), `session`
  (the session locale), `agent_default` (the agent's default locale) or
  `builtin_default` (`en`, when nothing else names one).

When the newest switch in the history was not taken, the line carries
`languageReport`: `blocked` when ElevenLabs refused it, `unreadable` when
Radioso could not read it.

A switch adds `languageSwitch` to the log lines of both requests: `emitted`
on the request that asked for it, logged once the turn's answer is written
(with `speechPieceCount: 0` and the answer's own outcome), and `confirmed` or
`refused` on the follow-up that spoke the answer. A switch no follow-up spoke
logs `Voice language switch was not followed up` once its turn's answer is
written, with the answer's outcome, the lines' language, and
`languageSwitch: "unanswered"` (none came in 30 seconds, the caller spoke
again first, or the follow-up was overtaken before it spoke) or
`"mismatched"` (the session's follow-up was for another utterance; that
follow-up logs `"mismatched"` too and says nothing). A follow-up that found
no switched turn on its server logs `Voice language switch follow-up found no
switched turn here` at info, with `languageSwitch: "unheld"`: on a call
served by several servers that is the expected path, and the server holding
the switching turn counts that turn `unanswered`.

Two metrics count switches, each partitioning its own events:

- `voice_language_switch_total{outcome}`, counted where the switching turn
  is held: `emitted` for every switch asked for, then `unanswered` or
  `mismatched` for one let go unspoken.
- `voice_language_switch_followup_total{outcome}`, counted where the
  runtime's follow-up arrives: `confirmed` or `refused` when it spoke the
  held answer, `unheld` when it held none for the follow-up (it then plays
  the stored answer whole, or says nothing for another utterance's
  follow-up). A follow-up overtaken before it spoke counts in neither label;
  its switch counts `unanswered`.

A switching turn counts its outcome (`voice_turn_outcome_total`) and its
lines' language (`voice_turn_language_source_total`) once: on the follow-up
that spoke it, or, when its switch is let go unspoken, once its answer is
written. A reply that fails after the switch is logged once, as the
switching turn's failure.

Write bridge lines for every language your callers may speak. A turn in a
language with no bridge line of its own hears none; its fallback line falls
back to the session locale's, then the agent's default locale's, then `en`.

```bash
curl -sS -i -X POST \
  "https://api.radioso.ai/api/v1/agents/<agent-id>/voice/generic/v1/chat/completions" \
  -H "Authorization: Bearer $RADIOSO_AGENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Radioso-Voice-Session: curl-test-1" \
  -H "X-Radioso-Voice-Locale: en" \
  -H "X-Radioso-Voice-Turn-Locale: it" \
  -d '{"stream":false,"messages":[{"role":"user","content":"Siete aperti domenica?"}]}'
```

## Request

The body is an OpenAI chat-completions request.

| Field | Meaning |
|---|---|
| `messages` | Required. The call so far. The last message with `role: "user"` is the utterance, up to 4,000 characters; its `content` is a string or an array of content parts, of which the `text` parts are read. On `elevenlabs`, the `assistant` message said right before the utterance (tool calls and their results replayed between them aside) that ends in `...` is read as the part of the previous reply the caller heard, and the newest `language_detection` call in an `assistant` message's `tool_calls`, with its `tool` result, names the turn language. Other earlier messages and the runtime's `system` prompt are ignored. |
| `stream` | `true` for SSE frames, `false` or absent for one JSON object. Voice runtimes send `true`. |
| `model` | Echoed back in every response. Radioso answers with the agent's own model configuration. |
| `tools` | Accepted. On `elevenlabs`, an offered `language_detection` tool lets an agent with `languageSwitching` on switch the call's language (see [Mid-call language](#mid-call-language)); replies call no other tool. |
| `elevenlabs_extra_body`, `metadata` | Read by the dialects above. |

Other fields, such as `temperature`, `max_tokens` and `stream_options`, are
accepted and have no effect.

A request whose newest message has `role: "tool"` is the runtime's
follow-up after running a tool, not a caller turn: its newest `user` message
is one an earlier request already answered. When the tool is the
`language_detection` call Radioso made on the session, the follow-up speaks
that turn's answer, on whichever Radioso server it reaches (see
[Mid-call language](#mid-call-language)). Any other follow-up, including one
for a `language_detection` call Radioso did not make, gets an empty
completion (`finish_reason: "stop"`, outcome `continue`), runs no turn, and
stores nothing.

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

A turn that switches the call's language answers its request with the tool
call alone (see [Mid-call language](#mid-call-language)):

```text
data: {"id":"chatcmpl-…","object":"chat.completion.chunk","created":1760270400,"model":"radioso","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"5f0c9a7e-…","type":"function","function":{"name":"language_detection","arguments":"{\"reason\":\"response_language\",\"language\":\"it\"}"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","created":1760270400,"model":"radioso","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]
```

With `stream: false`, the response is one `chat.completion` object whose
`choices[0].message.content` is the whole reply, or the fallback line after a
turn limit. It never contains a bridge line. A switch is its message's one
entry in `tool_calls`, with `content: null` and `finish_reason: "tool_calls"`.

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

## Call numbers on the Quality page

When an agent takes calls, Activity → Quality shows a **Voice** card under the
health row. It covers the period and the agent you picked at the top of the
page, and answers one question: how are calls going? For a busy week it reads:

| Row | Value | What it counts |
|---|---|---|
| Calls | 42 | Voice conversations with at least one answered turn in the period. |
| First words | 2.1 s | The median time from the start of a turn to its first speech, the reply's or the fallback line's. A bridge line covers the wait but is not the first words. |
| Turns that hit the time limit | 3 of 380 | Turns that reached the [turn limit](#bridge-lines-and-the-turn-limit) before they spoke, out of the period's turns on calls. |
| Interruptions | 0.4 per call | Turns whose reply the caller spoke over, cut off while it streamed or after it finished, per call. |
| Asked for a callback | 4 of 42 calls | Calls in which a turn's [outcome](#outcomes) was `callback_requested`, counted once per call however many of its turns asked. |

In practice, watch two of them. A first-words time that climbs toward the
10-second limit, or a share of time-limit turns that grows week on week, means
the agent takes too long to answer, most often a slow model or a retrieval that
searches too wide. A high interruption rate often means replies run long for a
call.

The card shows only for a period with voice turns, and not when the page is
filtered to another channel. "First words" reads "—" when no turn measured it:
a turn measures it when the agent's voice settings are on and the runtime
streams the response. A request sent with `stream: false` gets its speech only
with the outcome, so its turns count everywhere else on the card but keep no
first-words time.

Each turn keeps these facts with the reply it stored (`messages.metadata_json.voice`):
`firstSpeechMs`, `bridged`, `turnLimitReached`, `outcome` and `recordedAt`.
They are timings and closed values; what was said stays in the message. The
heard part of a reply cut off mid-stream counts as a turn of its call, and a
teammate's reply on the call does not. A turn that replays a stored answer adds
nothing, and after a language switch the follow-up that speaks the answer
keeps its facts. When the follow-up reaches the Radioso instance that ran the
switching turn, its first words are timed from that turn's start; when it
reaches another instance, the caller's wait is unknown there, so the turn keeps
no first-words time and "First words" leaves it out. A turn that stored no
reply, such as chat's waiting message on a call a teammate owns, keeps none.

So the card's turns are the period's turns that stored a reply. The alert on
turn-limit turns and the `voice_turn_limit_total` counter count every turn that
hit the limit, including one that stored no reply: a switch's follow-up on
another instance that reached the limit before the answer was stored, or a
turn whose reply failed after the limit. The alert can therefore read higher
than the card.

The same numbers come back from `GET /api/v1/quality/stats` as `voice`, `null`
without voice turns, and Ray reads them through `quality_signals`:

```json
"voice": {
  "calls": 42,
  "turns": 380,
  "firstSpeechMedianMs": 2140,
  "turnLimitTurns": 3,
  "interruptions": 17,
  "callbackCalls": 4
}
```

When a voice runtime starts timing out, the Google Cloud deployment alerts on
turns that hit the turn limit and on a burst of requests the runtime closes
before the answer reaches it (a caller who hangs up mid-turn counts too, so
the threshold is for a burst); see [Monitoring On Google Cloud](monitoring-google-cloud.md) and, for
other deployments, the Prometheus rules in
[Monitoring And Alerts](monitoring-alerts.md).

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
deletes it. Deleting the conversation (`DELETE /api/v1/history/chat/{conversationId}`),
its visitor (`DELETE /api/v1/history/visitors/{visitorId}`), the workspace or
the organization asks ElevenLabs to delete each call's conversation, audio
included, on the account's region host, after the deletion has gone through.
A visitor deletion also reaches a call the widget started for that visitor
whose first turn never came, which has no conversation in Radioso, by the
visitor's key; a workspace or organization deletion reaches every such call.
Deleting an agent deletes no recording: its conversations stay, and so do
their recordings, which still play from the Inbox and go when their
workspace does. Radioso's record of where a recording is also outlives the
call's conversation, so a workspace deletion still reaches a recording whose
conversation was deleted before it.

The deletion hands its recordings to a backlog in its own database
transaction, so the deletion and the backlog commit together or not at all.
For each workspace and vendor it copies the recordings straight from the
call's session rows in one statement, however many there are (region,
ElevenLabs conversation id, and the organization, workspace and conversation
they belonged to, by id), and writes the workspace's ElevenLabs key beside
them, encrypted with the same `CONNECTOR_ENCRYPTION_KEY` the credential store
uses, because a workspace's deletion takes its credential store with it. The
backlog names nothing it would have to follow a deleted row to, so it
outlives the workspace and the organization. The hand-off locks the call's
session rows first, so a report arriving meanwhile waits; when the
recordings or the key cannot be read, the deletion fails whole and can be
sent again, rather than go on without knowing where the recordings are.

A background job, `voice.recording_erasure`, then deletes them, woken as
soon as the deletion commits. Each run takes up to 50 recordings that are
due, holding each for five minutes so no other run asks about it meanwhile,
and asks ElevenLabs to delete them four at a time with the held key. A
recording ElevenLabs deleted, or no longer held, leaves the backlog. Each
recording ElevenLabs refused or did not answer for keeps its own schedule:
it is asked again after a minute, then five, fifteen, an hour, three, six
and twelve hours, eight asks in all over about a day, or later when
ElevenLabs sends a longer `Retry-After`. When ElevenLabs answers `429`, the
run asks nothing more, and every recording it turned away or had not asked
about yet waits for that `Retry-After` (a minute when it names none, an hour
at most) without it counting as an ask. The run then queues the
next for when the next recording is due: at once while more are due, at that
time otherwise. A recording still there after its eighth ask stays in the
backlog as `failed`, with why and when, and so does one still pending a week
after its deletion (`expired`). A workspace that held no ElevenLabs key when
it was deleted has all its recordings marked `failed` on the job's first run,
in one write, recorded in one write and reported once, without asking. The held key is cleared as soon as no recording waiting
to be deleted needs it, `failed` ones included. A worker that dies between
the commit and the vendor, or between the vendor's answer and its own
record, leaves the backlog as it was, and the next run picks it up once the
hold runs out; a recording asked twice reads as already absent the second
time. The `voice-recording-erasure-recovery` periodic task, every 15 minutes,
queues the job again for any erasure whose pending recordings are more than
15 minutes overdue, so none is stranded by a lost wake. A job that keeps
crashing gives up after five attempts: the recordings whose eight asks are
spent are left as `failed` (with their last reason, or `drain_failed`), and
the rest stay pending for the recovery sweep.

Each recording Radioso deletes is recorded as a
`conversation.recording_deleted` audit event with the conversation id, the
vendor and `outcome` (`deleted`, or `already_absent` when ElevenLabs no
longer held it). A recording left at the vendor is the same event with
status `failure`, `outcome: "left_at_vendor"`, a `reason`
(`credential_missing`, `credential_unreadable`, `vendor_rejected`,
`vendor_unreachable`, `vendor_timeout`, `vendor_malformed_response`,
`vendor_failed`, `vendor_unsupported` when this deployment knows no host for
its vendor or region, `expired`, or `drain_failed`), and `vendorConversationId`. The
event names the workspace and the organization as long as they exist; one
that is gone by the time the job records it is named by id as
`deletedWorkspaceId` or `deletedAccountId`, decided in the same write, so the
organization keeps its proof of erasure. The organization's owners and
admins list what was left with
`GET /api/v1/account/voice-recordings/left-at-vendor` (vendor, region,
ElevenLabs conversation id, conversation, workspace, reason, when), across
every workspace, deleted ones included, newest first and paged by `cursor`,
and delete each in ElevenLabs by its id. Once the organization itself is deleted, only the deployment's operators
see its leftovers: each batch is reported to the error sinks as
`voice.recording_left_at_vendor` (erasure, organization and workspace ids,
vendor, count and reasons), the backend log names each recording as
`Voice recording was left at the vendor` with its `conversationId` and
`vendorConversationId`, and the rows stay in `voice_recording_erasure_items`.
`voice_recording_delete_total` counts each ask by `outcome` (`deleted`,
`already_absent`, `vendor_failed`, `rate_limited`, `credential_unreadable`)
and each recording given up on as `left_at_vendor`; the job's own runs show under
`background_jobs_total{kind="voice.recording_erasure"}`.

Recordings are deleted with the workspace's ElevenLabs key. Once you remove
that key, or replace it with a key for another ElevenLabs account, Radioso
can neither play nor delete the recordings made on the old account. They
stay there until you delete them in ElevenLabs.

### Data residency

The recording stays in the data residency region of the ElevenLabs account
the agent is connected to, and Radioso reads and deletes it on that region's
host only. For a workspace whose data must stay in the EU, store the key of
an ElevenLabs account on EU data residency and connect: Radioso finds the
region from the key, and the Voice card reads **recordings stay in the
European Union**. A US account keeps EU callers' recordings in the US.

### The recording notice

Some jurisdictions require telling a caller the call is recorded. Write the
notice per language on the agent's **Voice** card, under **Recording
notice**, or as `recordingNotice` in the `voice` block, keyed by language tag
like `fallbackLine`, one line of 1 to 200 characters each. The website embed
shows the notice above the call bar for the whole call, and a session start
hands your own page the same line as `recordingNotice`. The notice is in the
call's language, the session locale, as the call starts; a caller who
switches language later keeps the notice they were shown. When the agent has
none in that language, it is in the
agent's default language, then English, then whichever notice you wrote
first, so a caller is always told when the agent has a notice at all. The
agent does not speak it: the caller first hears ElevenLabs's own first
message, so to have the call say it out loud, put the same words in the
ElevenLabs agent's first message.

### The privacy notice

The agent's privacy notice (the line and policy link per language under the
Web chat page's **Privacy notice** card, `branding.privacyNotice` on the
agent) sits in the embed's panel before the visitor's first message, so a
visitor who presses **Talk** has it in front of them. The embed also hands it
to the call: the line as the `radioso_privacy_notice` dynamic variable, and
its version as `privacy_notice_version` in the custom LLM extra body, beside
`session_key` and `locale`. To have the call say the line before the
greeting, start the ElevenLabs agent's first message with the variable:

```text
{{radioso_privacy_notice}} Hi, I'm Claudio. How can I help?
```

The embed sets the variable on every call it starts, empty when the agent has
no notice, so a first message that names it always finds it. The session's
first turn hands the version to
the chat turn, which records it on the conversation the call starts when the
agent's notices carry it; the conversation's **Visitor** panel shows it. A
page with its own call controls reports the version the same way, in
`elevenlabs_extra_body.privacy_notice_version`, or for the `generic` dialect
in the `x-radioso-voice-privacy-notice-version` header or
`metadata.privacy_notice_version`. A call no page started, such as one to a
phone number, records no notice.

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
  lands on another instance runs as a new turn. A language switch's
  follow-up that lands on another instance reads the stored answer instead of
  the switching turn's stream, so the caller hears it whole once it is
  stored, after a bridge line, rather than sentence by sentence.
- A reply cut off while it streamed is stored as far as ElevenLabs reports
  playing it, in whole sentences. When the newer request carries no record of
  what was played, it is stored as far as it reached ElevenLabs, which runs
  ahead of the speech by its synthesis backlog and by everything the caller
  said and the transcriber took while the old stream stayed open, so the
  stored part can hold sentences the caller never heard. The cut reply is not
  billed as an answer; its model tokens stay in the usage ledger. Quality's
  answer-quality numbers leave it out, and it cannot be sent to eval; the
  Voice card counts it as a turn of its call.
- A request that replaces an unanswered one carries only its own utterance.
  When the runtime's newer transcript does not repeat the caller's earlier
  words, the agent answers without them.
- An operator's reply reaches the caller only on the caller's next
  utterance, and a reply written after the call ends is never spoken. Each
  reply is spoken once, except that a reply the caller cut into before its
  turn completed (by ElevenLabs's record of what it played; every reply of the
  turn when there is none), the replies of a request the runtime dropped
  first, and those of a turn that fails go back to pending, and a claim that
  outlives its turn by a minute counts as pending again; either way a later
  turn speaks the reply a second time. The newer turn that cut in on the same
  Radioso instance takes those replies over and says them; on another instance
  it cannot see that turn, so the reply waits for that turn to finish or, if
  its instance stopped, for the claim to expire. A reply whose turn completed
  stays Spoken even when the caller then talks over it while ElevenLabs is
  still playing it; the Inbox marks only the agent's replies as interrupted. Until a
  teammate writes in the conversation, each new utterance hears the agent's
  short waiting line; after that, each one hears the teammate's replies
  written since the last, or nothing, until about ten caller turns pass with
  no new reply and the waiting line comes back. See [Outcomes](#outcomes).
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
- Deleting a workspace or an organization leaves the ElevenLabs agents Radioso
  created for its agents in your ElevenLabs account, with their credentials
  gone. Disconnect each agent first to delete them with it.
- If the runtime hangs up mid-reply, the turn still finishes and is saved,
  the same as a REST agent-channel client that disconnects, and the same
  utterance sent again within 30 seconds hears the saved reply. A turn still
  running well after the disconnect is cancelled.
- The completions endpoint speaks the OpenAI chat-completions format voice
  runtimes call, not Radioso's own API contract, so it is described on this
  page rather than in the OpenAPI document or the TypeScript SDK. The session
  start is Radioso's own contract: it is the `createPublicVoiceSession`
  operation in the OpenAPI document.
