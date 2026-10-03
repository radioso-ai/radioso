---
title: "Email Channel"
description: "Connect a support mailbox to a Radioso agent by forwarding, verify sending on your own domain, and work the mailbox event log and raw mail from operator settings."
last_updated: 2026-10-03
---

# Email Channel

The email channel lets a customer reach a Radioso agent at an address they
already know, such as `support@customer.com`, without Radioso taking over
that mailbox. The customer's mail service forwards to a relay address
Radioso gives you; replies go out as the real address once you've added a
couple of DNS records. Every email the channel accepts is visible to an
operator somewhere — as a conversation in the Inbox, or as an event in the
mailbox's event log when it never becomes one.

This release ships one engagement mode, `operator_only`: every accepted
email opens or continues a human-owned conversation, and the agent never
runs a turn on it. The API's `engagementMode` field also accepts `draft` and
`auto`; setting either on a mailbox is refused with `engagement_mode_unavailable`,
because only `operator_only` is in the deployment's `supportedModes` right
now.

Email conversations never auto-close. Like any other channel, what decides
whether a conversation needs attention is whether a person must act on it —
not how long it's been quiet.

## Topology

Radioso does not take over a customer's domain to receive their mail. Each
connected mailbox gets an opaque relay address on an inbound domain Radioso
operates — `EMAIL_CHANNEL_INBOUND_DOMAIN`, for example `in.eu.radioso.ai` on
Radioso Cloud's EU stack. You forward your existing address to that relay
address from whatever mail service you already use, and your mailbox never
moves. Receiving needs no DNS at all: a mailbox can be live the moment
forwarding is set up.

Sending is separate from receiving. Once you've added the DKIM and SPF
records Radioso shows for your domain, replies go out `From` your real
address, not the relay. Those records are additive — they don't touch
anything else on your domain.

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
and keeps every conversation and its history intact.

## The event log, retention, and raw access

Every accepted email is recorded as an event on the mailbox with its
disposition, sender, subject, and time, whether or not it becomes a
conversation. Automated-sender mail, a bounce, spam, a message from one of
your own mailboxes, an unresolved relay token, and a message to a disabled
mailbox never open or continue a conversation at all — the event is all
there is. A reply whose sender doesn't match the conversation's participant
*is* attached to that conversation, but only as a flagged exception: no
turn runs and the message doesn't join the conversation's history. Nothing
in any of these runs a turn. A failed event — one whose content fetch
didn't succeed after retrying — carries a retry action.

Events that never opened a conversation are purged after
`EMAIL_CHANNEL_EVENT_RETENTION_DAYS` (30 days by default). The raw MIME
behind an event is capped at `EMAIL_CHANNEL_RAW_MAX_BYTES` (2 MB by default)
and kept under the conversation's own retention otherwise, with narrower
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
schedules one after a short coalescing window, so a burst of messages on one
thread gets a single turn instead of one per message. `operator_only`'s
disposition never calls for a review turn, so this stage is dormant for
every mailbox running in it today.

**Scheduled drains.** Each stage pushes its own wakeup — right after the
webhook commits, at a review's due time, at a failed job's next retry time —
instead of waiting on a fixed interval. Locally, without a task dispatcher
configured, an interval loop polls for due work every few seconds.

**The five-minute sweep** (`email_channel_sweep`, `POST
/internal/tasks/email-channel/sweep`) is recovery, not the primary path: it
picks up work whose scheduled push was lost, reclaims leases that expired
without being renewed, refreshes domain readiness that's due, and purges
events past retention.

## Operations

**Provider outage.** Inbound fetches and sends both retry inside their own
jobs; nothing accepted is dropped, and the backlog just grows until the
provider recovers. After it does, check for sends stuck `uncertain` — they
need reconciliation or an operator decision, never a blind resend.

**Webhook secret rotation.** Set the new value in
`EMAIL_CHANNEL_WEBHOOK_SECRET`, put the current value in
`EMAIL_CHANNEL_WEBHOOK_SECRET_PREVIOUS`, and leave both in place for 24
hours so in-flight retries from the provider still verify. Remove the
previous value once that window passes.

**Stuck event replay.** An event stuck past its processing deadline can be
retried directly from settings (`POST
/api/v1/workspaces/{workspaceId}/email-channel/events/{deliveryId}/retry`),
or left for the sweep's lease recovery to pick up. After more than about 12
hours of downtime, Resend's own retries give up; replay the event from the
provider's dashboard instead — the dedupe keys make a replay safe even if it
arrives twice.

**Bounce spike.** Check the sending domain's readiness and per-record
status first; a spike usually means a DNS record stopped resolving. Disable
the affected mailboxes while you sort out the domain, so nothing queues
against it in the meantime.

**Pre-creating the closing index before migration 214, on large tables.**
Migration 214 adds `conversation_activity_workspace_closed_v2_idx`, a
`CREATE INDEX IF NOT EXISTS` guarded by a three-second lock timeout. On a
`conversation_activity` table over 100k rows, that's cutting it close:
build the same index `CONCURRENTLY` under the same name and predicate before
running the migration, so the migration finds it already there and does
nothing. A concurrent build that fails leaves an invalid index of that name
behind — drop it before trying again or before deploying the migration.

## How this differs from the customer-email skill

The email channel is how a customer reaches an agent: mail forwarded to a
Radioso-operated relay, gated by an engagement mode, visible to operators as
conversations and events. [Customer email skills](customer-email-skills.md)
are the opposite direction — an agent skill that drafts or sends mail
*through a mailbox your workspace connected over OAuth* (Gmail or Microsoft
Graph), invoked as an action inside a routine. One is a channel customers
write to; the other is a tool an agent uses to write out. They share no
code: the email channel never reuses `backend/src/modules/customerEmail/`.
