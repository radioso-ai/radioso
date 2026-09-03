---
title: "Monitoring And Alerts"
description: "Alert on a Radioso deployment: which signals exist, how to reach them through Prometheus metrics and the ops event feed, and example alert rules that work on any host."
last_updated: 2026-09-03
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
| Did someone sign up, did a conversation finish | `account.registered`, `chat.completed` | [ops event feed](ops-event-feed.md) |
| What exactly broke, with a stack trace | error events | [ops event feed](ops-event-feed.md), `audit_events` |

The split matters: metrics tell you the platform is unwell, and the ops event feed tells you what happened to a customer. Both are useful, and neither substitutes for the other.

## Health routes

The backend serves `GET /health` and the standalone MCP server serves `GET /healthz`. Both return 200 with a small JSON body and need no authentication, so any orchestrator or uptime service can poll them.

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
```

That last one earns its place. While the action outbox is stalled, customer-facing work — a contact request, a notification — sits undelivered and nothing else reports it. There is no error and no failed request; the queue just stops.

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
