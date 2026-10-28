locals {
  service_name                 = "radioso"
  resource_name_prefix         = "${local.service_name}-${var.environment}"
  document_storage_bucket_name = coalesce(var.document_storage_bucket_name, "${var.project_id}-${local.resource_name_prefix}-documents")
  observability_environment    = var.environment
  # Cloud Run does not expose a stable frontend URL Terraform can reuse here without
  # creating a backend<->frontend dependency cycle. Keep a valid placeholder until
  # the wrapper supplies the public app URL or discovered frontend run.app URL.
  app_base_url            = coalesce(var.app_base_url_override, "https://example.invalid")
  operator_mcp_configured = var.radioso_mcp_enabled && var.mcp_public_origin != null
  # The region the email channel's Resend sending domain is created in follows the stack's.
  # That only places the sending and receiving infrastructure: Resend stores account data,
  # email metadata, logs and received message content in the United States regardless of region.
  resend_channel_region = startswith(var.region, "europe-") ? "eu-west-1" : "us-east-1"
  # The document worker self-references its own public URL for Cloud Tasks
  # retry dispatch, so Terraform cannot use a direct reference and we keep the
  # placeholder + override pattern. The backend and document worker reference
  # google_cloud_run_v2_service.crawler_worker directly.
  worker_tasks_service_url = coalesce(var.worker_tasks_service_url_override, "https://example.invalid")
  # The crawler worker enqueues its own crawl slice continuations, so it needs its
  # URL as well. Reading the resource's uri there would be a self-reference cycle,
  # so it gets Cloud Run's deterministic URL, built from name, project number and region.
  crawler_worker_name = "${local.resource_name_prefix}-crawler-worker"
  crawler_worker_url  = "https://${local.crawler_worker_name}-${data.google_project.current.number}.${var.region}.run.app"
  document_worker_recovery_schedule = coalesce(
    var.document_worker_recovery_schedule,
    var.worker_recovery_schedule,
    "0 * * * *",
  )
  crawler_worker_recovery_schedule = coalesce(
    var.crawler_worker_recovery_schedule,
    var.worker_recovery_schedule,
    "0 3 * * *",
  )
  # Every 5 minutes by default: tighter than document recovery (hourly) because a
  # missed/lost push here means a customer-facing lead (e.g. a contact request) sits
  # undelivered, not just a document reindex running late.
  action_dispatch_recovery_schedule = coalesce(
    var.action_dispatch_recovery_schedule,
    "*/5 * * * *",
  )
  # Every 5 minutes by default: the push path wakes the worker for normal work, so this only
  # catches lost wakes and expired leases; a summary refresh a few minutes late is harmless.
  background_job_recovery_schedule = coalesce(
    var.background_job_recovery_schedule,
    "*/5 * * * *",
  )
  # Daily: dead-lettered jobs are kept 14 days for inspection, so a day of lateness is immaterial.
  background_job_retention_schedule = coalesce(
    var.background_job_retention_schedule,
    "15 5 * * *",
  )
  # Daily is the right cadence for a retention window measured in months: the sweep is the only
  # trigger retention has under the task runtime, and a day of lateness on a 90-day window is
  # immaterial next to the cost of scanning for expired rows every few minutes.
  copilot_retention_schedule = coalesce(
    var.copilot_retention_schedule,
    "30 4 * * *",
  )
  # Every 15 minutes, matching CONVERSATION_RETENTION_INTERVAL_MS in conversationRetention.ts: each
  # run erases a bounded batch, so a workspace that just set a window drains its backlog over a few
  # runs rather than in one long one.
  conversation_retention_schedule = coalesce(
    var.conversation_retention_schedule,
    "*/15 * * * *",
  )
  # Every 15 minutes, matching VOICE_RECORDING_ERASURE_RECOVERY_INTERVAL_MS in voiceChannel.ts: it only
  # re-queues erasures nothing is working on, so its cadence bounds how late a stranded one restarts.
  voice_recording_erasure_recovery_schedule = coalesce(
    var.voice_recording_erasure_recovery_schedule,
    "*/15 * * * *",
  )
  agent_bundle_import_cleanup_schedule = coalesce(
    var.agent_bundle_import_cleanup_schedule,
    "*/5 * * * *",
  )
  # The Slack inbound-event ledger only dedups webhook retries, which Slack stops within the hour;
  # a daily sweep of the 7-day window is plenty.
  slack_inbound_event_retention_schedule = coalesce(
    var.slack_inbound_event_retention_schedule,
    "45 4 * * *",
  )
  # Matches the document worker's own daily interval (DAILY_SCAN_INTERVAL_MS in
  # credentialExpiryWarningService.ts).
  credential_expiry_warning_schedule = coalesce(
    var.credential_expiry_warning_schedule,
    "15 4 * * *",
  )
  # Every minute: Cloud Scheduler's own minimum granularity, matching the dispatcher's
  # ALERT_SWEEP_INTERVAL_MS (60s) poll-loop cadence.
  usage_limit_alert_sweep_schedule = coalesce(
    var.usage_limit_alert_sweep_schedule,
    "* * * * *",
  )
  # Every minute: Cloud Scheduler's own minimum granularity, matching AUTO_TOP_UP_SWEEP_INTERVAL_MS
  # (60s) in applicationModule.ts.
  billing_auto_top_up_sweep_schedule = coalesce(
    var.billing_auto_top_up_sweep_schedule,
    "* * * * *",
  )
  # Recovery only (lease recovery, domain refresh, send reconciliation claims, event-log
  # retention) — scheduled drains carry the normal-path work (research B7, B12).
  email_channel_sweep_schedule = coalesce(
    var.email_channel_sweep_schedule,
    "*/5 * * * *",
  )
  public_chat_base_url = (
    var.public_chat_base_url_override != null
    ? var.public_chat_base_url_override
    : (
      var.app_base_url_override != null
      ? "${trimsuffix(var.app_base_url_override, "/")}/chat"
      : null
    )
  )
  enterprise_application_modules = var.radioso_edition == "enterprise" ? "@radioso/enterprise-backend-module" : null
  otel_logs_endpoint = (
    var.otel_logs_endpoint != null
    ? var.otel_logs_endpoint
    : (
      var.posthog_host != null
      ? "${trimsuffix(var.posthog_host, "/")}/i/v1/logs"
      : null
    )
  )
}
