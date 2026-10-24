terraform {
  required_version = ">= 1.7"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }
  }

  backend "gcs" {
    # Configure via:
    # terraform init -backend-config=backend.hcl
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

# The identity plane (CI and runtime service accounts, the GitHub workload identity pool, and
# their IAM) has its own root in ../../foundation/environments/live-eu, applied by a person rather
# than this workflow's identity (#1596).

module "radioso" {
  source = "../.."

  project_id              = var.project_id
  environment             = var.environment
  region                  = var.region
  deploy_services         = var.deploy_services
  manage_project_services = false

  backend_image   = var.backend_image
  frontend_image  = var.frontend_image
  radioso_edition = var.radioso_edition

  backend_min_instances  = 0
  backend_max_instances  = var.backend_max_instances
  frontend_min_instances = 0
  frontend_max_instances = var.frontend_max_instances
  worker_min_instances   = 0
  worker_max_instances   = var.worker_max_instances

  db_tier                           = var.db_tier
  db_deletion_protection            = true
  db_point_in_time_recovery_enabled = var.db_point_in_time_recovery_enabled

  secret_replication_locations = [var.region]

  worker_task_queue_name                    = "radioso-${var.environment}-document-processing"
  worker_crawl_task_queue_name              = "radioso-${var.environment}-website-crawls"
  worker_task_max_dispatches_per_second     = var.worker_task_max_dispatches_per_second
  worker_task_max_concurrent_dispatches     = var.worker_task_max_concurrent_dispatches
  document_processing_job_lease_ms          = var.document_processing_job_lease_ms
  website_crawl_job_lease_ms                = var.website_crawl_job_lease_ms
  document_worker_recovery_schedule         = var.document_worker_recovery_schedule
  crawler_worker_recovery_schedule          = var.crawler_worker_recovery_schedule
  copilot_probe_budget_per_turn             = var.copilot_probe_budget_per_turn
  copilot_conversation_retention_days       = var.copilot_conversation_retention_days
  copilot_retention_schedule                = var.copilot_retention_schedule
  agent_bundle_import_orphan_age_ms         = var.agent_bundle_import_orphan_age_ms
  agent_bundle_import_cleanup_schedule      = var.agent_bundle_import_cleanup_schedule
  document_storage_bucket_name              = var.document_storage_bucket_name
  document_upload_max_bytes                 = var.document_upload_max_bytes
  openai_api_key                            = var.openai_api_key
  session_cookie_secret                     = var.session_cookie_secret
  workspace_token_secret                    = var.workspace_token_secret
  public_chat_session_secret                = var.public_chat_session_secret
  connector_encryption_key                  = var.connector_encryption_key
  ee_usage_admin_token                      = var.ee_usage_admin_token
  slack_oauth_client_id                     = var.slack_oauth_client_id
  slack_oauth_client_secret                 = var.slack_oauth_client_secret
  slack_signing_secret                      = var.slack_signing_secret
  resend_mail_api_key                       = var.resend_mail_api_key
  mail_from_email                           = var.mail_from_email
  mail_from_name                            = var.mail_from_name
  metrics_auth_token                        = var.metrics_auth_token
  product_analytics_sinks                   = var.product_analytics_sinks
  error_sinks                               = var.error_sinks
  posthog_api_key                           = var.posthog_api_key
  posthog_host                              = var.posthog_host
  otel_logs_enabled                         = var.otel_logs_enabled
  otel_logs_min_level                       = var.otel_logs_min_level
  openai_chat_model                         = var.openai_chat_model
  openai_rerank_model                       = var.openai_rerank_model
  openai_vector_model                       = var.openai_vector_model
  openai_data_residency                     = var.openai_data_residency
  azure_openai_endpoint                     = var.azure_openai_endpoint
  session_ttl_hours                         = var.session_ttl_hours
  metrics_enabled                           = var.metrics_enabled
  connector_public_base_url                 = var.connector_public_base_url
  radioso_mcp_enabled                       = var.radioso_mcp_enabled
  mcp_public_origin                         = var.mcp_public_origin
  operator_mcp_credential_epoch             = var.operator_mcp_credential_epoch
  app_base_url_override                     = var.app_base_url_override
  google_login_client_id                    = var.google_login_client_id
  google_login_client_secret                = var.google_login_client_secret
  stripe_secret_key                         = var.stripe_secret_key
  stripe_webhook_secret                     = var.stripe_webhook_secret
  public_chat_base_url_override             = var.public_chat_base_url_override
  worker_tasks_service_url_override         = var.worker_tasks_service_url_override
  monitoring_enabled                        = var.monitoring_enabled
  monitoring_notification_emails            = var.monitoring_notification_emails
  monitoring_extra_notification_channel_ids = var.monitoring_extra_notification_channel_ids
  monitoring_uptime_host                    = var.monitoring_uptime_host
  monitoring_server_error_rate_threshold    = var.monitoring_server_error_rate_threshold
  monitoring_backend_latency_p95_ms         = var.monitoring_backend_latency_p95_ms
  monitoring_error_log_threshold            = var.monitoring_error_log_threshold
  monitoring_cloudsql_memory_threshold      = var.monitoring_cloudsql_memory_threshold
  monitoring_cloudsql_cpu_threshold         = var.monitoring_cloudsql_cpu_threshold
  monitoring_cloudsql_disk_threshold        = var.monitoring_cloudsql_disk_threshold
  monitoring_queue_depth_threshold          = var.monitoring_queue_depth_threshold
  monitoring_scheduler_failure_threshold    = var.monitoring_scheduler_failure_threshold
  monitoring_voice_turn_limit_threshold     = var.monitoring_voice_turn_limit_threshold
  monitoring_voice_abandoned_turn_threshold = var.monitoring_voice_abandoned_turn_threshold
  container_health_probes_enabled           = var.container_health_probes_enabled
  ops_event_webhook_url                     = var.ops_event_webhook_url
  ops_event_webhook_secret                  = var.ops_event_webhook_secret
  ops_event_webhook_events                  = var.ops_event_webhook_events
  ops_event_webhook_min_error_severity      = var.ops_event_webhook_min_error_severity
  ops_event_webhook_queue_limit             = var.ops_event_webhook_queue_limit

  # Email channel. The queue name follows the per-environment worker queues.
  email_channel_provider                       = var.email_channel_provider
  email_channel_inbound_domain                 = var.email_channel_inbound_domain
  email_channel_webhook_secret                 = var.email_channel_webhook_secret
  email_channel_webhook_secret_previous        = var.email_channel_webhook_secret_previous
  resend_channel_api_key                       = var.resend_channel_api_key
  email_channel_workers_enabled                = var.email_channel_workers_enabled
  email_channel_task_queue_name                = "radioso-${var.environment}-email-channel"
  email_channel_task_max_dispatches_per_second = var.email_channel_task_max_dispatches_per_second
  email_channel_task_max_concurrent_dispatches = var.email_channel_task_max_concurrent_dispatches
  email_channel_sweep_schedule                 = var.email_channel_sweep_schedule
  email_channel_sweep_max_jobs                 = var.email_channel_sweep_max_jobs
}

output "frontend_url" {
  value = module.radioso.frontend_url
}

output "frontend_service_name" {
  value = module.radioso.frontend_service_name
}

output "backend_url" {
  value = module.radioso.backend_url
}

output "backend_service_name" {
  value = module.radioso.backend_service_name
}

output "mcp_url" {
  value = module.radioso.mcp_url
}

output "worker_service_url" {
  value = module.radioso.worker_service_url
}

output "worker_service_name" {
  value = module.radioso.worker_service_name
}

output "artifact_registry_url" {
  value = module.radioso.artifact_registry_url
}

output "artifact_registry_repository_id" {
  value = module.radioso.artifact_registry_repository_id
}

output "document_storage_bucket_name" {
  value = module.radioso.document_storage_bucket_name
}

output "cloud_sql_connection_name" {
  value = module.radioso.cloud_sql_connection_name
}

output "app_base_url" {
  value = module.radioso.app_base_url
}
