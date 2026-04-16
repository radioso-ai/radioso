# --- Service accounts ---

resource "google_service_account" "backend" {
  account_id   = "${local.service_name}-backend"
  display_name = "Hivec Backend Cloud Run"
}

resource "google_service_account" "frontend" {
  account_id   = "${local.service_name}-frontend"
  display_name = "Hivec Frontend Cloud Run"
}

resource "google_service_account" "worker" {
  account_id   = "${local.service_name}-worker"
  display_name = "Radioso Document Worker"
}

# --- Backend Cloud Run service ---

resource "google_cloud_run_v2_service" "backend" {
  count    = var.deploy_services ? 1 : 0
  name     = "${local.service_name}-backend"
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
      dynamic "env" {
        for_each = var.connector_public_base_url == null ? [] : [var.connector_public_base_url]
        content {
          name  = "CONNECTOR_PUBLIC_BASE_URL"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.public_chat_base_url == null ? [] : [var.public_chat_base_url]
        content {
          name  = "PUBLIC_CHAT_BASE_URL"
          value = env.value
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
  name     = "${local.service_name}-frontend"
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
  name     = "${local.service_name}-worker"
  location = var.region

  template {
    service_account = google_service_account.worker.email

    scaling {
      min_instance_count = var.worker_instance_count
      max_instance_count = var.worker_instance_count
    }

    vpc_access {
      connector = google_vpc_access_connector.connector.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image   = var.backend_image
      command = ["sh", "-c"]
      args = [
        "node ./dist/src/documentWorker.js & worker=$!; node -e \"require('node:http').createServer((_, res) => { res.statusCode = 204; res.end(); }).listen(process.env.PORT || 8080, '0.0.0.0')\" & server=$!; trap 'kill $worker $server 2>/dev/null || true' TERM INT; wait $worker; code=$?; kill $server 2>/dev/null || true; wait $server 2>/dev/null || true; exit $code",
      ]

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "PORT"
        value = "8080"
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
    }
  }

  depends_on = [
    google_secret_manager_secret_version.secrets,
    google_secret_manager_secret_iam_member.worker_access,
    google_storage_bucket_iam_member.worker_documents_access,
  ]
}
