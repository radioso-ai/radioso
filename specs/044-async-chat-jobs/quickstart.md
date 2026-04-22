# Quickstart: Chat Execution Classes

## Goal

Validate that Radioso preserves live chat as an interactive synchronous path while documenting long-running assistant work as future deferred scope rather than shipped background behavior.

## Validation Steps

1. Run targeted backend unit and integration tests covering:
   - authenticated live chat
   - anonymous/public chat
   - bootstrap greeting flow
   - execution-policy workflow classification
2. Confirm normal chat flows still use the live request path and do not create or require durable background jobs.
3. Review the execution-policy definitions and confirm each covered workflow maps to exactly one execution class.
4. Review the updated operator-facing documentation and confirm it explains:
   - which workflows are immediate
   - which workflows are only future deferred candidates
   - that normal chat is never silently converted into background work
5. Use the documentation alone to classify each covered workflow without reading the implementation.

## Failure Checks

1. Simulate or reason through interactive overload and confirm the documented response remains explicit rather than becoming queued background work.
2. Confirm any referenced deferred workflow is described as future background work rather than as an already shipped delayed version of normal chat.
3. Confirm no documentation or code comment implies that the absence of a broker in live chat means the platform lacks durability for non-interactive work.
