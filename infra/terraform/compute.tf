# --- Service accounts ---

resource "google_service_account" "backend" {
  account_id   = "${local.service_name}-backend"
  display_name = "Hivec Backend Cloud Run"
}

resource "google_service_account" "frontend" {
  account_id   = "${local.service_name}-frontend"
  display_name = "Hivec Frontend Cloud Run"
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
        value = "postgres://${google_sql_user.hivec.name}:${random_password.db_password.result}@${google_sql_database_instance.postgres.private_ip_address}:5432/${google_sql_database.hivec.name}"
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
        value = "hivec_session"
      }
      env {
        name  = "SESSION_TTL_HOURS"
        value = tostring(var.session_ttl_hours)
      }
      dynamic "env" {
        for_each = var.connector_public_base_url == null ? [] : [var.connector_public_base_url]
        content {
          name  = "CONNECTOR_PUBLIC_BASE_URL"
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
