---
title: "Email Channel"
description: "Connect a support mailbox to a Radioso agent by forwarding, review and send the agent's drafted replies or let grounded ones send themselves, bound what runs without a person, verify sending on your own domain, reply with delivery tracked through to the customer, and work the mailbox event log and raw mail from operator settings."
last_updated: 2026-10-07
---

# Email Channel

The email channel lets a customer reach a Radioso agent at an address they
already know, such as `support@customer.com`, without Radioso taking over
that mailbox. The customer's mail service forwards to a relay address
Radioso gives you; replies go out as the real address once you've added a
couple of DNS records. Every email the channel accepts is visible to an
operator somewhere — as a conversation in the Inbox, or as an event in the
mailbox's event log when it never becomes one.

A mailbox runs in one of three engagement modes. `draft` is the default for a
new mailbox: the agent runs a review turn on every accepted email and writes
a reply, which stays held until an operator sends it, edits it, or discards
it — see [Draft mode](#draft-mode-review-before-it-sends) below. On an
`auto` mailbox the same review turn runs, and a reply that is grounded,
complete, and free of a hand-off goes to the customer with no one in the
loop; everything else is held as in `draft` — see
[Automatic mode](#automatic-mode-replies-that-send-themselves). On an
`operator_only` mailbox every accepted email opens or continues a
human-owned conversation, and the agent never runs a turn on it. In every
mode, the limits under [Bounds](#bounds) cap what runs without a person.

Not every accepted email gets a reply. On a `draft` or `auto` mailbox,
before the review turn starts, a brief check reads the customer's mail
since the business last wrote and decides whether it calls for a reply at
all. A thank-you or an acknowledgement that asks nothing gets neither a
reply nor a draft — the conversation shows a note instead, and the
thread's send budget stays untouched. A thank-you that also asks something
is answered the usual way.

Email conversations never auto-close. Like any other channel, what decides
whether a conversation needs attention is whether a person must act on it —
not how long it's been quiet.

## Topology

Each connected mailbox gets an opaque relay address on an inbound domain Radioso
operates — `EMAIL_CHANNEL_INBOUND_DOMAIN`, for example `in.eu.radioso.ai` on
Radioso Cloud's EU stack. You forward your existing address to that relay
address from whatever mail service you already use, and your mailbox never
moves. Receiving needs no DNS at all: a mailbox can be live the moment
forwarding is set up.

Sending is separate from receiving. Once you've added the DKIM and SPF
records Radioso shows for your domain, replies go out `From` your real
address, not the relay. Those records are additive — they don't touch
anything else on your domain.

The channel reaches Resend with `RESEND_CHANNEL_API_KEY`, or with
`RESEND_MAIL_API_KEY`, the key transactional mail uses, when the channel has
none of its own. With `EMAIL_CHANNEL_PROVIDER=resend` and neither key set,
the backend refuses to start.

**Direct receiving** is an advanced option for a customer-owned domain or
subdomain: you point its MX record at Radioso instead of forwarding. Typing
the domain to confirm turns this on, because it means *all* mail for that
domain routes to Radioso, not just the addresses you've connected. Radioso
resolves a mailbox from an inbound address one of two ways, and no other:
the address's local part is a current relay token on the inbound domain
(the default path), or the address's domain is a domain you've confirmed for
direct receiving and the address matches a connected mailbox on it (the
`+tag` part ignored, so plus-addressed threading still works). An address on
your own domain that hasn't been confirmed for direct receiving never
resolves a mailbox — a forwarded email keeps the relay address regardless of
what your original `To:` line said.

**Data residency.** Resend, the channel's email provider, stores account
data — including email metadata, logs, and API records — and received
message content in the United States regardless of which region a
workspace or domain operates in. That holds for Radioso Cloud's EU stack as
much as its US one.

## Connect a mailbox and forward to it

Add the mailbox in agent settings or through the API, and Radioso returns a
relay address on the inbound domain. Forward your real address to it from
your mail service. The setup check waits for a message you send to your
real address and flips the mailbox's receiving state to `ok` once it lands
through the relay — proof the forward actually works, since a forwarding
rule you control later is invisible to Radioso. A mailbox that's received
mail before and then gone quiet past its silence threshold shows a notice
with the last-received time, for the same reason.

**Google Workspace and Gmail** confirm forwarding by emailing a code or link
to the destination address before they'll forward anything to it. Because
the relay address is the destination, that confirmation email arrives at the
relay directly — Radioso records it as an event on the mailbox before any
forwarding rule exists. Open the event's raw view in settings to read the
code, then enter it on the Google side. Radioso never follows links in
inbound mail itself.

**Microsoft 365** blocks external automatic forwarding by default. A tenant
admin has to change the outbound anti-spam policy to allow it first — skip
this and the forward fails with an NDR, not a confirmation. Once the policy
allows external forwarding, create the forwarding rule pointed at the relay
address.

**Replacing the relay address.** If a relay address leaks or you want a
fresh one, **Replace relay address** on the mailbox card issues a new one
(`POST
/api/v1/workspaces/{workspaceId}/email-channel/mailboxes/{mailboxId}/relay-token/rotate`).
The old address keeps forwarding for seven days, so update your forwarding
rule to the new address inside that window.

**Disabling a mailbox.** **Disable mailbox** on the card pauses a mailbox
without removing it (through the API, `PATCH` the mailbox with
`"enabled": false`). Mail sent to a disabled mailbox is recorded in the
event log and nothing answers it; its pending drafts are superseded, so
nothing of them is sent, and their conversations go to a person. **Enable
mailbox** turns it back on for mail that arrives from then on.

## Verify sending

Adding a mailbox registers its domain as a sending domain if it isn't one
already, and the settings card shows the DKIM and SPF records (plus a
DMARC recommendation) with a copy button and a status per record —
`pending`, `verified`, or `failed`. A domain can only be claimed by one
workspace; adding one already in use elsewhere is refused without naming
who has it.

A mailbox accepts inbound regardless of whether its domain is verified. Until
it is, an operator's reply is refused before anything is written, with the
missing step named — retrying once the domain verifies is safe. Removing a
sending domain revokes its authority first, halts anything queued to send,
and keeps every conversation and its history intact. The provider-side
cleanup follows within a few minutes, and adding the same domain again
waits for it (`409 domain_removal_pending`).

**Domain already registered on the provider.** Sometimes the email provider
already holds the domain you add: your operations team registered it on the
same account, another Radioso deployment shares the account, or an earlier
attempt reached the provider but its answer never came back. Radioso can't
tell whose registration it is, so it never takes one over on its own. The
domain shows up in settings and the overview with
`registration.status: needs_reconciliation`, and mailboxes on it are refused
with `409 domain_needs_reconciliation` until you decide. If the registration
is yours to use, adopt it from the domain's settings, or call
`POST /api/v1/workspaces/{workspaceId}/email-channel/domains/{domainId}/reconcile`
with `workspace.settings.manage`. Radioso looks the domain up on the
provider, adopts that registration for this workspace, and records who did it
in the audit log. If the provider no longer has it, the domain is registered
afresh instead. If it belongs to someone else, remove the domain here and sort
it out on the provider account first.

## Send a reply and track delivery

Reply to an email conversation from the Inbox the same way you'd reply on any
other channel. It goes out `From` the mailbox's real address and display
name — `support@customer.com`, not the relay — once that domain's sending
records have verified; until then the reply is refused before anything is
written, with the missing step named (see Verify sending, above).

**Headers.** Every outbound email carries a `Message-ID` Radioso generates on
the sending domain, plus `In-Reply-To` and `References` naming the message it
continues. The provider assigns its own id on its own domain when it accepts
the send, and that's the id Radioso looks up and records right after
sending, rather than trust the one it supplied — thread matching then works
against whichever id the customer's mail client ends up quoting.
`Reply-To` is set to the mailbox's real address so the customer's reply
travels through their forward; once the mailbox's setup check has proven
that a plus-addressed message actually reaches the relay, `Reply-To` also
carries an opaque plus-address thread token, which keeps the reply on the
right thread even if the customer's client drops `In-Reply-To` and
`References`. Before that check has passed, `Reply-To` carries no token, so
a reply can't bounce against a forward nobody has proven handles
plus-addressing. Agent-authored mail carries `Auto-Submitted:
auto-generated`; an operator's reply carries no `Auto-Submitted` header at
all.

**Delivery states.** Each outbound message shows one state:

| State | What it means to you |
|---|---|
| `queued` | Recorded and waiting on its first attempt to the provider. |
| `accepted` | The provider has taken the message; it hasn't confirmed the mailbox received it yet. |
| `delivered` | The provider confirms the message reached the customer's mail server. |
| `bounced` | The provider or the customer's own mail service rejected it — a bad address, a full mailbox, a policy block. The sanitized reason is on the message. |
| `failed` | The provider rejected the send outright, or an automatic reply lost its authority after its message was written and before it reached the provider. The reason is on the message. |
| `uncertain` | The outcome never resolved. See below — it needs an operator decision, never an automatic resend. |
| `halted` | The domain or mailbox lost sending authority after the reply was queued, so nothing was ever sent to the provider. |

`bounced`, `failed`, `uncertain`, and `halted` each flag the conversation
with a `delivery_failed` item in the Inbox. [Human Takeover](human-takeover.md#delivery-failures)
covers clearing that flag. The Inbox reads up to 1,000 open drafts and
1,000 open delivery failures, newest first. When more are waiting, it says
so, and **Load older** reads the next batch, as often as it takes to reach
the oldest.

**When a send is uncertain.** A crash or a timeout between Radioso and the
provider doesn't risk sending the customer two emails: every send carries a
stable idempotency key and a frozen copy of its request, so a retry inside
the provider's 24-hour idempotency window replays byte-for-byte, and the
provider either returns the original result or sends exactly once. That
retry happens on its own. Only once that window closes with the outcome
still unknown does the send become `uncertain` — and from there, nothing
resends it automatically. An operator resolves it: mark it sent, once
you've confirmed delivery some other way (the customer replied, say), or ask
for a resend, which sends a fresh copy under a new idempotency key and is
recorded against the deciding operator. A domain or mailbox that lost
sending authority while a send was still unresolved skips straight to
`uncertain` with no further retry, since there would be nothing valid left
to retry with.

**Reconciliation lookups.** A send the provider accepted but never reported
on is looked up 24 hours later. A lookup the provider refuses outright makes
the send `uncertain` at once; one it can't answer for now, during an outage,
is retried until two days after the provider accepted the send, and then the
send goes `uncertain` too.

**Late provider evidence.** A provider event or a reconciliation lookup can
report a delivery outcome after a send has already gone `uncertain`.
Radioso applies it without any operator step: a late `delivered` clears the
flag on its own, while a late `bounced` or `failed` keeps the flag open,
now carrying that reason. Late evidence about an earlier attempt updates
that attempt only: once you've asked for a resend, the newer copy keeps its
own status and stays resolvable on its own evidence.

## Draft mode: review before it sends

On a `draft` mailbox, an accepted email runs a *review turn* instead of an
ordinary chat turn. The agent reads the thread and writes a reply, but
nothing it decides takes effect on its own: it runs no skill with an
outward effect, activates no routine, and never gets as far as a message a
customer could see. The whole output is a **held reply** waiting for an
operator in the Inbox. If the agent needed a suppressed action to answer
completely, the held reply says so, and the draft text itself doesn't claim
the action happened. A review that ends with no usable text creates no held
reply at all — the conversation is flagged with the engine's own hand-off
reason instead.

A held reply carries the turn's judgment along with its text: the outcome
(Answered, No matching documents, Out of scope, Answer unavailable), whether
the answer is grounded and how completely it covers the question, and why it
asked for a person if it did. A held reply that depends on a suppressed
action shows a badge naming which skill didn't run. One line says why the
channel held it instead of sending it — `Held: this mailbox drafts every
reply for review`, or `Held: this thread’s automatic replies are used up`
— read from its hold reason, so it shows even when the turn's reasoning
can't be read.

Reviewing a draft, an operator has three options:

- **Send it as written.** The draft becomes a customer-visible message
  attributed to the agent, delivered with `Auto-Submitted: auto-generated`
  (see Headers, above).
- **Edit it, then send.** The delivered message is attributed to the
  operator instead, with no `Auto-Submitted` header, and the original draft
  stays on the held reply for anyone who opens it later.
- **Discard it.** Nothing is sent. The conversation keeps its attention flag
  until an operator replies or takes it over, and the next inbound email on
  the thread gets a fresh draft.

Releasing a held reply — as written or edited — never changes who owns the
conversation; it stays `ai_owned`, exactly as before the review ran. Only a
free-form operator reply or an explicit takeover hands a conversation to a
person, the same as on any other channel — or a change to the mailbox that
supersedes the draft, described next. A held reply is visible only to
operators: it never appears in the customer's message history, the public
chat API, or a conversation transcript, in any of its states.

**What replaces a draft.** A held reply is live only while it's pending (or,
on an `auto` mailbox, queued to send), and exactly one thing happens to it
next. A newer inbound message, a free-form operator reply, a takeover, or a
change to the mailbox's mode, agent, or enabled flag all *supersede* a
pending draft: it's replaced rather than released, and nothing is sent for
it. Where there's a new customer message behind the supersede, a fresh
review turn runs in its place. A policy change has no new message behind
it, and the customer is still waiting on the one the draft answered, so in
the same transaction the conversation goes to a person, unclaimed, and shows
in the Inbox as a handoff: with reason `operator_only_mailbox` when the
mailbox no longer reviews mail (it's `operator_only`, disabled, or has no
agent), and `policy_changed` for any other change, such as an upgrade to
`auto` or a different agent. A conversation a person already owns stays
with them. The one policy change that keeps drafts is
switching an `auto` mailbox to `draft`: they stay with your team for review
(see [What hands a reply back to a person](#what-hands-a-reply-back-to-a-person)).
Two operators releasing the same draft at the same instant produce exactly
one send; the other sees that it was already handled. See [Human Takeover](human-takeover.md#held-replies) for
the operator API this runs on.

Several emails on one thread in quick succession get one draft between them
— see [Coalescing](#coalescing).

## Automatic mode: replies that send themselves

On an `auto` mailbox the agent answers a customer by email with nobody in
the loop, but only when its turn shows a complete, grounded answer. Every
accepted email runs the same review turn as in
[draft mode](#draft-mode-review-before-it-sends), under the same
restrictions: no skill with an outward effect runs and no routine
activates. What differs is what happens to the result. A *publication
decision* reads the turn's typed facts and either sends the reply or holds
it for an operator exactly as a `draft` mailbox would — with one exception,
the last check below, which reads the candidate reply itself once every
other check has passed.

### What qualifies a reply for sending

The decision runs these checks in order. The first one that fails holds the
reply, with that check's reason:

| Check | Hold reason when it fails |
|---|---|
| The conversation's ownership and the mailbox's policy are still the ones the review ran under | `authority_changed` |
| The mailbox's sending domain is verified | `sending_not_verified` |
| The mailbox runs `auto`, both when the email was accepted and now (see [Policy at acceptance](#policy-at-acceptance)) | `draft_mode` |
| The thread's [send budget](#budgets) has room | `send_budget` |
| The turn is grounded, fully answered, asked for no person, and needed no suppressed skill effect | `outcome_not_publishable` |
| A model check reading the customer's email and the candidate reply finds the reply covers everything asked | `incomplete_answer` |

Only a reply that passes all six is sent. Replies are sent automatically
only when they answer everything asked: that last check runs once every
other one has passed, reading the customer's unanswered email alongside the
candidate reply, and a reply that leaves any part of the question
unanswered waits for an operator instead, labelled Partly answered or Not
answered in the Inbox so a teammate can see at a glance what's missing; one
the check itself couldn't judge is labelled Coverage unavailable. A partial
answer, no matching documents, an out-of-scope question, a hand-off
request, or an answer that depended on a suppressed skill effect each
becomes a held reply with its outcome labelled and an `approval` flag in
the Inbox, where an operator sends, edits, or discards it as on a `draft`
mailbox. A turn with no usable text creates no held reply; the conversation
goes to a person with the engine's hand-off reason, or
`review_unavailable`. A human-owned conversation never gets a review turn
at all.

### From queued to sent

A reply that qualifies is queued before it becomes a message. In one
transaction, Radioso confirms that the conversation's ownership and the
mailbox's policy are still the ones the review ran under, spends one of the
thread's automatic sends, records the held reply in state `queued_auto`,
and enqueues an `email.send` job keyed `email:send:held:<heldReplyId>`.
While it's queued, the reply exists only as a held reply: operators can see
it, and the customer's message history, the public chat API, and
transcripts never contain it. If the ownership or the policy moved, or a
newer customer message arrived, between the decision and the queue, the
reply is held with `authority_changed` instead. If a concurrent send took
the budget's last slot, it's held with `send_budget`.

**Re-authorization at dispatch.** When the send worker picks up the job, it
checks authority again under the conversation's lock: the mailbox is
enabled and still `auto` at the policy version the review ran under, the
conversation is still AI-owned at the same ownership version, the thread's
send budget still has room for the reply at its current limit, and the
sending domain is verified. When every check passes, one transaction writes
the agent's message, moves the held reply to `released` with the agent as
the releaser, and records the send intent. From there it's an ordinary outbound
send: `Auto-Submitted: auto-generated`, the same
[delivery states](#send-a-reply-and-track-delivery), the same idempotent
retries. When any check fails, the customer sees nothing: the held reply
returns to `pending` with hold reason `authority_changed`, the conversation
is flagged `approval`, and no message or send intent is written.

### What hands a reply back to a person

- **The decision holds it**, for any reason in the table above.
- **The mailbox drops to `draft`.** Switching an `auto` mailbox to `draft`
  halts every reply still queued to send: each returns to `pending` with
  hold reason `policy_changed`, the conversation is flagged `approval`, and
  a teammate sends, edits, or discards it from the Inbox. Drafts already
  pending stay pending under their own hold reason. Both are bound to the
  mailbox's new policy version, so a release goes through. The `email.send`
  queued for a halted reply finds nothing to send.
- **The thread send budget changes.** Changing a mailbox's
  `threadSendBudget` writes a new policy version and treats its replies the
  way a drop to `draft` does: each one still queued returns to `pending`
  with hold reason `policy_changed`, so none goes out under a limit it was
  never checked against.
- **Something replaces it while it's queued.** A newer customer message, a
  free-form operator reply, a takeover, removing the mailbox, or any other
  change to the mailbox's mode, agent, or enabled flag supersedes a
  `queued_auto` reply the same way
  it supersedes a pending draft. Nothing is sent for it, and a newer customer
  message gets a fresh review; a policy change hands the conversation to a
  person instead. A takeover always wins over a queued reply —
  see [Human Takeover](human-takeover.md#what-replaces-a-draft).
- **Authority fails at dispatch.** The reply returns to `pending` with
  `authority_changed`, as described above.
- **Authority fails after the message is written.** When the worker stops
  between writing the agent's message and calling the provider, the send is
  checked again when it's picked up. If the conversation was taken over, the
  mailbox's policy changed, or the thread's budget no longer covers it, it
  never goes out: the send ends `failed` with that reason and flags
  `delivery_failed` for whoever handles the conversation now.
- **Authority changes after the provider call.** A send whose provider
  outcome is still unknown stays an ordinary send. If the mailbox or domain
  loses sending authority in that window, Radioso neither halts nor
  re-queues it: it goes `uncertain` at once and flags `delivery_failed`, and
  an operator resolves it as described under
  [Send a reply and track delivery](#send-a-reply-and-track-delivery).

### Send budget renewal

Every automatic send spends one slot of the thread's `threadSendBudget` (3 by
default) when it's queued. An operator reply on the thread renews the
budget, and so does an operator releasing a held reply, as written or
edited; the count resets when that send is recorded. Customer mail never
renews it, so a customer, or an autoresponder that gets past the
[automated-mail](#automated-mail) check, draws at most three automatic
replies in a row before a person has to step in. A queued reply that goes
back to `pending` keeps the slot it spent, which errs toward holding.
`GET /api/v1/conversations/{conversationId}/email` returns the count, the
limit, and the last renewal time under `sendBudget`.

### Turning it on

A mailbox is never `auto` by default; switching it takes an explicit opt-in.
In the mailbox's card, choose **Automatic** under **Mode**. The card asks
you to confirm and names the budget the agent runs within — "The agent
sends grounded replies on its own, up to 3 per thread until an operator
replies." — and confirming records the opt-in. Through the API, setting
`engagementMode` to `auto` when you create a mailbox, or with `PATCH
/api/v1/workspaces/{workspaceId}/email-channel/mailboxes/{mailboxId}`, needs
`autoOptIn` alongside it:

```json
{ "engagementMode": "auto", "autoOptIn": true }
```

Without it the request is refused with `400` and code
`auto_opt_in_required`. The switch applies to mail accepted afterwards;
mail accepted earlier keeps the mode it arrived under, and drafts already
pending are superseded, their conversations handed to a person with reason
`policy_changed`. Switching away from `auto` stops every automatic
send that hasn't gone out: to `draft`, the queued replies come back to your
team for review; to `operator_only`, they're superseded along with pending
drafts, and their conversations go to a person with reason
`operator_only_mailbox`. Changing the mailbox's agent or enabled flag
supersedes its pending and queued replies too, and hands their
conversations to a person the same way.

### Rollout and rollback

Turn on `auto` for a mailbox after its team has run it in `draft` and
reviewed real drafts, and after every outcome that shouldn't publish —
partial answer, no matching documents, out of scope, hand-off, unavailable
turn, spent send budget — has been seen to hold rather than send. Then the
mailbox owner opts in. Radioso enforces the opt-in; the first two gates are
the operator's to check.

On a deployment that doesn't run `auto`, an `auto` mailbox's mail runs
under `draft`, and the five-minute sweep sends any reply left in
`queued_auto` for more than five minutes through the dispatch check, which
refuses it: the reply returns to `pending` with `authority_changed` and an
`approval` flag. A queued reply never goes out without an operator there.
To stop one mailbox, switch it to `draft` or `operator_only`.

## Bounds

One vacation responder, one mailing list, or one burst of new threads could
run up model spend and outbound mail in minutes if nothing capped it. Every
automatic behavior on a mailbox has a limit, and hitting one hands the work
to a person: nothing accepted is dropped.

### Budgets

Each mailbox carries two limits. Edit them in the **Limits** section of
the mailbox's card, which saves only the fields you changed, or set them
through the API when you create the mailbox or with `PATCH
/api/v1/workspaces/{workspaceId}/email-channel/mailboxes/{mailboxId}`.
**Replies per thread** sits with the mailbox's other settings; **Agent
runs per hour** sits behind a collapsed **Advanced** disclosure, alongside
the silence alert threshold:

| Setting | In the card | What it bounds | Default | Range |
|---|---|---|---|---|
| `hourlyGenerationBudget` | Agent runs per hour | Review turns the mailbox runs per hour | 30 | 1–1000 |
| `threadSendBudget` | Replies per thread | The agent's automatic sends on one thread between renewals | 3 | 1–20 |

**Generation budget.** The hour is a fixed window: it opens at the first
review turn after the previous window closed and runs sixty minutes from
there. Each review revision is charged once, so a review that retries after
a failure doesn't pay twice. Once the window is full, mail keeps arriving
but stops getting reviews: each accepted email opens or continues a
human-owned conversation with handoff reason `generation_budget`, shown in
the Inbox like any other handoff, and the event log records the same reason
on the delivery. Reviews resume when the window rolls over. A conversation
already handed to a person stays with them until someone hands it back.

**Thread send budget.** This counts the agent's automatic sends on a thread
since the last renewal. An operator's reply on the thread renews it, and so
does an operator releasing a held reply, as written or edited. Customer
mail never renews it, so an autoresponder that answers every reply can't
keep the agent talking. When the count reaches the budget, the next reply
is held for an operator with hold reason `send_budget`, as an `approval`
item in the Inbox. On a `draft` mailbox every reply goes out through an
operator's release, which renews the budget, so the count stays at zero.
On an `auto` mailbox, see [Send budget renewal](#send-budget-renewal).
`GET /api/v1/conversations/{conversationId}/email` returns the count, the
limit, and the last renewal time under `sendBudget`.

**Thread context.** A review turn reads only the thread's 10 newest
messages, so a forty-message thread costs a review no more than a
ten-message one.

**Review retries.** A review that fails retries after 30 seconds, 2
minutes, and 10 minutes. After four attempts the conversation goes to a
person with handoff reason `review_unavailable`, and the failure shows on
the delivery in the event log.

### Coalescing

All the mail on one thread inside a 60-second window shares a single
review turn. The first message starts the window; anything that arrives
on the same thread before it closes joins the same review. A customer who
sends three follow-ups in a minute gets one draft answering all of them,
and the mailbox spends one generation on it.

Each inbound message bumps the thread to a new review revision. A review
still running when a newer message arrives finishes as a superseded draft,
and the newer revision runs in its place.

### Automated mail

Mail sent by a machine never gets an agent reply. Radioso decides this from
headers alone, compared as protocol tokens — case-insensitive, parameters
ignored — and never from the subject or body. A message is held back from
the agent when any of these is true:

- `From` is one of the workspace's own mailboxes or relay addresses
  (disposition `self_sender`).
- It's a delivery status report (`multipart/report;
  report-type=delivery-status`). When it names a message Radioso sent, that
  send is marked `bounced` and its conversation gets a `delivery_failed`
  flag (disposition `bounce`); any other report is `automated_sender`.
- `Auto-Submitted` is present with any value other than `no`.
- `Precedence` is `bulk`, `list`, or `junk`.
- `X-Auto-Response-Suppress` is present.
- `List-Id` is present.

The last four are classified `automated_sender` and dropped. None of these runs a turn
or opens a conversation. Each appears in the mailbox's event log with its
disposition, and when it lands on a thread that already has a conversation,
it also shows there as a note in the conversation's activity, outside the
message history. The provider's SPF, DKIM, and DMARC results are recorded
on the event and never decide anything on their own, because forwarding
routinely breaks SPF.

A responder that sends none of these headers looks like a person, and the
budgets are what stop it: the thread send budget caps the automatic replies
it can draw, and the generation budget caps what a flood of them costs.
Agent-authored mail carries `Auto-Submitted: auto-generated`, so a
well-behaved responder on the other end leaves it alone.

### Policy at acceptance

Every accepted email records the mailbox's policy — mode, enabled, agent —
as it stood when the webhook accepted it. When the email's turn comes, it
runs under whichever of the accepted mode and the current mode gives the
agent less autonomy (`operator_only` is below `draft`, and `draft` is
below `auto`), and the mailbox
must have been enabled at acceptance and still be enabled. In practice:

- Switch a mailbox from `draft` to `operator_only`, and mail still waiting
  for review goes to a person with handoff reason `operator_only_mailbox`;
  pending drafts are superseded, and their conversations go to a person
  with the same reason.
- Switch it from `auto` to `draft`, and replies still queued to send come
  back to your team as drafts with hold reason `policy_changed`, beside the
  drafts already pending. Nothing goes out until a teammate releases one.
- Switch it from `operator_only` to `draft`, and only mail accepted after
  the change gets a review. Mail accepted before it stays with a person.
- A review already running when the policy changes can't hold a draft under
  the new policy: its draft is superseded the moment it's created, and the
  thread is reviewed again under the current one.

## The event log, retention, and raw access

Every accepted email is recorded as an event on the mailbox with its
disposition, sender, subject, and time, whether or not it becomes a
conversation. Automated-sender mail, a bounce, spam, a message from one of
your own mailboxes, an unresolved relay token, and a message to a disabled
mailbox never open a conversation, and neither does a reply whose sender
doesn't match the conversation's participant. When one of these lands on a
thread that already has a conversation, it shows there as a flagged note in
the conversation's activity; it never joins the message history. Nothing in
any of these runs a turn, and spam never opens a conversation. A failed event — one whose content fetch didn't succeed after
retrying — carries a retry action.

Settings shows each mailbox's own log. The workspace's log (`GET
/api/v1/workspaces/{workspaceId}/email-channel/events`) holds every delivery
attributed to the workspace, newest first: each mailbox's events, a removed
mailbox's retained events, and mail a verified receiving domain accepted for
an address no mailbox has, which carries `mailboxId: null` and the reason
`no_mailbox`. Pass `mailboxId` to narrow it to one mailbox, removed or not.

Events that never opened a conversation are purged after 30 days. The raw
MIME behind an event is capped at 2 MB and kept under the conversation's
own retention otherwise, with narrower
access: reading a raw message needs the takeover permission in addition to
settings read, and opening one is audited. The plain-text body is what's
shown by default; the sanitized HTML view strips scripts, forms, and remote
resources and renders inside a sandboxed frame. Attachments are recorded by
name, type, and size only — their content is never ingested or passed to the
agent, but a raw message can still be opened to see them.

## Queues

Inbound mail runs in two stages, both durable.

**Stage 1 — per provider event.** The webhook verifies the provider's
signature and persists the event in the same transaction that returns `200`.
Nothing else happens inline. A worker then fetches the message content with
retry, normalizes it, classifies it, and fans it out into one delivery per
mailbox it's addressed to (one message forwarded to two connected mailboxes
makes two deliveries, each its own conversation). Each delivery runs the
thread-resolution protocol and the engagement disposition, then is ingested.

**Stage 2 — per conversation.** A disposition that calls for a review turn
schedules one at the end of the [coalescing](#coalescing) window. When it's
due, the worker claims the thread under a lease, reserves a generation
against the mailbox's [budget](#budgets), runs the review, and holds the
result or, on an `auto` mailbox, queues it to send. An `operator_only`
mailbox never calls for a review turn, so stage 2 runs only for `draft` and
`auto` mailboxes.

**Scheduled drains.** Each stage pushes its own wakeup — right after the
webhook commits, at a review's due time, at a failed job's next retry time —
instead of waiting on a fixed interval. Locally, without a task dispatcher
configured, an interval loop polls for due work every few seconds.

**The five-minute sweep** (`email_channel_sweep`, `POST
/internal/tasks/email-channel/sweep`) is recovery, not the primary path: it
picks up work whose scheduled push was lost, reclaims leases that expired
without being renewed, refreshes domain readiness that's due, and purges
events past retention. On a deployment that doesn't run `auto`, it also
returns stale `queued_auto` replies to an operator (see
[Rollout and rollback](#rollout-and-rollback)). The bundled Terraform
creates the job once `email_channel_provider` is set.

**The backlog gauge.** `radioso_email_backlog` counts the work still waiting
past its deadline. The API reads it from the database when its metrics
endpoint is scraped, at most once every 30 seconds, so it needs
`METRICS_ENABLED` on the API service (see
[Monitoring And Alerts](monitoring-alerts.md)).

## Operations

**Deploying with the bundled Terraform.** Each environment root under
`infra/terraform/environments/` takes the channel's settings and passes them
to the shared module: `email_channel_provider`,
`email_channel_inbound_domain`, `email_channel_webhook_secret`,
`email_channel_webhook_secret_previous`, `resend_channel_api_key`,
`email_channel_workers_enabled`, the Cloud Tasks dispatch rates, and the
sweep's schedule and batch size. Supply the secrets as `TF_VAR_*` values
rather than in a committed `terraform.tfvars`. With `email_channel_provider`
unset the channel stays off, while the apply still provisions its
`radioso-<environment>-email-channel` queue so a rollout can set the rest
first.

**Deploying through the Terraform workflow.** `.github/workflows/terraform.yml`
reads the channel's inputs from the target GitHub environment and hands each
one to Terraform only when it's set, so an environment that sets none of them
keeps the channel off. Setting `EMAIL_CHANNEL_PROVIDER` without
`EMAIL_CHANNEL_INBOUND_DOMAIN` and `EMAIL_CHANNEL_WEBHOOK_SECRET` stops the
run before the plan, since the backend won't boot with that combination.

- Variables: `EMAIL_CHANNEL_PROVIDER`, `EMAIL_CHANNEL_INBOUND_DOMAIN`,
  `EMAIL_CHANNEL_WORKERS_ENABLED`,
  `EMAIL_CHANNEL_TASK_MAX_DISPATCHES_PER_SECOND`,
  `EMAIL_CHANNEL_TASK_MAX_CONCURRENT_DISPATCHES`,
  `EMAIL_CHANNEL_SWEEP_SCHEDULE`, `EMAIL_CHANNEL_SWEEP_MAX_JOBS`
- Secrets: `EMAIL_CHANNEL_WEBHOOK_SECRET`,
  `EMAIL_CHANNEL_WEBHOOK_SECRET_PREVIOUS`, `RESEND_CHANNEL_API_KEY`

**Provider outage.** Inbound fetches and sends both retry inside their own
jobs; nothing accepted is dropped, and the backlog just grows until the
provider recovers. After it does, check for sends stuck `uncertain` — they
need reconciliation or an operator decision, never a blind resend. See
[Human Takeover](human-takeover.md#delivery-failures) to mark one sent or
resend it.

**Webhook secret rotation.** Set the new value in
`EMAIL_CHANNEL_WEBHOOK_SECRET`, put the current value in
`EMAIL_CHANNEL_WEBHOOK_SECRET_PREVIOUS`, and leave both in place for 24
hours so in-flight retries from the provider still verify. Remove the
previous value once that window passes. On the Google Cloud Terraform
deployment the same two steps are two applies: set
`email_channel_webhook_secret` to the new value and
`email_channel_webhook_secret_previous` to the old one, then unset
`email_channel_webhook_secret_previous` a day later.

**Stuck event replay.** An event stuck past its processing deadline can be
retried directly from settings (`POST
/api/v1/workspaces/{workspaceId}/email-channel/events/{deliveryId}/retry`),
or left for the sweep's lease recovery to pick up. After more than about 12
hours of downtime, Resend's own retries give up; replay the event from the
provider's dashboard instead — the dedupe keys make a replay safe even if it
arrives twice.

**Bounce spike.** The `Bounce spike` alert or a run of `bounced` delivery
failures in the Inbox (see [Monitoring and alerts](monitoring-alerts.md)) is
the first sign. Check the sending domain's readiness and per-record status
first; a spike usually means a DNS record stopped resolving. Disable the
affected mailboxes while you sort out the domain, so nothing queues against
it in the meantime, then acknowledge the cleared failures once you've
confirmed the cause.

**Pre-creating the closing index before migration 213, on large tables.**
Migration 213 drops the original `conversation_activity` kind CHECK and then
adds `conversation_activity_workspace_closed_v2_idx`, a
`CREATE INDEX IF NOT EXISTS`, in one transaction guarded by a three-second
lock timeout. The exclusive lock the CHECK drop takes lasts until the
migration commits, so Inbox reads and activity writes wait for the whole
index build. On a `conversation_activity` table over 100k rows, build the
same index `CONCURRENTLY` under the same name and predicate before running
the migration, so the migration finds it already there and only drops the
CHECK. A concurrent build that fails leaves an invalid index of that name
behind — drop it before trying again or before deploying the migration.

## How this differs from the customer-email skill

The email channel is how a customer reaches an agent: mail forwarded to a
Radioso-operated relay, gated by an engagement mode, visible to operators as
conversations and events. [Customer email skills](customer-email-skills.md)
are the opposite direction — an agent skill that drafts or sends mail
*through a mailbox your workspace connected over OAuth* (Gmail or Microsoft
Graph), invoked as an action inside a routine. One is a channel customers
write to; the other is a tool an agent uses to write out.
