terraform {
  required_version = ">= 1.5"

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
  project = "radioso-494120"
  region  = var.region
}

provider "google-beta" {
  project = "radioso-494120"
  region  = var.region
}

module "radioso" {
  source = "../.."

  project_id      = "radioso-494120"
  environment     = "live"
  region          = var.region
  deploy_services = var.deploy_services

  backend_image  = var.backend_image
  frontend_image = var.frontend_image

  backend_min_instances  = 0
  backend_max_instances  = var.backend_max_instances
  frontend_min_instances = 0
  frontend_max_instances = var.frontend_max_instances
  worker_min_instances   = 1
  worker_max_instances   = var.worker_max_instances

  db_tier                = var.db_tier
  db_deletion_protection = true

  worker_task_queue_name                = "radioso-live-document-processing"
  worker_task_max_dispatches_per_second = var.worker_task_max_dispatches_per_second
  worker_task_max_concurrent_dispatches = var.worker_task_max_concurrent_dispatches
  document_processing_job_lease_ms      = var.document_processing_job_lease_ms
  document_storage_bucket_name          = var.document_storage_bucket_name
  document_upload_max_bytes             = var.document_upload_max_bytes
  openai_api_key                        = var.openai_api_key
  session_cookie_secret                 = var.session_cookie_secret
  workspace_token_secret                = var.workspace_token_secret
  website_embed_secret                  = var.website_embed_secret
  connector_encryption_key              = var.connector_encryption_key
  metrics_auth_token                    = var.metrics_auth_token
  openai_chat_model                     = var.openai_chat_model
  openai_rerank_model                   = var.openai_rerank_model
  openai_vector_model                   = var.openai_vector_model
  session_ttl_hours                     = var.session_ttl_hours
  auth_skip_email_verification          = false
  metrics_enabled                       = var.metrics_enabled
  connector_public_base_url             = var.connector_public_base_url
  app_base_url_override                 = var.app_base_url_override
  public_chat_base_url_override         = var.public_chat_base_url_override
  worker_tasks_service_url_override     = var.worker_tasks_service_url_override
  mail_driver                           = "log"
  mail_from_email                       = var.mail_from_email
  mail_from_name                        = var.mail_from_name
  mail_smtp_host                        = var.mail_smtp_host
  mail_smtp_port                        = var.mail_smtp_port
  mail_smtp_secure                      = var.mail_smtp_secure
  mail_smtp_username                    = var.mail_smtp_username
  mail_smtp_password                    = var.mail_smtp_password
}

output "frontend_url" {
  value = module.radioso.frontend_url
}

output "backend_url" {
  value = module.radioso.backend_url
}

output "worker_service_url" {
  value = module.radioso.worker_service_url
}

output "artifact_registry_url" {
  value = module.radioso.artifact_registry_url
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
