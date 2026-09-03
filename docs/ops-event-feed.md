---
title: "Ops Event Feed"
description: "Push Radioso product events and errors to an HTTP endpoint as signed JSON: configuration, the envelope shape, signature verification, and what arrives."
last_updated: 2026-09-03
---

# Ops Event Feed

Radioso records every signup, chat turn, and error as a structured event. By default those land in the `audit_events` table and stay there, which means finding out that someone signed up involves querying your database. The ops event feed pushes them instead: each event becomes a signed JSON POST to a URL you choose.

Point it at a Slack workflow to get a message per signup. Point it at n8n, Make, or your own handler to trigger something. One endpoint, so adding a second destination is a change in your automation tool rather than in Radioso.

## Configure it

Two environment variables and one sink name:

```bash
PRODUCT_ANALYTICS_SINKS=audit,ops_webhook
ERROR_SINKS=audit,ops_webhook
OPS_EVENT_WEBHOOK_URL=https://hooks.example.com/radioso
OPS_EVENT_WEBHOOK_SECRET=a-long-random-shared-secret
```

The backend refuses to start if a sink list names `ops_webhook` without both a URL and a secret, so a half-finished configuration fails at boot rather than going quietly nowhere.

`audit` stays in the list because it is the durable record. The feed is deliberately lossy — see [Delivery](#delivery) — and `audit_events` is what you go back to when you need the history.

### Narrowing what you receive

Every product event is forwarded unless you name the ones you want:

```bash
OPS_EVENT_WEBHOOK_EVENTS=account.registered,chat.failed,document.ingest_failed
```

Names are validated at startup against the event taxonomy, so a typo is a boot error rather than an event that silently never arrives.

Think about volume before you leave this unset. `chat.started` and `chat.completed` fire on every conversation; on a busy workspace that is a firehose, and a channel you mute is worse than no channel. A common split is per-event delivery for signups and failures, and a scheduled digest for the rest built from `audit_events`.

Errors are filtered by severity rather than by name:

```bash
OPS_EVENT_WEBHOOK_MIN_ERROR_SEVERITY=error   # info | warn | error
```

## What arrives

Both streams share one envelope, so a receiver parses a single shape and routes on `kind` and `name`:

```json
{
  "id": "e1c9f0a2-5b6d-4c31-9f77-2b0d8a4c1e55",
  "kind": "product_analytics",
  "name": "account.registered",
  "timestamp": "2026-09-03T10:14:22.481Z",
  "severity": "info",
  "workspaceId": "7f2c...",
  "accountId": "9a41...",
  "payload": {
    "actorType": "authenticated_user",
    "subjectType": "workspace",
    "subjectId": "7f2c...",
    "source": "backend",
    "properties": { "requiresEmailVerification": true }
  }
}
```

An error event uses `"kind": "error"`, carries the error's own severity, and puts the message, class, stack, and request context in `payload`.

Product events always arrive at `severity: "info"`. Whether `chat.failed` deserves a page is your policy, not Radioso's, so route on the typed `name`.

### Events the backend sends

| Name | When |
|---|---|
| `account.registered` | someone completes registration |
| `chat.started` | a conversation begins |
| `chat.completed` | a turn answers successfully |
| `chat.failed` | a turn fails |
| `document.ingest_queued` | an upload is accepted for processing |
| `document.ingest_failed` | an upload is rejected |

`chat.citation_clicked`, `chat.link_clicked`, and `frontend.page_view` come from the browser and reach the feed through the observability API. The taxonomy also declares `workspace.created`, `document.processing_completed`, `document.processing_failed`, `retrieval_settings.updated`, and `website_embed.loaded`, which no code emits — configuring them in `OPS_EVENT_WEBHOOK_EVENTS` is accepted and delivers nothing.

## Verify the signature

Each request carries the envelope id as its idempotency key plus an HMAC-SHA256 signature over `{timestamp}.{body}`, using the same recipe as workspace webhook skills:

```
Idempotency-Key: e1c9f0a2-5b6d-4c31-9f77-2b0d8a4c1e55
X-Radioso-Timestamp: 1788440310
X-Radioso-Signature: sha256=4f0b...
Content-Type: application/json
```

```js
import { createHmac, timingSafeEqual } from "node:crypto";

const expected = createHmac("sha256", process.env.OPS_EVENT_WEBHOOK_SECRET)
  .update(`${headers["x-radioso-timestamp"]}.${rawBody}`)
  .digest("hex");

const signature = headers["x-radioso-signature"].slice("sha256=".length);
const ok = timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
```

Verify against the raw body, before any JSON parsing. Reject timestamps far from your own clock to limit replay.

## Delivery

Delivery never blocks a request. Events go onto an in-memory queue and a detached loop drains it, retrying a failed POST three times with backoff. Your webhook being slow or down cannot add latency to a chat turn.

The tradeoffs that buys:

- The queue is bounded (`OPS_EVENT_WEBHOOK_QUEUE_LIMIT`, default 500). A burst past the limit drops the oldest events and logs each drop.
- A process restart drops whatever is still queued.
- After three failed attempts an event is logged and abandoned.

So treat the feed as a notification channel, not a ledger. Every event it carries is also in `audit_events`, which is where to look when you need a complete history.

Retries repeat the same `Idempotency-Key`, so a receiver that acts on events — creating a ticket, sending a message — should key on it.

## Common failure modes

**Backend won't start after enabling the sink.** The URL or secret is missing, or `OPS_EVENT_WEBHOOK_EVENTS` names an event the taxonomy doesn't define. The startup error names the variable.

**Nothing arrives and no errors appear.** Check `ops_webhook` is in the sink list and not only in the URL variable — setting the URL alone configures a destination nothing routes to.

**Some events arrive, others never do.** An `OPS_EVENT_WEBHOOK_EVENTS` allowlist is in effect, or the events you're waiting for are among the declared-but-unemitted names above.

**Signature checks fail.** The signature covers `{timestamp}.{rawBody}`, not the body alone, and it is computed over the exact bytes sent — re-serializing parsed JSON produces a different digest.

**Bursts go missing under load.** Deliveries are being dropped at the queue limit. The drop is logged with the event name; raise `OPS_EVENT_WEBHOOK_QUEUE_LIMIT` or narrow the allowlist.

## Read next

- [Monitoring And Alerts](monitoring-alerts.md) — metrics and alert rules for platform health, which the feed does not replace
- [OSS And SaaS Observability](oss-saas-observability.md) — the sink contracts underneath this, and the optional PostHog and Sentry adapters
