---
title: "Assistant Execution Model"
description: "Design principle that live chat stays in the request path while background work like exports is deferred asynchronously."
last_updated: 2026-05-16
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
