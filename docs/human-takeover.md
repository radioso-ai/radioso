---
title: "Human Takeover"
description: "Operator API and contract for taking over conversations and suppressing AI while handling manual responses."
last_updated: 2026-08-30
---

# Human Takeover

Human takeover lets an operator own a conversation while the AI stays silent.
It is used when a conversation should move from automated handling to a named
human responder.

## Ownership states

Each conversation is either `ai_owned` or `human_owned`.

When a conversation is `ai_owned`, visitor messages follow the normal assistant
path. The assistant may run routines, retrieval, skills, model calls, and action
outbox work.

When a conversation is `human_owned`, Radioso suppresses the normal AI turn for
that conversation. New visitor messages are still saved, but the assistant does
not run routines, perform retrieval, dispatch skills, call the answer model, or
enqueue assistant outbox actions.

Before a teammate replies, the assistant returns one short waiting line instead
of an answer, such as "a teammate is joining, please wait." The line is generated
by the model in the conversation's language, so it is multilingual, and it
repeats on each further visitor message while the conversation is still waiting.

Once an operator has replied in the thread, the teammate has joined. Later
visitor messages then get no AI reply at all and simply wait for the operator, so
the visitor is never told a teammate is "joining" after one is already there. If
the waiting line cannot be generated, the visitor turn also produces no reply.
The AI stays suppressed until an operator explicitly hands the conversation back.

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
sees a human reply distinctly, plus `operatorDisplayName` on a human-agent reply
so the visitor can see who is answering (rendered as "👤 <name>"); only the name
is exposed, never the operator's account id. The operator tail also includes
`ownership`; the visitor tail never does.

## Operator console

The dashboard surfaces this work in the **Inbox**, a top-level sidebar item
ahead of Agents, Knowledge Base, Audience Pulse, and Quality, with a badge
showing the count of open items.

The Inbox is a two-pane page with a lens toggle at the top of the left pane.
**Needs you** is the default lens: the queue of everything waiting on a
person — handoffs, approvals, and negative feedback. **All** lists every
conversation, newest first, each row titled with a short topic the model
generates from the conversation — falling back to the visitor's opening
message until a topic exists — with an outcome chip (In progress, Completed,
or Handed off) plus search and filters for outcome, agent, and site.

In **Needs you**, the left pane lists open items with search and filters for
type, agent, and who has taken each one; critical escalations — an approval
to decide, a handoff awaiting or held by a human — sort to the top, followed
by written negative feedback ordered by its latest creation or edit.
Automatically detected signals and uncommented feedback stay in **Quality**
instead of creating an inbox row per answer.

Both lenses share the same reading pane. For an actionable conversation —
one awaiting a human or already human-owned — selecting it shows a one-line
header naming the visitor, the page they were on, and how long they have
been waiting; a situation card with the handoff reason and the visitor's
opening request; the live transcript; and a reply composer that stays
visible throughout. Sending a reply claims the item for you — there is no
separate take-over step. Messages carry attribution (a badge for human-agent
and system messages), and the pane reads the tail endpoint while open, so
new visitor messages and your own replies appear without a manual refresh.
**Done** closes a handoff and hands the conversation back to the agent; on a
negative-feedback item, **Done** opens the same resolution-reason flow
Quality → Review uses to classify it. An approval closes when you choose one
of its decision options — it needs no separate Done step. For any other conversation, the
reading pane is read-only, with an outcome footer in place of the composer.

The browser tab title carries the count of open items, and a soft sound plays
when a new handoff or approval arrives while the dashboard is open.

An **Open in debug view** link, available from either lens, opens the
conversation drawer: transcript, Debug, Flow, a button to continue the
conversation in test chat, and a button to send it to Eval. The drawer is for
inspecting and testing a conversation — replying, taking over, handing back,
and approving or rejecting a pending decision all happen from the reading
pane instead.

**Quality** is a separate top-level section with two pages. **Review** is the
answer-quality triage view, covering answer quality in two zones with
different scopes. **Health** covers a rolling 7- or 30-day window: answer
volume, grounded-answer rate, negative-feedback rate, and skill-failure rate,
each shown against the equal preceding window. **Queue** is the full,
paginated backlog and per-turn triage for negative feedback, grounding gaps,
and skill failures. The Inbox links to this union as one deduplicated count
rather than listing its automatic signals individually. The queue is not
windowed, so a turn that is still untriaged stays visible however old it is.
Its resolution breakdown and filters open exact reason/closure-time queues,
while **Add to Eval** preserves a failed answer, which then shows timestamped
run evidence and appears on the **Evals** page.

A turn only counts as a grounding gap when the agent tried to ground an answer
and came up empty. When it declines because the question falls outside what its
instructions cover — the capital of Mars, a maths puzzle, an attempt to talk it
out of its own remit — the turn carries the **Out of scope** action instead, and
sits on neither side of the grounded-answer rate. That keeps the gap queue to
the questions worth ingesting content for.

For retrieval answers with a complete diagnostic, the Outcome cell explains the
evidence: how many claims were sourced, plus separate warnings for unsourced
claims and invalid source references. A no-support answer with zero claims says
`No supported claims`; turns without a complete diagnostic show no evidence
line, so missing history is not mistaken for a zero. Open **Filter → Evidence**
to select one or more grounding verdicts or focus on answers with unsourced
claims or invalid sources. These choices live in the URL and can be shared.

The same data is available from `GET /api/v1/quality/turns` as
`grounding: { verdict, claimCount, sourcedClaimCount, unsourcedClaimCount,
invalidSourceCount }` or `null`. Use `groundingVerdict` (CSV or repeated),
`hasUnsourcedClaims`, and `hasInvalidSources` to filter server-side. A `false`
presence filter matches complete diagnostics with a zero count; it does not
match unknown diagnostics.

Both zones measure AI turns only. A reply you write from the Inbox is stored
as an assistant message, but it carries your authorship, so it is left out of the
quality counts and rates. The same applies to conversations from the dashboard
test chat, the workbench replay, and Ray's agent-turn probes. In practice this
means your own work as an operator never moves the agent's quality numbers.

## Approval resume and human ownership

A resume that can emit a message must defer while the conversation is
`human_owned`. The AI must never speak into a human-owned thread. Only a
host-marked side-effect-only resume may proceed. Use the reusable `canResume()`
helper exported from `backend/src/modules/handoff/public.ts` for this check.
