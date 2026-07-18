---
title: "Assistant Execution Model"
description: "Design principle that live chat stays in the request path while background work like exports is deferred asynchronously."
last_updated: 2026-07-18
---

# Assistant Execution Model

Radioso uses two knowledge-agent execution classes on purpose, even though only the interactive path is shipped for the covered workflows in this feature.

## Live Chat Stays Immediate

Normal agent chat runs in the live request path. That includes:

- authenticated chat turns
- anonymous public chat turns
- Enterprise embedded widget chat turns
- assistant bootstrap greetings for new conversations

This work is classified in code as `interactive_synchronous`. Users either get an immediate response, immediate streaming, or an explicit failure. Radioso does not silently convert normal chat into background work under load.

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

Clients should stop the pending reply state when they receive `cancelled`. A
successful stream still ends with `done`.

Interruption coordination is process-local. Multi-instance deployments need
conversation-affine routing for strict behavior across instances. Without it,
cancellation remains best effort within each process.

## Background Work Is Separate

Long-running assistant-adjacent work belongs in a separate deferred class when Radioso has a real background runtime behind it.

Use deferred execution for workflows such as:

- exports and offline analysis
- notifications or other post-turn follow-up jobs

These workflows should present themselves as background work from the start. They should expose status, completion, and failure clearly instead of pretending to be a live chat turn.

## Operator Guidance

When you explain the system to customers or reviewers, use plain language:

- live agent chat is immediate and streaming
- any future background agent work must be explicit and delayed
- the product never hides a queued chat turn behind the normal chat UI

That distinction is the service model. It protects chat responsiveness now while still leaving room for durable async workflows later if the product adds a real background execution path.
