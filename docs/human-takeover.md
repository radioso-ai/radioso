# Human Takeover

Human takeover lets an operator own a conversation while the AI stays silent.
It is used when a conversation should move from automated handling to a named
human responder.

## Ownership states

Each conversation is either `ai_owned` or `human_owned`.

When a conversation is `ai_owned`, visitor messages follow the normal assistant
path. The assistant may run routines, retrieval, skills, model calls, and action
outbox work.

When a conversation is `human_owned`, Radioso suppresses the AI for that
conversation. New visitor messages are still saved, but the assistant does not
call a model, run routines, perform retrieval, dispatch skills, or enqueue
assistant outbox actions. The AI stays suppressed until an operator explicitly
hands the conversation back.

## How handoff is requested

Handoff is request-driven. The AI does not silently decide to transfer a
conversation to a human owner.

There are two request triggers:

- A routine reaches a `handoff` terminal. The terminal is authored in the
  routine, including cases where an LLM-selected transition chooses that branch,
  such as an authored branch for an annoyed user.
- An agent has `handoffOnRetrievalMiss` enabled and a turn produces a
  no-context grounded miss. This behavior is opt-in per agent and is off by
  default.

Both triggers request human ownership and notify an operator through the existing
contact-delivery transport with a `handoff.notify` action. They also record
`hitl.ownership` audit events. See [Authoring routines](./authoring-routines.md#handoff-notifications)
for the `handoff.notify` payload and queue semantics.

## Operator API

There is no frontend operator console in this cut. Operators use authenticated
API endpoints under `/api/v1/conversations`.

All endpoints require a bearer workspace session with the
`workspace.conversation.takeover` permission. Every action records a
`hitl.ownership` audit event.

### Take over

`POST /api/v1/conversations/{conversationId}/takeover`

Body:

```json
{
  "reason": "operator_takeover"
}
```

`reason` is optional. The response returns the current ownership record.

### Reply as a human

`POST /api/v1/conversations/{conversationId}/reply`

Body:

```json
{
  "message": "Thanks for waiting. I can help with this.",
  "expectedVersion": 3
}
```

The reply is saved as an assistant-role message with `source:
human_agent`. The message includes the operator identity in metadata. The
`expectedVersion` value must match the current human-owned ownership record; if
the conversation has been transferred or handed back, the endpoint returns
`409` with the current ownership record in `error.details.ownership`.

### Transfer ownership

`POST /api/v1/conversations/{conversationId}/transfer`

Body:

```json
{
  "toAccountId": "00000000-0000-0000-0000-000000000000",
  "expectedVersion": 3
}
```

`expectedVersion` is an optimistic concurrency token from the ownership record.
If ownership changed since the caller read it, the endpoint returns `409` with
the current ownership record in `error.details.ownership`.
`toAccountId` must be the account that owns the conversation workspace; targets
outside the workspace are rejected.

### Hand back to the AI

`POST /api/v1/conversations/{conversationId}/handback`

Body:

```json
{
  "expectedVersion": 4
}
```

After hand-back, the next visitor message follows the normal assistant path.

## Approval resume compatibility

The HITL approval decision-resume endpoint is not built yet.

When it is added, a resume that can emit a message must defer while the
conversation is `human_owned`. The AI must never speak into a human-owned
thread. Only a host-marked side-effect-only resume may proceed.

Use the reusable `canResume()` helper exported from
`backend/src/modules/handoff/public.ts` for this check.
