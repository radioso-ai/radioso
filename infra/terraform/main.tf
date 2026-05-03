locals {
  service_name                 = "radioso"
  resource_name_prefix         = "${local.service_name}-${var.environment}"
  document_storage_bucket_name = coalesce(var.document_storage_bucket_name, "${var.project_id}-${local.resource_name_prefix}-documents")
  observability_environment    = var.environment
  # Cloud Run does not expose a stable frontend URL Terraform can reuse here without
  # creating a backend<->frontend dependency cycle. Keep a valid placeholder until
  # the wrapper supplies the discovered frontend run.app URL on a later apply.
  app_base_url = coalesce(var.app_base_url_override, "https://example.invalid")
  # The worker service needs its own public URL for Cloud Tasks retry dispatch, but
  # Terraform cannot reference that URL from inside the worker resource itself.
  worker_tasks_service_url = coalesce(var.worker_tasks_service_url_override, "https://example.invalid")
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
}
