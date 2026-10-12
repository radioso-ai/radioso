---
title: "Voice Channel"
description: "Let a voice runtime such as ElevenLabs Agents speak for a Radioso agent through an OpenAI-compatible chat-completions endpoint, with one conversation per voice session."
last_updated: 2026-10-12
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
3. The last `user` message is the utterance. The earlier messages are the
   runtime's replay of the call, which the conversation already holds, so
   Radioso reads only the last one.
4. The agent runs its turn. The reply comes back as `chat.completion.chunk`
   frames, one sentence per frame, ending with `finish_reason: "stop"` and
   `data: [DONE]`.

## Set it up

You need an agent and a REST credential for it.

1. Open the agent's **Channels → API** card and create a REST credential.
   Copy the secret before you close the result; Radioso stores only its hash.
2. In the voice runtime, choose a custom LLM and give it the endpoint for your
   dialect:

   ```text
   https://api.radioso.ai/api/v1/agents/<agent-id>/voice/<dialect>/v1/chat/completions
   ```

   Use `https://api-us.radioso.ai` or your own self-hosted origin instead,
   matching the host where you created the credential. A runtime that takes a
   base URL and appends `/v1/chat/completions` itself gets
   `https://api.radioso.ai/api/v1/agents/<agent-id>/voice/<dialect>`.
3. Give the runtime the credential secret as its API key. It is sent as
   `Authorization: Bearer <secret>`.
4. Make the runtime send one id per call, where the dialect below reads it.
   For ElevenLabs, the agent configuration passes the conversation id as
   `conversation_id` in the custom LLM extra body, which reaches Radioso as
   `elevenlabs_extra_body.conversation_id`. A request without it gets `400`.

The agent id in the path must match the credential's agent. A credential for
another agent, an MCP-audience credential, a personal token or a
service-account credential gets `401`.

## Dialects

Runtimes speak the same OpenAI wire and differ in where they put the id of
the call. The dialect in the path tells Radioso where to look. Sources are
tried in order, and the first non-empty string wins.

| Dialect | Session key, in order | Transport |
|---|---|---|
| `elevenlabs` | body `elevenlabs_extra_body.conversation_id` | `web` |
| `generic` | header `X-Radioso-Voice-Session`, then body `metadata.session_key` | `web` |

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
| `messages` | Required. The call so far. The last message with `role: "user"` is the utterance, up to 4,000 characters; its `content` is a string or an array of content parts, of which the `text` parts are read. |
| `stream` | `true` for SSE frames, `false` or absent for one JSON object. Voice runtimes send `true`. |
| `model` | Echoed back in every response. Radioso answers with the agent's own model configuration. |
| `tools` | Accepted. Replies carry text only and never call the runtime's tools. |
| `elevenlabs_extra_body`, `metadata` | Read by the dialects above. |

Other fields, such as `temperature`, are accepted and have no effect.

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
full-width terminator such as `。`. The text of the frames joined together is
the agent's reply, character for character.

With `stream: false`, the response is one `chat.completion` object whose
`choices[0].message.content` is the whole reply.

If the turn fails after the first frame, the stream ends with one error frame
in place of `stop` and `[DONE]`:

```text
data: {"error":{"message":"The agent could not finish this reply.","type":"server_error"}}
```

A turn that fails before its first frame answers with an HTTP error status
instead.

Both carry an `X-Radioso-Conversation-Id` header with the conversation the
turn ran in, so you can open the call in Activity.

Try it from a terminal with the `generic` dialect:

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
- While the agent is still working on a reply, a new utterance replaces the
  running turn. Once the agent has started speaking, a new utterance waits
  for the running reply to finish, and the conversation stores that full
  reply, including any part the caller talked over.
- An operator who takes a voice conversation over cannot reach the caller.
  A written reply has no way onto the call, so the Inbox offers no Send on a
  voice conversation. Until an operator writes in the conversation, each new
  utterance hears the agent's short waiting line; after that, the agent stays
  silent.
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
- If the runtime hangs up mid-reply, the turn still finishes and is saved,
  the same as a REST agent-channel client that disconnects. A turn still
  running well after the disconnect is cancelled.
- The endpoint speaks the OpenAI chat-completions format voice runtimes call,
  not Radioso's own API contract, so it is described on this page rather
  than in the OpenAPI document or the TypeScript SDK.
