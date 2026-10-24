---
title: "Monitoring And Alerts"
description: "Alert on a Radioso deployment: which signals exist, how to reach them through Prometheus metrics and the ops event feed, and example alert rules that work on any host."
last_updated: 2026-10-24
---

# Monitoring And Alerts

You want to hear that something broke from your own tooling, not from a customer. This page covers what a Radioso deployment exposes to alert on, and how to wire it up wherever you run.

Radioso emits signals through standard interfaces — a Prometheus-compatible metrics endpoint, OpenTelemetry traces and logs, structured JSON logs on stdout, and an HTTP feed of product and error events. Nothing here requires a particular cloud. If you run on Google Cloud, [Monitoring On Google Cloud](monitoring-google-cloud.md) covers the Terraform that turns these signals into alert policies for you.

## Which signal answers which question

| You want to know | Watch | Where it comes from |
|---|---|---|
| Is the API up | `/health` (backend), `/healthz` (MCP) | HTTP route, no auth |
| Is it returning errors | `radioso_http_requests_total{status_code=~"5.."}` | `/metrics` |
| Is it slow | `radioso_http_request_duration_ms` | `/metrics` |
| Is anything throwing | `radioso_errors_total`, or JSON logs at `severity>=ERROR` | `/metrics`, stdout |
| Are documents being indexed | `radioso_document_worker_queue_jobs` | `/metrics` |
| Are conversation actions being delivered | `radioso_action_dispatch_oldest_pending_age_ms` | `/metrics` |
| Is inbound email stuck past its processing deadline | `radioso_email_backlog{table="inbound_events",state="pending"}` | `/metrics` |
| Is the email webhook being forged or misconfigured | `radioso_email_webhook_requests_total{result=~"bad_signature\|stale_timestamp"}` | `/metrics` |
| Did an email sending domain stop verifying | `radioso_email_domain_readiness_transitions_total{capability="sending",to!="verified"}` | `/metrics` |
| Are voice turns hitting the turn limit | `radioso_voice_turn_limit_total` | `/metrics` |
| Is the voice runtime closing requests before the answer reaches it | `radioso_voice_turn_abandoned_total` | `/metrics` |
| Are email sends piling up with no resolved outcome | `radioso_email_send_intents_total{state="uncertain"}` | `/metrics` |
| Is the email bounce rate spiking | `radioso_email_send_intents_total{state="bounced"}` against `{state="accepted"}` | `/metrics` |
| Did someone sign up, did a conversation finish | `account.registered`, `chat.completed` | [ops event feed](ops-event-feed.md) |
| Is a caller being throttled | `security.rate_limit_enforced` | `audit_events` |
| Is Redis rate limiting falling back to Postgres | `radioso_abuse_control_store_fallback_total` | `/metrics` |
| What exactly broke, with a stack trace | error events | [ops event feed](ops-event-feed.md), `audit_events` |

The split matters: metrics tell you the platform is unwell, and the ops event feed tells you what happened to a customer. Both are useful, and neither substitutes for the other.

## Health routes

The backend serves `GET /health` and the standalone MCP server serves `GET /healthz`. Both return 200 with a small JSON body and need no authentication, so any orchestrator or uptime service can poll them. The backend body names the build it is running — `{"status":"ok","version":"1.4.0","commit":"5434e0e..."}` — which is what tells you whether an alert belongs to the release you just shipped. The same version reaches OpenTelemetry as `service.version`.

```yaml
# docker-compose.yml
healthcheck:
  test: ["CMD", "node", "-e", "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
  interval: 30s
  timeout: 5s
  retries: 3
```

Point a container liveness probe at the health route rather than the TCP port. A process that boots, binds, and then fails to serve satisfies a TCP check and starts taking traffic.

## Metrics

Metrics are off by default. Turn them on with a bearer token — the endpoint refuses callers that don't present it:

```bash
METRICS_ENABLED=true
METRICS_PATH=/metrics
METRICS_AUTH_TOKEN=replace-with-a-long-random-token
```

```yaml
# prometheus.yml
scrape_configs:
  - job_name: radioso-backend
    metrics_path: /metrics
    authorization:
      credentials: replace-with-a-long-random-token
    static_configs:
      - targets: ["radioso-backend:8080"]
```

The metric set is deliberately small and low-cardinality. [OSS And SaaS Observability](oss-saas-observability.md) lists all of it.

### Example alert rules

These mirror the alerts worth having on any deployment. Thresholds suit a small installation; chart a week of your own history before trusting them.

```yaml
# prometheus-rules.yml
groups:
  - name: radioso
    rules:
      - alert: RadiosoBackendDown
        expr: up{job="radioso-backend"} == 0
        for: 2m
        annotations:
          summary: "Backend is not being scraped"

      - alert: RadiosoServerErrors
        expr: sum(rate(radioso_http_requests_total{status_code=~"5.."}[5m])) > 0.1
        for: 5m
        annotations:
          summary: "Sustained 5xx responses"

      - alert: RadiosoSlowRequests
        expr: histogram_quantile(0.95, sum(rate(radioso_http_request_duration_ms_bucket[5m])) by (le)) > 5000
        for: 5m
        annotations:
          summary: "p95 request latency above 5s"

      - alert: RadiosoErrorsRising
        expr: sum(rate(radioso_errors_total[5m])) by (error_type) > 0.03
        for: 5m
        annotations:
          summary: "Recorded errors rising for {{ $labels.error_type }}"

      - alert: RadiosoDocumentBacklog
        expr: max(radioso_document_worker_queue_jobs) > 100
        for: 15m
        annotations:
          summary: "Document processing queue is not draining"

      - alert: RadiosoActionOutboxStalled
        expr: max(radioso_action_dispatch_oldest_pending_age_ms) > 900000
        for: 5m
        annotations:
          summary: "Conversation actions have been undelivered for 15 minutes"

      - alert: RadiosoEmailInboundBacklog
        expr: max(radioso_email_backlog{table="inbound_events",state="pending"}) > 0
        for: 10m
        annotations:
          summary: "Inbound email events have been stuck past the processing deadline"

      - alert: RadiosoEmailWebhookAuthFailing
        expr: sum(rate(radioso_email_webhook_requests_total{result=~"bad_signature|stale_timestamp"}[5m])) > 0
        for: 5m
        annotations:
          summary: "Email webhook requests are failing signature verification"

      - alert: RadiosoEmailDomainReadinessLost
        expr: increase(radioso_email_domain_readiness_transitions_total{capability="sending",to!="verified"}[15m]) > 0
        annotations:
          summary: "An email sending domain lost its verified status"

      - alert: RadiosoVoiceTurnLimitReached
        expr: sum(increase(radioso_voice_turn_limit_total[15m])) > 5
        annotations:
          summary: "Voice turns are hitting the turn limit: callers wait too long for answers"

      - alert: RadiosoVoiceTurnAbandoned
        expr: sum(increase(radioso_voice_turn_abandoned_total[15m])) > 5
        annotations:
          summary: "The voice runtime is closing requests before the answer reaches it: likely timing out on slow answers"

      - alert: RadiosoEmailSendUncertain
        expr: increase(radioso_email_send_intents_total{state="uncertain"}[1h]) > 0
        annotations:
          summary: "An email send's outcome never resolved and needs an operator decision"

      - alert: RadiosoEmailBounceSpike
        expr: >
          sum(increase(radioso_email_send_intents_total{state="accepted"}[1h])) >= 20
          and
          (sum(increase(radioso_email_send_intents_total{state="bounced"}[1h]))
            / sum(increase(radioso_email_send_intents_total{state="accepted"}[1h]))) > 0.2
        annotations:
          summary: "More than 20% of accepted email sends bounced in the last hour"
```

The outbox and email-backlog alerts earn their place the same way. While the action outbox is stalled, customer-facing work — a contact request, a notification — sits undelivered and nothing else reports it. There is no error and no failed request; the queue just stops.

`radioso_email_backlog` counts only work that has waited past its deadline, so a busy queue that keeps draining reads zero. The API samples it from the database when its metrics endpoint is scraped, at most once every 30 seconds per instance; scrapes in between report the last sample. The counts cover every workspace, so each API instance reports the same value, which is why the alert takes the `max`. It carries one series per stage:

| `table` | `state` | Counts |
|---|---|---|
| `inbound_events` | `pending`, `processing` | Inbound events received more than 10 minutes ago and not yet processed |
| `reviews_due` | `due` | Threads whose review fell due more than 5 minutes ago and has not run |
| `send_intents` | `queued` | Sends created more than 10 minutes ago that the provider has not accepted |

The gauge exists only on an API with metrics enabled and the email channel configured. A deployment with the channel turned off never samples it, so the series is absent and the alert stays quiet. When a sample fails, the gauge keeps its previous values and the API logs `email_backlog_sample_failed`.

The two voice rules watch whether calls get their answers in time. `radioso_voice_turn_limit_total` counts every turn that reached the voice turn limit before it spoke, whatever became of it. `radioso_voice_turn_abandoned_total` counts turns whose request the voice runtime closed before the answer reached it, however the turn itself ended, so a runtime that stops waiting at 20 seconds while the answer lands at 30 is counted. A caller who hangs up while the agent is thinking or speaking is counted too, so a few are normal; the threshold is for a burst, and a runtime timing out on slow answers shows as one.

## Rate limits

Every throttled surface — sign-in, public chat, the agent channels, MCP, the copilot — shares one counter keyed by a scope and a subject such as an email, a session, or a workspace. A scope carries a limit, a window, and a block period: crossing the limit within the window blocks that subject for the block period and writes a `security.rate_limit_enforced` audit event, which is the signal to alert on if you care about who is being turned away.

Postgres stores the counter by default. Set `ABUSE_CONTROL_REDIS_URL` to a standalone `redis://` or `rediss://` endpoint to move checks to Redis; `ABUSE_CONTROL_REDIS_COMMAND_TIMEOUT_MS` gives each Redis command 1,000 ms by default. The Redis store keeps subjects out of key names by hashing the scope and subject together, and an atomic Lua script applies the same sliding window and block period across API replicas. `rediss://` uses the operating system trust store. A private CA, including a managed Redis in-transit-encryption endpoint that requires one, is not supported yet. Redis Cluster is also unsupported because one atomic multi-key check cannot safely span cluster hash slots.

If a Redis check errors or reaches its command deadline, that check runs against Postgres. The backend tears down the timed-out Redis connection, then a small circuit breaker sends later checks directly to Postgres until one probe can test Redis again. Expired Postgres fallback rows sweep after a fallback write and at most once every five minutes per API process; Redis entries expire through their key TTL. The fallback warning `abuse_control_store_fallback` is rate-limited; `radioso_abuse_control_store_fallback_total{operation="consume"}` or `{operation="consume_batch"}` still increments for every fallback. Alert on any sustained increase; a brief isolated fallback is safe, while a rising counter means Redis is no longer relieving Postgres.

Fallback keeps the limiter available; it does not make Redis and Postgres one authoritative budget. During a rolling cutover or Redis outage, a subject can spend each store's independent counter and be admitted up to roughly twice the limit for one window. A block recorded in one store is not visible in the other. Restore Redis promptly and treat the fallback metric as an operational alert, not as proof of exact cross-store enforcement.

Admission weighs two windows. The window that just expired still counts, in proportion to how much of it the running window overlaps: `previous × overlap + current`, where `overlap` falls from 1 to 0 as the running window advances. A caller that spends a whole budget in the last second of one window is therefore still over the limit in the first second of the next, which a plain per-window counter would wave through at twice the intended rate.

Responses carry the budget as headers, so a client can pace itself instead of discovering the limit by being refused:

| Header | On | Meaning |
|---|---|---|
| `RateLimit-Limit` | every rate-limited response | attempts the scope allows per window |
| `RateLimit-Remaining` | every rate-limited response | attempts left before the next one is refused |
| `RateLimit-Reset` | every rate-limited response | seconds until the window rolls |
| `Retry-After` | `429` only | seconds to wait before retrying |

A client should honour `Retry-After` on a `429` and back off before `RateLimit-Remaining` reaches zero. The same wait is in the body as `error.details.retryAfterSeconds`, alongside the limit, what remains, and the reset instant, so a client that reads the JSON needs nothing else.

## Logs

The backend writes one JSON object per line to stdout, with both a numeric Pino `level` and the `severity` string most log platforms classify on. Filtering for `severity>=ERROR` (or `level>=50`) gives you every stack trace, whichever collector you run — Loki, Elasticsearch, a cloud log service, or `docker logs`.

To ship logs and traces through OpenTelemetry instead, see the OTel flags in [OSS And SaaS Observability](oss-saas-observability.md).

## Your database and host

Radioso reports on itself, not on the machine underneath it. Postgres saturation is the failure that hides best: a starved instance returns no errors, it just answers slowly enough that chat turns hit their statement timeout and die. The customer sees an agent that stopped replying, and the error logs are empty.

Whatever you use for host monitoring, alert on Postgres memory, CPU, disk, and connection count. If those sit near their limit, that is your answer before you go looking in the application.

## Common failure modes

**Metrics endpoint returns 401.** The scrape is missing the bearer token, or `METRICS_AUTH_TOKEN` differs between the app and the scrape config. The endpoint has no anonymous mode.

**Alert rules that never fire.** A Prometheus expression matching no series looks exactly like health. Run each `expr` in the Prometheus console once and confirm it returns data before you rely on it.

**No error logs despite errors happening.** Check the running image writes `severity`; if you filter on `severity>=ERROR` against an older revision, use `level>=50` instead.

**Product events missing from the feed.** Several names in the event taxonomy are emitted by the browser rather than the backend, and a few are declared but not yet emitted anywhere. [Ops Event Feed](ops-event-feed.md) lists what actually arrives.

## Read next

- [Ops Event Feed](ops-event-feed.md) — push signups, completed conversations, and errors to Slack or an automation tool
- [Monitoring On Google Cloud](monitoring-google-cloud.md) — Terraform alert policies, uptime check, and log-based metric for a Google Cloud deployment
- [OSS And SaaS Observability](oss-saas-observability.md) — the full metric list, OTel flags, and the sink contracts underneath all of this
