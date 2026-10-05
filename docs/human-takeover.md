---
title: "Human Takeover"
description: "Operator API and contract for taking over conversations, suppressing AI while handling manual responses, and reading who did what to a conversation."
last_updated: 2026-10-05
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

In the agent's **Profile → Answers** settings, turn on **Hand off on retrieval
miss** to enable this trigger.

A channel can also put a conversation in a person's hands when the agent may
not answer it. The [email channel](email-channel.md#bounds) does this with
four reasons: `operator_only_mailbox` (the mailbox only operators answer,
including one disabled or left without an agent while a draft waited),
`generation_budget` (the mailbox's hourly review budget is spent),
`review_unavailable` (the review turn failed past its retries or produced
nothing to review), and `policy_changed` (a change to the mailbox's mode or
agent superseded the draft the customer was waiting on). The conversation is `human_owned` with that reason, the
same as after any other handoff.

Both triggers request human ownership and notify an operator through the existing
contact-delivery transport with a `handoff.notify` action. They also record
`hitl.ownership` audit events. A routine hand-off's notice defaults its subject
to the routine's name and lists every value the routine collected; a
retrieval-miss hand-off has no routine to name and nothing collected, so its
notice uses the generic default subject and lists no values. Both carry the
headline, any authored intro, the entry page, and a link to the conversation in
the email and Slack text. The webhook JSON carries the ids, the reason, and the
routine — its id and name for a routine hand-off, `null` for a retrieval miss.
See [Authoring routines](./authoring-routines.md#operator-notices) for the
`handoff.notify` payload and queue semantics.

A routine can also notify operators without a handoff: a `complete` terminal
with an operator notice queues a `completion.notify` action through the same
transport. The conversation stays with the agent, so that notice changes no
ownership, records no `hitl.ownership` event, and creates no Inbox item.

## Operator API

Operators can act from the dashboard operator console (see [Operator console](#operator-console))
or directly through authenticated API endpoints under `/api/v1/conversations`.

All endpoints require a bearer workspace session with the
`workspace.conversation.takeover` permission. Every action records a
`hitl.ownership` audit event whose metadata names the acting teammate as
`actorUserId`; a transfer also records the receiving teammate as `targetUserId`.
The event is written once the action has committed, and the action stands even
if that write fails: the endpoint still answers with the new ownership, and the
failure is logged and reported with the conversation and teammate ids. The
conversation's own record of the action is its [activity](#conversation-activity),
which commits together with the action or not at all.

Ownership belongs to a person, not to the organisation. The ownership record
names the teammate handling the conversation in `ownerUserId`, and labels them in
`ownerDisplayName` with their display name, or their email until they set one.
The label is read from the teammate's profile each time, so a rename shows in the
Inbox at once. `ownerAccountId` is the organisation the workspace belongs to and
is the same for every teammate. The same ownership, label included, reaches
anyone who reads the workspace's history with an API token or through the
operator MCP server, so a teammate who has not set a display name is visible to
them by email.

A human-owned conversation is claimed exactly when it names a teammate in
`ownerUserId`. One with `ownerUserId: null` waits for a teammate: the AI stays
out of it, and the next teammate to take it over, reply, or receive a transfer
claims it. A record with `ownerUserId: null` also has `ownerDisplayName: null`
and `takenOverAt: null`. When a teammate's user is deleted, the conversations
they held wait for a teammate this way, and nothing names the deleted teammate.

The server applies the rules below on every surface: the dashboard, this API,
and [Slack](./slack-channel.md#operator-actions-in-slack).

### Take over

`POST /api/v1/conversations/{conversationId}/takeover`

Body:

```json
{
  "reason": "operator_takeover"
}
```

`reason` is optional. The response returns the current ownership record, with
you as `ownerUserId`. Take over claims a conversation that is AI-owned or waiting
for a teammate; on one you already hold it returns the record unchanged. One a
teammate already holds returns `409` with the current ownership in
`error.details.ownership`; you take it from them with a
[transfer](#transfer-ownership) to yourself, which is what the dashboard's
**Reassign → Me** does on a teammate's conversation. On an email
conversation, taking over also replaces any held reply the agent hasn't
sent, including one already queued to send automatically — see
[What replaces a draft](#what-replaces-a-draft).

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
human_agent`. Its `metadata.humanAgent` records who sent it — `accountId`,
`userId` — and the signature the visitor sees, `displayName`. The signature is
your display name, or your organisation's name if you have not set one and that
name holds no email address. With no display name and no usable organisation
name, the reply goes out unsigned and the visitor sees it from "A teammate".

Every surface — the visitor chat and embed, the dashboard, Ray, and this API —
carries a reply's stored signature in `operatorDisplayName` as it was saved,
with one exception: a signature with an email address anywhere in it is never
shown, whether or not the reply records its author in `humanAgent.userId`, and
the visitor sees that reply from "A teammate" instead.

Operator reads also name the teammate who wrote each reply. The history detail
and tail (`GET /api/v1/history/chat/{conversationId}` and its `/tail`) and Ray's
transcript tools add `operatorLabel` to a human-agent reply: the teammate label
of the user in `humanAgent.userId` — their display name, or their email until
they set one — read from their profile each time, so it follows a rename. A reply
that records no author, or whose author's user is deleted, carries its signature
there instead, by the rule above. The dashboard badges a reply with
`operatorLabel`, so teammates see who actually answered even when the visitor saw
"A teammate". The public chat API never returns `operatorLabel`.

Only the teammate who owns the conversation replies. A reply to a conversation
the AI owns, or one waiting for a teammate, claims it for you first. When
another teammate holds it, the endpoint returns `409` with code `conflict`, the
message "Another teammate is handling this conversation", and the current
ownership in `error.details.ownership`. `expectedVersion` must match the
ownership record you replied from; a stale value also returns `409` with the
current record.

On an email conversation, the reply goes out as an email in the same thread
the customer wrote to and renews the thread's
[send budget](email-channel.md#budgets) — see [Email channel](email-channel.md#send-a-reply-and-track-delivery)
for its headers and delivery states. On one whose sending domain has not
verified, the reply is refused before anything is written at all.

Otherwise, the ownership check, the saved reply, and its delivery to a
customer channel such as Slack or email commit together, with the
conversation and its ownership record locked in between. A transfer or
hand-back that commits first refuses the reply with `409`, and no message is
saved; one that arrives while the reply is being saved waits for it. The
Slack post or email send is queued on the action outbox in the same database
transaction, keyed by the message, so the worker posts or sends each reply
once and retries a failed attempt. A reply that could not be saved or queued
leaves nothing behind, so after a `5xx` you can send it again and the
visitor sees it once.

The visitor, the dashboard, and the customer channel hear of a reply only once
it has committed, and from then on the reply stands: the endpoint answers `201`
even when pushing it to the visitor's open chat or recording its audit event
fails. Those failures are logged and reported with the conversation and message
ids.

The `201` response carries `message`, the saved reply, and `ownership`, the
ownership after the reply. Its `version` moves on when the reply claimed the
conversation, so use the returned record for your next call.

### List teammates

`GET /api/v1/conversations/operators`

Returns the teammates a conversation can be handed to: active users of the
workspace's organisation who hold `workspace.conversation.takeover` on it. A
disabled teammate is left off the list and cannot receive a transfer.

```json
{
  "operators": [
    { "userId": "6f1c2d4e-8a90-4b7c-9d1e-2f3a4b5c6d7e", "label": "Dana Scully" },
    { "userId": "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "label": "fox@example.com" }
  ]
}
```

Each `label` is the teammate label: a display name, or the email until one is set.

### Transfer ownership

`POST /api/v1/conversations/{conversationId}/transfer`

Body:

```json
{
  "toUserId": "6f1c2d4e-8a90-4b7c-9d1e-2f3a4b5c6d7e",
  "expectedVersion": 3
}
```

Any teammate with the takeover permission can hand a human-owned conversation to
a teammate — one waiting for a teammate, or one someone holds. Pass your own
`userId` to take a conversation from the teammate holding it. The dashboard's
**Assign** and **Reassign** menus make this call. `toUserId` must be
one of the teammates [List teammates](#list-teammates) returns; anyone else,
including a disabled teammate or a user in another organisation, returns `404`
with code `transfer_target_unavailable`. A conversation outside the workspace
returns `404` with code `not_found`.

`expectedVersion` is an optimistic concurrency token from the ownership record.
If ownership changed since the caller read it, the endpoint returns `409` with
the current ownership record in `error.details.ownership`.

When you hand a conversation to someone else and email delivery is configured,
they get an email with a link to it in the dashboard. The email names who handed
it over and the workspace, and
carries none of the transcript. The transfer and its notice commit together:
the notice is queued on the action outbox in the same database transaction, and
the document worker sends it, so the transfer returns without waiting for the
mail provider and a failed send is retried. The worker sends the notice only if
the recipient still holds the conversation at the ownership version the
transfer produced, so a notice overtaken by a later transfer is dropped, even
when the conversation comes back to the same teammate. Taking a conversation
yourself sends nothing.

### Hand back to the AI

`POST /api/v1/conversations/{conversationId}/handback`

Body:

```json
{
  "expectedVersion": 4
}
```

The teammate who owns the conversation hands it back, or anyone while it waits
for a teammate. Anyone else gets `409` with the current ownership in
`error.details.ownership`. After hand-back, the next visitor message follows the
normal assistant path.

### List recently closed items

`GET /api/v1/conversations/recently-closed?limit=10`

Returns the Inbox items the workspace closed most recently, newest first: handoffs
handed back to the agent, approvals decided, and negative feedback resolved or
dismissed. `limit` takes 1 to 50 and defaults to 10. Dashboard test chats are left
out, as they are from the rest of the Inbox. Negative feedback is listed only to a
teammate with Quality access (`workspace.quality.read`, which owners and admins
hold); a member sees the handoffs and approvals, and the limit fills with those.

```json
{
  "items": [
    {
      "id": "9b0e7c1a-3f2d-4e5b-8a6c-1d2e3f4a5b6c",
      "conversationId": "2c4e6a8b-0d1f-4a3c-9e5b-7d9f1b3c5e7a",
      "itemKind": "approval",
      "outcome": "approval_decided",
      "closedAt": "2026-09-30T14:12:05.000Z",
      "closedBy": { "userId": "6f1c2d4e-8a90-4b7c-9d1e-2f3a4b5c6d7e", "label": "Dana Scully" },
      "decision": { "optionId": "approve", "label": "Approve refund" },
      "resolution": null,
      "assistantMessageId": null,
      "title": "Refund for order 1042",
      "preview": "Hi, I was charged twice for order 1042"
    }
  ]
}
```

`itemKind` is `handoff`, `approval`, or `negative_feedback`, and `outcome` is the
activity kind that closed it. `closedBy` names the teammate by teammate label, and
is `null` when the item was closed by a caller that is no teammate, such as an API
token, or by a teammate whose user has since been deleted. `decision` carries the
chosen option on an approval; `resolution` and `assistantMessageId` carry the
triage resolution code and the answer on negative feedback. `title` and `preview`
are the conversation's generated topic and its opening message, the same pair the
Inbox titles a row with. Requires the `workspace.conversation.takeover` permission
and a dashboard session, like the other endpoints here.

## Conversation activity

Every conversation keeps a record of what people and the agent did to it: the
agent handing it off, a teammate taking it, assigning or reassigning it, handing
it back, deciding one of its approvals, and resolving or dismissing its negative
feedback. Each event is written in the same transaction as the change it records,
by the part of Radioso that makes the change, so an action never commits without
its event, or an event without its action. Replies are not events; they are
messages already.

Feedback that was resolved or dismissed in the 30 days before the record began is
in it too, rebuilt from the triage history, so "Recently closed" and each
conversation's record start with that month's closed feedback.

The operator history detail and tail (`GET /api/v1/history/chat/{conversationId}`
and its `/tail`) carry the record as `activity`, oldest first. The detail carries
the whole list. The tail carries it too, along with an `activityCursor`; pass that
back as the next tail's `activityCursor` and the tail carries the events recorded
in the five minutes before the tail that issued it, and since. That window repeats
events you already hold, and it is what lets a late commit through: an event is
dated when it is written but visible only once its change commits, and an approval
commits together with the routine turn it resumes, which can finish after a newer
event. Keep each event once by its `id`. The cursor is opaque: pass back the one
the last tail returned, and a tail answers `400` to one it did not issue.

`feedback_resolved` and `feedback_dismissed` are Quality triage outcomes, so they
reach only a teammate with Quality access (`workspace.quality.read`). A member,
who can follow and take over conversations without that access, reads every other
kind.

```json
{
  "activity": [
    {
      "id": "0d3f5b7c-9e1a-4c2d-8f4b-6a8c0e2f4b6d",
      "kind": "handoff_requested",
      "createdAt": "2026-09-30T14:02:11.000Z",
      "actor": null,
      "subject": null,
      "from": null,
      "handoffReason": "retrieval_miss",
      "decision": null,
      "resolution": null,
      "assistantMessageId": null
    },
    {
      "id": "5e7a9c1b-3d5f-4a7c-9b1d-3f5a7c9e1b3d",
      "kind": "reassigned",
      "createdAt": "2026-09-30T14:05:40.000Z",
      "actor": { "userId": "6f1c2d4e-8a90-4b7c-9d1e-2f3a4b5c6d7e", "label": "Dana Scully" },
      "subject": { "userId": "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "label": "fox@example.com" },
      "from": null,
      "handoffReason": null,
      "decision": null,
      "resolution": null,
      "assistantMessageId": null
    }
  ]
}
```

| `kind` | What happened | Fields it fills |
|---|---|---|
| `handoff_requested` | The agent asked for a person | `handoffReason` (`routine_handoff`, `retrieval_miss`) |
| `claimed` | A teammate took the conversation, directly or by replying | `actor` |
| `reassigned` | A teammate handed it to someone, themselves included | `actor`, `subject` (the new owner), `from` (the previous owner; `null` for a handoff nobody had claimed) |
| `handed_back` | A teammate handed it back to the agent | `actor` |
| `approval_decided` | A teammate chose an approval option | `actor`, `decision` (the option's id and its label as the routine author wrote it) |
| `feedback_resolved`, `feedback_dismissed` | A teammate closed negative feedback | `actor`, `resolution` (the triage resolution code), `assistantMessageId` |

`actor` is `null` when the agent acted, which is only ever `handoff_requested`. On
any other kind, `null` means the change came from a caller that is no teammate,
such as an API token resolving feedback, or from a teammate whose user has since
been deleted: the event stays, and nothing names the deleted teammate. Every
teammate is labelled as they are now, display name or email, so a rename shows at
once. Because a label can be an email, `activity` is operator-only: the public chat
API never returns it. Events record ids and codes, never message content.

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
The same transaction records the teammate who decided and the option they chose
as an `approval_decided` [activity](#conversation-activity) event.

Operators are notified of a new pending approval through the contact-delivery
transport with an `approval.request` action, mirroring `handoff.notify`.

## Held replies

An email mailbox's review turn doesn't write a customer-visible message —
it writes a **held reply**: the agent's draft text, its judgment of the turn
(grounded? fully answered? did it ask for a person?), and whether it depends
on a skill effect that was suppressed. A held reply opens the same
`approval` attention kind a routine's [approval](#approvals) gate uses and
shows in the Inbox the same way, but it's a distinct resource with its own
list, its own release, and no `routineId` or `stepId`. Its `holdReason` is
the channel's code for why it waited. On email that's `draft_mode` on a
`draft` mailbox, `sending_not_verified` while the sending domain is
unverified, `send_budget` once the thread's
[send budget](email-channel.md#budgets) is spent, `outcome_not_publishable`
when an `auto` mailbox's turn wasn't a grounded, complete answer free of a
hand-off, `authority_changed` when ownership or the mailbox's policy
moved before an automatic reply could send, or `policy_changed` when an
operator switched the mailbox from `auto` to `draft` while the reply was
queued. See
[Email channel](email-channel.md#draft-mode-review-before-it-sends) for what
a review turn can and can't do, and what the operator's three choices mean.

On an `auto` mailbox, a reply that qualifies to send is held in state
`queued_auto` until the send worker re-checks its authority and sends it,
which moves it to `released` with the agent as the releaser. A queued reply
opens no attention item and can't be released or discarded; when the
re-check fails it returns to `pending` with `authority_changed` and opens
`approval` like any other held reply. Switching the mailbox from `auto` to
`draft` returns every queued reply to `pending` the same way, with
`policy_changed`. See
[Automatic mode](email-channel.md#automatic-mode-replies-that-send-themselves).

### List held replies

`GET /api/v1/held-replies`

Query `attention=open|all`, `agentId?`, `cursor?`, `limit` (up to 100).
Requires the `workspace.conversation.takeover` permission.

### Read a conversation's current draft

`GET /api/v1/conversations/{conversationId}/held-reply`

Returns `{ "heldReply": ... }`, or `{ "heldReply": null }` when the
conversation has no draft waiting.

### Release

`POST /api/v1/conversations/{conversationId}/held-replies/{heldReplyId}/release`

Body:

```json
{ "editedText": "Thanks for waiting — here's what I found." }
```

Omit `editedText` to send the draft exactly as written: the delivered
message is attributed to the agent. Include it to send your own wording
instead: the delivered message is attributed to you, and the original
draft stays on the held reply. Either way, release never changes who owns
the conversation — it stays `ai_owned`, the same as before the review ran —
and it renews the thread's [send budget](email-channel.md#budgets).
Returns `201` with the held reply, the new message's id, and
`"delivery": "queued"`.

A release that no longer applies is refused with `409`:
`held_reply_not_pending` (the body carries the held reply as it is now,
under `error.details.heldReply`, so you can re-render without a re-read),
`ownership_changed` (someone took the conversation over since the draft was
held), `policy_changed` (the mailbox's mode or agent changed since), or
`channel_not_ready` (the mailbox can't send right now — see
[Email channel](email-channel.md#verify-sending)).

### Discard

`POST /api/v1/conversations/{conversationId}/held-replies/{heldReplyId}/discard`

Nothing is sent. The conversation keeps its attention flag until an
operator replies or takes it over; the next inbound message on the thread
gets a fresh draft. Returns the held reply with its new state. A draft
that's already settled returns `409` with code `held_reply_not_pending`.

### What replaces a draft

A newer inbound message, a free-form operator reply, a takeover, or a
change to the mailbox's mode, agent, or enabled flag all supersede a
pending held reply before an operator acts on it: the draft is replaced,
not released, and nothing is sent for it. Where there's a new customer
message behind the supersede, a fresh review turn runs in its place.
Switching a mailbox from `auto` to `draft` keeps its drafts instead: queued
replies return to `pending` and pending ones stay, all bound to the
mailbox's new policy version so a release goes through.

An automatic reply never gets around a takeover. The same events supersede
a `queued_auto` reply, and the send worker writes the agent's message only
while the held reply is still `queued_auto` and the conversation is still
AI-owned at the version the review ran under, so a takeover that lands
before that re-check leaves the worker nothing to send.

## Delivery failures

A reply can fail after it was already accepted for delivery — a bounce, a
provider rejection, an authority check that failed before the provider was
even called, or an outcome that never resolved. Each of these flags the
conversation with a `delivery_failed` item, visible in the Inbox alongside
handoffs and approvals, carrying the failed message and a sanitized reason.
It changes no ownership; it is a flag that something meant for the customer
might not have reached them. The
[email channel](email-channel.md#send-a-reply-and-track-delivery) opens one
for each failed send; the flag belongs to no single channel, so any
channel's deliverer can open one.

A `delivery_failed` flag clears itself when later evidence from the
provider shows the message was actually delivered, or when an operator
acts on it below.

### List open delivery failures

`GET /api/v1/delivery-failures`

Query `state=open|all`, `agentId?`, `cursor?`, `limit` (up to 100). Requires
the `workspace.conversation.takeover` permission.

### Acknowledge

`POST /api/v1/delivery-failures/{failureId}/acknowledge`

Dismisses a `bounced` or `failed` failure once you've seen it and there is
nothing further to do — you've already followed up with the customer another
way, say. Returns `409` with code `already_cleared` on one that is already
cleared.

### Resolve an uncertain or halted send

`POST /api/v1/delivery-failures/{failureId}/resolve`

Body:

```json
{ "decision": "marked_sent" }
```

`decision` is `marked_sent` for a send whose outcome never resolved
(`uncertain`), once you've confirmed delivery some other way, or `resend`,
which sends a fresh copy under a new idempotency key and is recorded
against you. `resend` is available for an `uncertain` or `halted` send once
sending is ready again; a domain still unverified returns `409` with code
`email_sending_not_verified`. Radioso never resends a send on its own — this
is the only path to a second attempt. A send that is not `uncertain` or
`halted` returns `409` with code `not_resolvable`.

## Live updates

Both surfaces can read forward for new messages instead of refetching the whole
transcript. The public visitor surface can also subscribe to push notifications.

- Operator: `GET /api/v1/history/chat/{conversationId}/tail?cursor=...&activityCursor=...`
- Visitor: `GET /api/v1/public/chat/{token}/tail/{conversationId}?cursor=...`
- Visitor push: `GET /api/v1/public/chat/{token}/events/{conversationId}`
- Calling agent: `GET /api/v1/mcp/converse/messages?cursor=...&waitMs=...`

Each tail call returns messages created after the cursor plus an advanced cursor.
Conversation detail responses include `tailCursor`, which clients should use for
follow-up tail calls. With no cursor, tail returns the newest bounded page and a
cursor for the newest returned message. Messages include `source`, so a visitor
sees a human reply distinctly, plus `operatorDisplayName` on a human-agent reply
so the visitor can see who is answering (rendered as "👤 <name>"). That name is
the reply's signature: the teammate's display name, or the organisation's name.
Only the name is exposed — never an email, user id, or account id — and an
unsigned reply, or one whose only signature is an email address, shows as
"👤 A teammate". The operator tail also includes each reply's `operatorLabel`
and, once a teammate has been involved in the conversation, its `ownership`
record — AI-owned after a hand-back — so a reader polling the tail sees a claim,
transfer, or hand-back made elsewhere. The operator conversation detail carries
the same record, so whichever of the two a reader loaded last, the higher
`version` is the current one. Both also carry the conversation's
[activity](#conversation-activity). The visitor tail and detail carry none of these.

The third caller is an AI agent on the other side of the MCP converse surface. It
holds a conversation with the agent but cannot watch a chat window, so it reads
the same messages forward through `GET /api/v1/mcp/converse/messages` — the
`get_conversation_updates` tool over standalone MCP — and can hold that call open
for up to 25 seconds while it waits for your reply. Each message it reads carries
`author`, `human` for your reply and `agent` for everything else, and every page
carries the conversation's current ownership, so the caller knows a person is
handling the conversation. Answering from the Inbox is all it takes for that
reply to reach the caller: nothing about takeover or reply changes for the
operator. See [MCP Client Setup](./mcp-client-setup.md#come-back-after-a-handoff).

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
type, agent, and **Taken by**, which groups items by teammate — **Me** matches
the conversations you hold; critical escalations — an approval
to decide, a handoff awaiting or held by a human — sort to the top, followed
by written negative feedback ordered by its latest creation or edit.
Automatically detected signals and uncommented feedback stay in **Quality**
instead of creating an inbox row per answer.

Both lenses share the same reading pane. For an actionable conversation —
one awaiting a human or already human-owned — selecting it shows a one-line
header naming the visitor, the page they were on, and how long they have
been waiting; a situation card with the handoff reason and the visitor's
opening request; the live transcript; and a reply composer. Sending a reply
claims a conversation nobody holds yet — there is no separate take-over step.
**Assign** next to Send places a conversation waiting for a teammate: **Me**
first, then every teammate who can take it. Once someone holds the conversation,
the menu reads **Reassign** and lists **Me** and every teammate except whoever
holds it; on one you hold, it lists your teammates. Choosing a teammate transfers
the conversation to them, and they get an email with a link when email delivery
is configured. When a teammate holds the conversation, the composer gives way to
"Dana Scully is handling this · **Reassign**", so two people never reply blind;
Reassign → **Me** transfers it to you and brings the composer back, with anything
you had drafted still in it. Messages carry attribution: a human reply's badge
names the teammate who wrote it, by display name or email, and system messages
have a badge of their own. Between the messages, short muted lines tell the
conversation's story as it happened: "Handed off · No answer found", "Dana Scully
took this", "Dana Scully assigned this to Fox", "Fox handed this back to the
agent", "Dana Scully decided · Approve refund", "Fox resolved the feedback". The
debug drawer shows the same lines. The pane reads the tail endpoint while open, so new
visitor messages, your own replies, and a take-over, reassignment, or hand-back
made elsewhere appear, line included, without a manual refresh. Until the dashboard knows who
you are, the pane shows none of the controls that depend on it — no "is handling
this" line, no Assign or Reassign, and no Done on a handoff.
**Done** closes a handoff and hands the conversation back to the agent; it shows
when you hold the conversation or nobody has claimed it. A conversation shows as
one row: while it also has an open handoff or approval, the Inbox folds its
negative feedback into that row instead of listing it separately, so Done there
closes the handoff or approval, not the feedback. Once the conversation is back
with the agent, the feedback appears as its own item, and **Done** on it opens
the same resolution-reason flow Quality → Review uses to classify it — closing
it leaves ownership alone. An approval closes when you choose one
of its decision options — it needs no separate Done step. For any other conversation, the
reading pane is read-only, with an outcome footer in place of the composer.

Below the queue, **Recently closed** lists the last ten items closed — handoffs
handed back, approvals decided, and negative feedback resolved or dismissed —
each with what it was and "Closed by Dana Scully · 30 Sept, 2:12 PM". Selecting
one opens its conversation in the reading pane. Resolved and dismissed feedback,
there and in the transcript's lines, shows only to teammates with Quality access.

The browser tab title carries the count of open items, and a soft sound plays
when a new handoff or approval arrives while the dashboard is open.

An **Open in debug view** link, available from either lens, opens the
conversation drawer: transcript, Debug, Flow, a button to continue the
conversation in test chat, and a button to send it to Eval. The drawer is for
inspecting and testing a conversation — replying, taking over, handing back,
and approving or rejecting a pending decision all happen from the reading
pane instead.

Ray reads the same queue. Ask it what is waiting and it lists the open
approvals, handoffs, and commented negative feedback longest wait first, each row
carrying the decision or turn behind it and the number of rows its source
matched. Its conversation transcript carries the conversation's latest 40 activity
events, so it can say who took a handoff, who handed it back, and which option a
teammate chose — and, for a teammate with Quality access, who resolved or
dismissed the feedback. Ask it to close a reviewed turn and it writes the triage state and
resolution reason against the version it read, reporting a conflict when another
operator moved the row first. It also drafts a reply by replaying the agent over
the conversation's own transcript, with every outward-reaching skill suppressed,
and hands you the text to edit and send from the composer. Sending, claiming,
handing back, transferring, and deciding an approval stay with the operator, and
Ray answers a request for any of them with the reason and the link.

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
