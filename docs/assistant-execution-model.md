---
title: "Assistant Execution Model"
description: "Design principle that live chat stays in the request path while background work like exports is deferred asynchronously."
last_updated: 2026-10-15
---

# Assistant Execution Model

Radioso uses two knowledge-agent execution classes on purpose. Only the interactive path is shipped; the deferred class is a design boundary the product holds to, not a running subsystem.

## Live Chat Stays Immediate

Normal agent chat runs in the live request path. That includes:

- authenticated chat turns
- anonymous public chat turns
- Enterprise embedded widget chat turns
- assistant bootstrap greetings for new conversations

This work is classified in code as `interactive_synchronous`. Users either get an immediate response, immediate streaming, or an explicit failure. Radioso does not silently convert normal chat into background work under load.

A streaming turn reports typed progress before the answer starts. The public
stages are `interpreting`, `searching`, and `composing`. They are UI state, not
assistant messages: Radioso does not save them in history, include them in
prompts, or treat them as the start of answer delivery.

Answer chunks describe incremental delivery, not necessarily live model tokens.
Direct and admissible retrieval answers can stream provider output. So can a
routine reply on a turn that only moves the routine to its next step, such as a
slot question, a re-ask, or a step's grounded answer; the message and the new step
are saved once the reply is complete. Replies that must pass a guard or complete a
durable write are validated or committed first, then replayed in bounded
Unicode-safe chunks without artificial delays. A routine reply is one of these when
its turn runs a skill that acts outside the conversation (an email, a webhook),
queues an action, waits on an approval, hands the conversation to a person, or ends
the routine, so a visitor reads "your request is in" only once the request is saved. If saving a streamed routine reply fails, the visitor has already read it:
the routine stays on the step it was on and asks again next turn.

Operator Test Chat streams its answers the same way, with each compared version's
text arriving as it is generated. A Test Chat reply settles on the answer the test
saved, as a chat reply settles on the answer in `done`.

## New Messages Supersede Unstarted Replies

Only one assistant reply can prepare or emit for a conversation at a time. If a
new message arrives before the current reply starts streaming or persisting,
Radioso cancels the current reply. The newer turn waits for cancellation cleanup,
then reads the latest history. Earlier user messages remain in that history, but
no assistant message is saved for the cancelled turn.

Once the first assistant chunk is streamed, or a whole reply starts persisting,
the turn completes. The newer message then runs as the next turn. This prevents
partial assistant messages from being saved.

For a superseded non-streaming request, authenticated chat, public chat, and MCP
converse return HTTP `409` with a structured error:

```json
{
  "error": {
    "code": "chat_turn_superseded",
    "message": "Chat turn was superseded by a newer message.",
    "details": {
      "conversationId": "...",
      "reason": "superseded",
      "stage": "rendering"
    }
  }
}
```

For streaming chat, the superseded stream ends normally with a terminal SSE
event. It does not contain assistant-facing copy:

```text
event: cancelled
data: {"conversationId":"...","reason":"superseded","stage":"rendering"}
```

Clients should stop the pending reply state when they receive `cancelled`.
They may receive one or more `status` events before `cancelled`, but never an
answer chunk or another terminal event afterward. A status event does not prevent
the turn from being superseded.
For a successful stream, `done` marks completion of the core turn. Optional
`suggestions` enrichment can follow, so clients that use suggestions should
continue reading until the stream closes.

These rules hold across instances. Each turn takes a lease in Postgres when it
starts, and the conversation's turns are ordered there. On one instance, a newer
message applies the rules the moment its turn starts. When the reply in flight
runs on a different instance, that instance hears about the newer turn through
Postgres `LISTEN`/`NOTIFY`, typically a few milliseconds after the newer turn
starts, and applies the same rules then. A reply that passes its point of no
return inside that gap is kept, and the newer message runs after it. For chat,
that point is the first streamed chunk or the start of persisting. For a voice
turn, it is the commit of its stored reply. While an instance's `LISTEN`
connection is reconnecting, the gap lasts until it reconnects and reads back the
turns it missed.

Each API or worker process holds one extra database connection for `LISTEN` while
it has turns in flight. The connection closes once the process has had no turn in
flight for the pool's idle timeout (`DB_POOL_IDLE_TIMEOUT_MS`). When you size the
database's connection limit, count `DB_POOL_MAX + 1` per process.

A newer turn runs once every older turn of the conversation has finished, on any
instance. If an instance crashes mid-turn, its lease stops being renewed and
expires after about 30 seconds, and newer turns stop waiting for it. They still
wait for any older reply on another instance that is running.

An instance that cannot renew its lease aborts its own turn about two seconds
before the lease would expire. That covers a blocked event loop and a database
connection that only that instance lost. The turn never runs alongside the turn
that takes over. As with a disconnect, the abort stops provider calls that honor
the turn's signal; a stage that ignores it runs until it returns, and the turn
then stores nothing.

## A Disconnected Client Does Not Stop the Turn

A streaming client that closes its connection stops receiving data right away: the
server stops writing to that response. The turn itself keeps running, so a visitor
who closes the tab mid-answer still finds the completed reply in history when they
come back. Operator Test Chat streams follow the same rule and keep running their
revision-pinned attempt.

If the turn has not finished within two minutes of the disconnect, the server
aborts it instead of waiting on the HTTP response indefinitely. The turn uses its
ordinary cancellation cleanup: provider adapters that honor the abort signal stop,
and usage settles through the established cancellation path. Test Chat receives
the same signal through its replay runner and uses its existing attempt handling.

A stage that does not honor the abort signal can continue holding the conversation
lease until it returns, just as a slow stage on a connected turn can. The HTTP
stream is released at the ceiling even while that stage remains in progress.

## Background Work Is Separate

Long-running assistant-adjacent work belongs in a separate deferred class, not in the live chat path.

Use deferred execution for workflows such as:

- exports and offline analysis
- notifications or other post-turn follow-up jobs

These workflows should present themselves as background work from the start. They should expose status, completion, and failure clearly instead of pretending to be a live chat turn.

## Operator Guidance

When you explain the system to customers or reviewers, use plain language:

- live agent chat is immediate and streaming
- background agent work must be explicit and delayed
- the product never hides a queued chat turn behind the normal chat UI

That distinction is the service model. It protects chat responsiveness and keeps a clean boundary for durable async workflows: they run as declared background work, never as a disguised chat turn.
