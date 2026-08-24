terraform {
  # >= 1.7 for the `removed` blocks below.
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

# live-eu is a second regional stack inside the live project, so it shares one
# identity plane with it: the same `radioso-live-*` service accounts, the same
# `radioso-live-gha` deployer and the same `github-actions` workload identity
# pool, all in radioso-494120. Both states have been recording those same objects
# since before #1001 split them into the foundation module, which is why this root
# does not instantiate `module "foundation"` — the live root owns it, exactly as
# `manage_project_services = false` below already hands API enablement to live.
#
# These entries are released from this state rather than deleted: `destroy = false`
# drops the record while leaving the object in place for the live state to manage.
# Without this, the resources are in state with no configuration behind them and
# Terraform plans to destroy the identities this stack runs on.
removed {
  from = module.radioso.google_iam_workload_identity_pool.github_actions

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.radioso.google_iam_workload_identity_pool_provider.github_actions

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.radioso.google_project_iam_member.backend_cloud_tasks_enqueuer

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.radioso.google_project_iam_member.github_actions_artifact_registry_writer

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.radioso.google_project_iam_member.github_actions_cloud_scheduler_admin

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.radioso.google_project_iam_member.github_actions_run_admin

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.radioso.google_project_iam_member.worker_cloud_tasks_enqueuer

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.radioso.google_service_account.backend

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.radioso.google_service_account.frontend

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.radioso.google_service_account.github_actions_deployer

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.radioso.google_service_account.worker

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.radioso.google_service_account.worker_task_invoker

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.radioso.google_service_account_iam_member.backend_worker_task_act_as

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.radioso.google_service_account_iam_member.github_actions_backend_act_as

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.radioso.google_service_account_iam_member.github_actions_frontend_act_as

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.radioso.google_service_account_iam_member.github_actions_worker_act_as

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.radioso.google_service_account_iam_member.github_actions_worker_task_invoker_act_as

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.radioso.google_service_account_iam_member.github_actions_workload_identity_user

  lifecycle {
    destroy = false
  }
}

removed {
  from = module.radioso.google_service_account_iam_member.worker_worker_task_act_as

  lifecycle {
    destroy = false
  }
}

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

  db_tier                = var.db_tier
  db_deletion_protection = true

  secret_replication_locations = [var.region]

  worker_task_queue_name                = "radioso-${var.environment}-document-processing"
  worker_crawl_task_queue_name          = "radioso-${var.environment}-website-crawls"
  worker_task_max_dispatches_per_second = var.worker_task_max_dispatches_per_second
  worker_task_max_concurrent_dispatches = var.worker_task_max_concurrent_dispatches
  document_processing_job_lease_ms      = var.document_processing_job_lease_ms
  website_crawl_job_lease_ms            = var.website_crawl_job_lease_ms
  document_worker_recovery_schedule     = var.document_worker_recovery_schedule
  crawler_worker_recovery_schedule      = var.crawler_worker_recovery_schedule
  document_storage_bucket_name          = var.document_storage_bucket_name
  document_upload_max_bytes             = var.document_upload_max_bytes
  openai_api_key                        = var.openai_api_key
  session_cookie_secret                 = var.session_cookie_secret
  workspace_token_secret                = var.workspace_token_secret
  public_chat_session_secret            = var.public_chat_session_secret
  radioso_mcp_signing_secret            = var.radioso_mcp_signing_secret
  connector_encryption_key              = var.connector_encryption_key
  ee_usage_admin_token                  = var.ee_usage_admin_token
  slack_oauth_client_id                 = var.slack_oauth_client_id
  slack_oauth_client_secret             = var.slack_oauth_client_secret
  slack_signing_secret                  = var.slack_signing_secret
  resend_mail_api_key                   = var.resend_mail_api_key
  mail_from_email                       = var.mail_from_email
  mail_from_name                        = var.mail_from_name
  metrics_auth_token                    = var.metrics_auth_token
  product_analytics_sinks               = var.product_analytics_sinks
  error_sinks                           = var.error_sinks
  posthog_api_key                       = var.posthog_api_key
  posthog_host                          = var.posthog_host
  otel_logs_enabled                     = var.otel_logs_enabled
  otel_logs_min_level                   = var.otel_logs_min_level
  openai_chat_model                     = var.openai_chat_model
  openai_rerank_model                   = var.openai_rerank_model
  openai_vector_model                   = var.openai_vector_model
  session_ttl_hours                     = var.session_ttl_hours
  metrics_enabled                       = var.metrics_enabled
  connector_public_base_url             = var.connector_public_base_url
  radioso_mcp_enabled                   = var.radioso_mcp_enabled
  radioso_mcp_base_url_override         = var.radioso_mcp_base_url_override
  app_base_url_override                 = var.app_base_url_override
  public_chat_base_url_override         = var.public_chat_base_url_override
  worker_tasks_service_url_override     = var.worker_tasks_service_url_override
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
