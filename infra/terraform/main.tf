locals {
  service_name                 = "radioso"
  resource_name_prefix         = "${local.service_name}-${var.environment}"
  document_storage_bucket_name = coalesce(var.document_storage_bucket_name, "${var.project_id}-${local.resource_name_prefix}-documents")
  observability_environment    = var.environment
  # Cloud Run does not expose a stable frontend URL Terraform can reuse here without
  # creating a backend<->frontend dependency cycle. Keep a valid placeholder until
  # the wrapper supplies the public app URL or discovered frontend run.app URL.
  app_base_url = coalesce(var.app_base_url_override, "https://example.invalid")
  # The document worker self-references its own public URL for Cloud Tasks
  # retry dispatch, so Terraform cannot use a direct reference and we keep the
  # placeholder + override pattern. The crawler worker URL has no such cycle:
  # the backend and document worker reference google_cloud_run_v2_service.crawler_worker
  # directly, and the crawler worker itself does not enqueue crawl tasks.
  worker_tasks_service_url = coalesce(var.worker_tasks_service_url_override, "https://example.invalid")
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
  public_chat_base_url = (
    var.public_chat_base_url_override != null
    ? var.public_chat_base_url_override
    : (
      var.app_base_url_override != null
      ? "${trimsuffix(var.app_base_url_override, "/")}/chat"
      : null
    )
  )
  radioso_mcp_base_url = (
    var.radioso_mcp_base_url_override != null
    ? var.radioso_mcp_base_url_override
    : (
      var.connector_public_base_url != null
      ? var.connector_public_base_url
      : (
        var.app_base_url_override != null
        ? "${trimsuffix(var.app_base_url_override, "/")}/backend"
        : null
      )
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
