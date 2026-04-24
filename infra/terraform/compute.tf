# --- Service accounts ---

resource "google_service_account" "backend" {
  account_id   = "${local.resource_name_prefix}-backend"
  display_name = "Radioso ${var.environment} backend Cloud Run"
}

resource "google_service_account" "frontend" {
  account_id   = "${local.resource_name_prefix}-frontend"
  display_name = "Radioso ${var.environment} frontend Cloud Run"
}

resource "google_service_account" "worker" {
  account_id   = "${local.resource_name_prefix}-worker"
  display_name = "Radioso ${var.environment} document worker"
}

# --- Backend Cloud Run service ---

resource "google_cloud_run_v2_service" "backend" {
  count    = var.deploy_services ? 1 : 0
  name     = "${local.resource_name_prefix}-backend"
  location = var.region

  template {
    service_account = google_service_account.backend.email

    scaling {
      min_instance_count = var.backend_min_instances
      max_instance_count = var.backend_max_instances
    }

    vpc_access {
      connector = google_vpc_access_connector.connector.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = var.backend_image

      ports {
        container_port = 8080
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "OBSERVABILITY_ENVIRONMENT"
        value = var.environment
      }
      env {
        name  = "OBSERVABILITY_SERVICE_NAME"
        value = "radioso-api"
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "METRICS_ENABLED"
        value = tostring(var.metrics_enabled)
      }
      env {
        name  = "DATABASE_URL"
        value = "postgres://${google_sql_user.radioso.name}:${random_password.db_password.result}@${google_sql_database_instance.postgres.private_ip_address}:5432/${google_sql_database.radioso.name}"
      }
      env {
        name  = "OPENAI_CHAT_MODEL"
        value = var.openai_chat_model
      }
      env {
        name  = "OPENAI_RERANK_MODEL"
        value = var.openai_rerank_model
      }
      env {
        name  = "OPENAI_VECTOR_MODEL"
        value = var.openai_vector_model
      }
      env {
        name  = "SESSION_COOKIE_NAME"
        value = "radioso_session"
      }
      env {
        name  = "SESSION_TTL_HOURS"
        value = tostring(var.session_ttl_hours)
      }
      env {
        name  = "AUTH_SKIP_EMAIL_VERIFICATION"
        value = tostring(var.auth_skip_email_verification)
      }
      env {
        name  = "DOCUMENT_STORAGE_DRIVER"
        value = "gcs"
      }
      env {
        name  = "DOCUMENT_STORAGE_BUCKET"
        value = google_storage_bucket.documents.name
      }
      env {
        name  = "DOCUMENT_UPLOAD_MAX_BYTES"
        value = tostring(var.document_upload_max_bytes)
      }
      env {
        name  = "WORKER_DISPATCH_DRIVER"
        value = "cloud-tasks"
      }
      env {
        name  = "WORKER_TASKS_QUEUE_LOCATION"
        value = var.region
      }
      env {
        name  = "WORKER_TASKS_QUEUE_NAME"
        value = google_cloud_tasks_queue.document_processing[0].name
      }
      env {
        name  = "WORKER_TASKS_SERVICE_URL"
        value = local.worker_tasks_service_url
      }
      env {
        name  = "WORKER_TASKS_INVOKER_SERVICE_ACCOUNT"
        value = google_service_account.worker_task_invoker.email
      }
      env {
        name  = "DOCUMENT_PROCESSING_JOB_LEASE_MS"
        value = tostring(var.document_processing_job_lease_ms)
      }
      env {
        name  = "APP_BASE_URL"
        value = local.app_base_url
      }
      env {
        name  = "MAIL_DRIVER"
        value = var.mail_driver
      }
      env {
        name  = "MAIL_FROM_EMAIL"
        value = var.mail_from_email
      }
      env {
        name  = "MAIL_FROM_NAME"
        value = var.mail_from_name
      }
      dynamic "env" {
        for_each = var.mail_smtp_host == null ? [] : [var.mail_smtp_host]
        content {
          name  = "MAIL_SMTP_HOST"
          value = env.value
        }
      }
      env {
        name  = "MAIL_SMTP_PORT"
        value = tostring(var.mail_smtp_port)
      }
      env {
        name  = "MAIL_SMTP_SECURE"
        value = tostring(var.mail_smtp_secure)
      }
      dynamic "env" {
        for_each = var.connector_public_base_url == null ? [] : [var.connector_public_base_url]
        content {
          name  = "CONNECTOR_PUBLIC_BASE_URL"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.public_chat_base_url == null ? [] : [local.public_chat_base_url]
        content {
          name  = "PUBLIC_CHAT_BASE_URL"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.metrics_auth_token == null ? [] : [var.metrics_auth_token]
        content {
          name = "METRICS_AUTH_TOKEN"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secrets["metrics-auth-token"].secret_id
              version = "latest"
            }
          }
        }
      }

      # Secrets from Secret Manager
      env {
        name = "OPENAI_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["openai-api-key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "SESSION_COOKIE_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["session-cookie-secret"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "WORKSPACE_TOKEN_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["workspace-token-secret"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "WEBSITE_EMBED_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["website-embed-secret"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "CONNECTOR_ENCRYPTION_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["connector-encryption-key"].secret_id
            version = "latest"
          }
        }
      }
      dynamic "env" {
        for_each = var.mail_smtp_username == null ? [] : [var.mail_smtp_username]
        content {
          name = "MAIL_SMTP_USERNAME"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secrets["mail-smtp-username"].secret_id
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.mail_smtp_password == null ? [] : [var.mail_smtp_password]
        content {
          name = "MAIL_SMTP_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secrets["mail-smtp-password"].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.secrets,
    google_secret_manager_secret_iam_member.backend_access,
    google_storage_bucket_iam_member.backend_documents_access,
  ]
}

# Public access for backend (needed for webhook connectors)
resource "google_cloud_run_v2_service_iam_member" "backend_public" {
  count    = var.deploy_services ? 1 : 0
  name     = google_cloud_run_v2_service.backend[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- Frontend Cloud Run service ---

resource "google_cloud_run_v2_service" "frontend" {
  count    = var.deploy_services ? 1 : 0
  name     = "${local.resource_name_prefix}-frontend"
  location = var.region

  template {
    service_account = google_service_account.frontend.email

    scaling {
      min_instance_count = var.frontend_min_instances
      max_instance_count = var.frontend_max_instances
    }

    containers {
      image = var.frontend_image

      ports {
        container_port = 3000
      }

      env {
        name  = "BACKEND_INTERNAL_URL"
        value = google_cloud_run_v2_service.backend[0].uri
      }
      env {
        name = "WEBSITE_EMBED_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["website-embed-secret"].secret_id
            version = "latest"
          }
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.secrets,
    google_secret_manager_secret_iam_member.frontend_website_embed_access,
  ]
}

# Public access for frontend
resource "google_cloud_run_v2_service_iam_member" "frontend_public" {
  count    = var.deploy_services ? 1 : 0
  name     = google_cloud_run_v2_service.frontend[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service" "document_worker" {
  count    = var.deploy_services ? 1 : 0
  name     = "${local.resource_name_prefix}-worker"
  location = var.region

  template {
    service_account = google_service_account.worker.email

    scaling {
      min_instance_count = var.worker_min_instances
      max_instance_count = var.worker_max_instances
    }

    vpc_access {
      connector = google_vpc_access_connector.connector.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = var.backend_image

      command = ["npm", "run", "start:worker-server"]

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "OBSERVABILITY_ENVIRONMENT"
        value = var.environment
      }
      env {
        name  = "OBSERVABILITY_SERVICE_NAME"
        value = "radioso-worker"
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "DATABASE_URL"
        value = "postgres://${google_sql_user.radioso.name}:${random_password.db_password.result}@${google_sql_database_instance.postgres.private_ip_address}:5432/${google_sql_database.radioso.name}"
      }
      env {
        name  = "OPENAI_CHAT_MODEL"
        value = var.openai_chat_model
      }
      env {
        name  = "OPENAI_RERANK_MODEL"
        value = var.openai_rerank_model
      }
      env {
        name  = "OPENAI_VECTOR_MODEL"
        value = var.openai_vector_model
      }
      env {
        name  = "SESSION_COOKIE_NAME"
        value = "radioso_session"
      }
      env {
        name  = "SESSION_TTL_HOURS"
        value = tostring(var.session_ttl_hours)
      }
      env {
        name  = "AUTH_SKIP_EMAIL_VERIFICATION"
        value = tostring(var.auth_skip_email_verification)
      }
      env {
        name  = "DOCUMENT_STORAGE_DRIVER"
        value = "gcs"
      }
      env {
        name  = "DOCUMENT_STORAGE_BUCKET"
        value = google_storage_bucket.documents.name
      }
      env {
        name  = "DOCUMENT_UPLOAD_MAX_BYTES"
        value = tostring(var.document_upload_max_bytes)
      }
      env {
        name  = "WORKER_DISPATCH_DRIVER"
        value = "cloud-tasks"
      }
      env {
        name  = "WORKER_TASKS_QUEUE_LOCATION"
        value = var.region
      }
      env {
        name  = "WORKER_TASKS_QUEUE_NAME"
        value = google_cloud_tasks_queue.document_processing[0].name
      }
      env {
        name  = "WORKER_TASKS_SERVICE_URL"
        value = local.worker_tasks_service_url
      }
      env {
        name  = "WORKER_TASKS_INVOKER_SERVICE_ACCOUNT"
        value = google_service_account.worker_task_invoker.email
      }
      env {
        name  = "DOCUMENT_PROCESSING_JOB_LEASE_MS"
        value = tostring(var.document_processing_job_lease_ms)
      }
      env {
        name  = "APP_BASE_URL"
        value = local.app_base_url
      }
      env {
        name  = "MAIL_DRIVER"
        value = var.mail_driver
      }
      env {
        name  = "MAIL_FROM_EMAIL"
        value = var.mail_from_email
      }
      env {
        name  = "MAIL_FROM_NAME"
        value = var.mail_from_name
      }
      dynamic "env" {
        for_each = var.mail_smtp_host == null ? [] : [var.mail_smtp_host]
        content {
          name  = "MAIL_SMTP_HOST"
          value = env.value
        }
      }
      env {
        name  = "MAIL_SMTP_PORT"
        value = tostring(var.mail_smtp_port)
      }
      env {
        name  = "MAIL_SMTP_SECURE"
        value = tostring(var.mail_smtp_secure)
      }
      dynamic "env" {
        for_each = var.connector_public_base_url == null ? [] : [var.connector_public_base_url]
        content {
          name  = "CONNECTOR_PUBLIC_BASE_URL"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.public_chat_base_url == null ? [] : [local.public_chat_base_url]
        content {
          name  = "PUBLIC_CHAT_BASE_URL"
          value = env.value
        }
      }

      resources {
        cpu_idle = false
      }

      env {
        name = "OPENAI_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["openai-api-key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "SESSION_COOKIE_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["session-cookie-secret"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "WORKSPACE_TOKEN_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["workspace-token-secret"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "WEBSITE_EMBED_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["website-embed-secret"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "CONNECTOR_ENCRYPTION_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["connector-encryption-key"].secret_id
            version = "latest"
          }
        }
      }
      dynamic "env" {
        for_each = var.mail_smtp_username == null ? [] : [var.mail_smtp_username]
        content {
          name = "MAIL_SMTP_USERNAME"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secrets["mail-smtp-username"].secret_id
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.mail_smtp_password == null ? [] : [var.mail_smtp_password]
        content {
          name = "MAIL_SMTP_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secrets["mail-smtp-password"].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.secrets,
    google_secret_manager_secret_iam_member.worker_access,
    google_storage_bucket_iam_member.worker_documents_access,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "document_worker_invoker" {
  count    = var.deploy_services ? 1 : 0
  name     = google_cloud_run_v2_service.document_worker[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.worker_task_invoker.email}"
}
