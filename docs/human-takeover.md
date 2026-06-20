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

Operators can act from the dashboard operator console (see [Operator console](#operator-console))
or directly through authenticated API endpoints under `/api/v1/conversations`.

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

## Approvals

A routine can pause at an approval gate before a step with side effects. When a
turn reaches that gate, the routine suspends, the assistant replies that the step
needs review, and Radioso records a pending decision. The conversation is not
handed over; it simply waits for an operator to decide. See
[Authoring routines](./authoring-routines.md) for how to author the gate.

### List pending approvals

`GET /api/v1/decisions`

Returns the workspace's open approval decisions, newest first. Each entry carries
what an operator needs to decide and to submit a resolve: `handle`,
`conversationId`, `agentId`, `routineId`, `stepId`, `reason`, `options`,
`contentHash`, `deadline`, and `createdAt`. Requires the
`workspace.conversation.takeover` permission.

### Resolve an approval

`POST /api/v1/agents/{agentId}/decisions/{handle}/resolve`

Body:

```json
{
  "optionId": "approve",
  "contentHash": "sha256:...",
  "payload": null
}
```

`optionId` must be one of the pending decision's options. `contentHash` must match
the value from the pending decision; a stale hash returns `409`. The decision flip,
the routine resume, and the resumed turn commit in one transaction, so a crash
before commit leaves the decision pending and a retry resolves cleanly. Approving
resumes the routine and lets the gated action run; rejecting takes the rejection
branch. A gated side effect runs as an idempotent outbox action, never inline.

Operators are notified of a new pending approval through the contact-delivery
transport with an `approval.request` action, mirroring `handoff.notify`.

## Live updates

Both surfaces can read forward for new messages instead of refetching the whole
transcript. The public visitor surface can also subscribe to push notifications.

- Operator: `GET /api/v1/history/chat/{conversationId}/tail?cursor=...`
- Visitor: `GET /api/v1/public/chat/{token}/tail/{conversationId}?cursor=...`
- Visitor push: `GET /api/v1/public/chat/{token}/events/{conversationId}`

Each tail call returns messages created after the cursor plus an advanced cursor.
Conversation detail responses include `tailCursor`, which clients should use for
follow-up tail calls. With no cursor, tail returns the newest bounded page and a
cursor for the newest returned message. Messages include `source`, so a visitor
sees a human reply distinctly. The operator tail also includes `ownership`; the
visitor tail never does.

## Operator console

The dashboard surfaces this work under **Activity**, which has three tabs:

- **Needs attention** — the operator inbox. It lists pending approvals and
  conversations that are human-owned (awaiting a human, or already taken over).
  Opening a row shows the conversation with an action bar.
- **All activity** — the full conversation history.
- **Quality** — the answer-quality triage view.

The conversation view shows message attribution (a badge for human-agent and
system messages) and an operator action bar: take over, reply, hand back, and
approve or reject a pending decision. While the view is open it reads the tail
endpoint, so new visitor messages and the operator's own replies appear without a
manual refresh.

## Approval resume and human ownership

A resume that can emit a message must defer while the conversation is
`human_owned`. The AI must never speak into a human-owned thread. Only a
host-marked side-effect-only resume may proceed. Use the reusable `canResume()`
helper exported from `backend/src/modules/handoff/public.ts` for this check.
