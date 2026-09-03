---
title: "Monitoring On Google Cloud"
description: "Terraform-managed Cloud Monitoring alerting for a Radioso deployment on Google Cloud: uptime check, alert policies, log-based error metric, and Cloud Run health probes."
last_updated: 2026-09-03
---

# Monitoring On Google Cloud

The Terraform under `infra/terraform/` deploys Radioso to Cloud Run with Cloud SQL, and it can build the alerting to go with it. This page is for that deployment. If you run Radioso anywhere else, [Monitoring And Alerts](monitoring-alerts.md) covers the portable path through Prometheus and the ops event feed.

What you get here that a metrics scrape can't give you: these signals come from Google Cloud rather than from Radioso, so they survive the process they watch. A backend that is hard down, a revision stuck in a crash loop, or a database that has stopped answering can't report on itself.

## Turn it on

Alerting is off until you set the flag and somewhere to send it:

```hcl
# infra/terraform/environments/live/terraform.tfvars
monitoring_enabled             = true
monitoring_notification_emails = ["ops@your-domain.example"]
```

Apply, and Terraform creates one email notification channel per address, an uptime check, a log-based metric, and the alert policies below. Every resource is named from the stack prefix (`radioso-live-…`), so two stacks sharing one project alert independently.

A `precondition` fails the plan if you enable alerting with no notification target, because alerting that applies cleanly and stays silent is worse than none.

### Sending alerts to Slack

Terraform creates email channels only. A Cloud Monitoring Slack channel stores an OAuth token that would end up in Terraform state, so create that one by hand and hand Terraform its ID:

1. In the Google Cloud console, go to **Monitoring → Alerting → Edit notification channels**.
2. Under **Slack**, click **Add new**, authorize the workspace, and pick the channel.
3. Copy the channel ID from **Manage notification channels**. It looks like `projects/radioso-494120/notificationChannels/1234567890123456789`.

```hcl
monitoring_extra_notification_channel_ids = [
  "projects/radioso-494120/notificationChannels/1234567890123456789",
]
```

Every policy delivers to the union of the email channels and this list.

## What each alert watches

**Backend unreachable.** An uptime check hits `/health` on this stack's Cloud Run backend every 60 seconds from several probe locations, and the alert fires when more than one location fails — a single flaky prober shouldn't wake you. It probes the per-region Cloud Run host rather than a shared public hostname, so when one region is sick the alert names it. Set `monitoring_uptime_host` to watch the public hostname instead.

**Cloud Run 5xx rate.** Fires when any service in the stack — backend, MCP, frontend, or either worker — sustains more than `monitoring_server_error_rate_threshold` server errors per second over five minutes. The default of `0.1` is six errors a minute: low enough to catch a broken deploy, high enough to sleep through one unlucky request.

**Backend p95 latency.** Fires when p95 request latency stays above `monitoring_backend_latency_p95_ms` (default 5000) for five minutes. Slow turns matter more than they look — a chat request that crawls hits its statement timeout and dies, and the customer sees a dead conversation rather than an error.

**Application error logs.** A log-based metric counts error-level lines per service, and the alert fires above `monitoring_error_log_threshold` (default 10) in five minutes. This is the broad net: it catches anything that throws, whether or not it became a 5xx.

**Cloud SQL saturation.** Three conditions on one policy — memory, CPU, and disk above 90%, 90%, and 85%. A starved database returns no errors; it answers slowly enough that turns time out, so the symptom arrives as "the agent stopped replying" with empty error logs. If this fires steadily rather than in spikes, raise `db_tier`.

**Task queue backlog.** Fires when a Cloud Tasks queue holds more than `monitoring_queue_depth_threshold` tasks (default 100) for fifteen minutes. While a queue is stuck, documents stop being indexed and conversation actions stop being delivered, and neither produces a user-visible error.

**Scheduler job failures.** Fires on any Cloud Scheduler attempt returning a non-success code. Those jobs are the recovery path for document processing, website crawls, and conversation-action delivery, so a quiet failure here surfaces later as a stalled queue.

## Health probes

Cloud Run's default startup probe opens a TCP connection to the container port, and a process that boots, binds, then fails to serve satisfies it and starts taking traffic. Set `container_health_probes_enabled = true` and the backend and MCP services probe their health routes (`/health` and `/healthz`) instead, so a revision that can't serve fails its rollout.

This is a separate flag from `monitoring_enabled` because it changes deployment behavior rather than only observing it. Turn it on when you can watch the rollout.

## Confirm it works

Check that error logs are classified correctly, since that is what the log-based metric counts:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND severity>=ERROR' \
  --project radioso-494120 --limit 5 --freshness 1h
```

Entries with real stack traces mean the metric is counting. Nothing returned while you know errors are happening means the running revision predates the logger's severity mapping — redeploy the backend.

To sanity-check a threshold, open **Monitoring → Metrics Explorer**, chart the metric named in the policy, and look at a week of history.

## Common failure modes

**Alerts create but never fire.** Cloud Monitoring accepts a filter matching no time series. Chart the policy's metric in Metrics Explorer; an empty chart means the filter is wrong, not that the system is healthy. Check the scheduler policy this way first — its `response_code` label vocabulary is what the filter keys on.

**Two of every alert.** Both regional stacks are running with the same notification emails, which is intended: each stack watches itself. The stack name is in every alert's display name.

**Uptime check fails while the service is fine.** The check probes the public Cloud Run URL, so it needs `backend_public_invocation_enabled = true`. With public invocation off, the probers get a 403 and the alert measures IAM rather than health.

**No notifications despite a firing policy.** An email channel is unverified until someone clicks the link Google sends when it is created. Check **Monitoring → Alerting → Notification channels** for its state.

## Read next

- [Monitoring And Alerts](monitoring-alerts.md) — the signals themselves, and alerting on them without Google Cloud
- [Ops Event Feed](ops-event-feed.md) — push signups, completed conversations, and errors to Slack or an automation tool
