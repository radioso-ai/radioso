# --- Service accounts ---

data "google_service_account" "backend" {
  account_id = "${local.resource_name_prefix}-backend"
}

data "google_service_account" "frontend" {
  account_id = "${local.resource_name_prefix}-frontend"
}

data "google_service_account" "worker" {
  account_id = "${local.resource_name_prefix}-worker"
}

# --- Backend Cloud Run service ---

resource "google_cloud_run_v2_service" "backend" {
  count    = var.deploy_services ? 1 : 0
  name     = "${local.resource_name_prefix}-backend"
  location = var.region

  template {
    service_account = data.google_service_account.backend.email

    scaling {
      min_instance_count = var.backend_min_instances
      max_instance_count = var.backend_max_instances
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.vpc.name
        subnetwork = google_compute_subnetwork.subnet.name
      }
    }

    containers {
      image = var.backend_image

      ports {
        container_port = 8080
      }

      # Cloud Run's default startup probe only opens a TCP connection, which a process
      # that boots but cannot serve still satisfies. Probing the health route instead
      # makes a broken revision fail its rollout rather than take traffic.
      dynamic "startup_probe" {
        for_each = var.container_health_probes_enabled ? [1] : []
        content {
          initial_delay_seconds = 10
          period_seconds        = 10
          timeout_seconds       = 5
          failure_threshold     = 12
          http_get {
            path = "/health"
            port = 8080
          }
        }
      }

      dynamic "liveness_probe" {
        for_each = var.container_health_probes_enabled ? [1] : []
        content {
          period_seconds    = 30
          timeout_seconds   = 5
          failure_threshold = 3
          http_get {
            path = "/health"
            port = 8080
          }
        }
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
      # Ray turns run in the API process, so the budget bounding what one turn may spend on
      # replayed turns has to reach this service rather than the worker.
      env {
        name  = "COPILOT_PROBE_BUDGET_PER_TURN"
        value = tostring(var.copilot_probe_budget_per_turn)
      }
      env {
        name  = "PRODUCT_ANALYTICS_SINKS"
        value = var.product_analytics_sinks
      }
      env {
        name  = "ERROR_SINKS"
        value = var.error_sinks
      }
      dynamic "env" {
        for_each = var.ops_event_webhook_url == null ? [] : [var.ops_event_webhook_url]
        content {
          name  = "OPS_EVENT_WEBHOOK_URL"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.ops_event_webhook_events == null ? [] : [var.ops_event_webhook_events]
        content {
          name  = "OPS_EVENT_WEBHOOK_EVENTS"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.ops_event_webhook_url != null ? [var.ops_event_webhook_min_error_severity] : []
        content {
          name  = "OPS_EVENT_WEBHOOK_MIN_ERROR_SEVERITY"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.ops_event_webhook_url != null ? [var.ops_event_webhook_queue_limit] : []
        content {
          name  = "OPS_EVENT_WEBHOOK_QUEUE_LIMIT"
          value = tostring(env.value)
        }
      }
      dynamic "env" {
        for_each = local.ops_event_webhook_secret_configured ? [true] : []
        content {
          name = "OPS_EVENT_WEBHOOK_SECRET"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secrets["ops-event-webhook-secret"].secret_id
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.posthog_host == null ? [] : [var.posthog_host]
        content {
          name  = "POSTHOG_HOST"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.otel_logs_enabled ? [true] : []
        content {
          name  = "OTEL_LOGS_ENABLED"
          value = "true"
        }
      }
      dynamic "env" {
        for_each = var.otel_logs_enabled && local.otel_logs_endpoint != null ? [local.otel_logs_endpoint] : []
        content {
          name  = "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.otel_logs_enabled ? [var.otel_logs_min_level] : []
        content {
          name  = "OTEL_LOGS_MIN_LEVEL"
          value = env.value
        }
      }
      env {
        name  = "RADIOSO_EDITION"
        value = var.radioso_edition
      }
      dynamic "env" {
        for_each = local.enterprise_application_modules == null ? [] : [local.enterprise_application_modules]
        content {
          name  = "RADIOSO_APPLICATION_MODULES"
          value = env.value
        }
      }
      env {
        name  = "RADIOSO_WIDGET_ORIGIN"
        value = local.app_base_url
      }
      dynamic "env" {
        for_each = var.radioso_edition == "enterprise" ? [local.app_base_url] : []
        content {
          name  = "APP_BASE_URL"
          value = env.value
        }
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
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["database-url"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "WORKER_TASK_AUTH_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["worker-task-auth-token"].secret_id
            version = "latest"
          }
        }
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
      dynamic "env" {
        for_each = var.radioso_edition == "enterprise" ? ["radioso_staff_session"] : []
        content {
          name  = "STAFF_SESSION_COOKIE_NAME"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.radioso_edition == "enterprise" ? [tostring(var.staff_session_ttl_hours)] : []
        content {
          name  = "STAFF_SESSION_TTL_HOURS"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.ee_usage_admin_token_configured ? [1] : []
        content {
          name = "EE_USAGE_ADMIN_TOKEN"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secrets["ee-usage-admin-token"].secret_id
              version = "latest"
            }
          }
        }
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
        name  = "WORKER_TASKS_CRAWL_QUEUE_NAME"
        value = google_cloud_tasks_queue.website_crawls[0].name
      }
      env {
        name  = "ACTION_DISPATCH_TASK_QUEUE_NAME"
        value = google_cloud_tasks_queue.conversation_actions[0].name
      }
      env {
        name  = "WORKER_TASKS_SERVICE_URL"
        value = local.worker_tasks_service_url
      }
      env {
        name  = "WORKER_TASKS_CRAWL_SERVICE_URL"
        value = try(google_cloud_run_v2_service.crawler_worker[0].uri, "")
      }
      env {
        name  = "WORKER_TASKS_INVOKER_SERVICE_ACCOUNT"
        value = data.google_service_account.worker_task_invoker.email
      }
      env {
        name  = "DOCUMENT_PROCESSING_JOB_LEASE_MS"
        value = tostring(var.document_processing_job_lease_ms)
      }
      env {
        name  = "WEBSITE_CRAWL_JOB_LEASE_MS"
        value = tostring(var.website_crawl_job_lease_ms)
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
      dynamic "env" {
        for_each = local.posthog_api_key_configured ? [google_secret_manager_secret.secrets["posthog-api-key"].secret_id] : []
        content {
          name = "POSTHOG_API_KEY"
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.otel_logs_enabled && local.posthog_api_key_configured ? [google_secret_manager_secret.secrets["posthog-api-key"].secret_id] : []
        content {
          name = "OTEL_EXPORTER_OTLP_LOGS_AUTH_BEARER"
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = local.slack_oauth_client_id_configured ? [google_secret_manager_secret.secrets["slack-oauth-client-id"].secret_id] : []
        content {
          name = "SLACK_OAUTH_CLIENT_ID"
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = local.slack_oauth_client_secret_configured ? [google_secret_manager_secret.secrets["slack-oauth-client-secret"].secret_id] : []
        content {
          name = "SLACK_OAUTH_CLIENT_SECRET"
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = local.slack_signing_secret_configured ? [google_secret_manager_secret.secrets["slack-signing-secret"].secret_id] : []
        content {
          name = "SLACK_SIGNING_SECRET"
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.resend_mail_api_key != null ? [google_secret_manager_secret.secrets["resend-mail-api-key"].secret_id] : []
        content {
          name = "RESEND_MAIL_API_KEY"
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.mail_from_email != null ? [var.mail_from_email] : []
        content {
          name  = "MAIL_FROM_EMAIL"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.mail_from_name != null ? [var.mail_from_name] : []
        content {
          name  = "MAIL_FROM_NAME"
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
        name = "PUBLIC_CHAT_SESSION_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["public-chat-session-secret"].secret_id
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
      env {
        name = "RADIOSO_MCP_SIGNING_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["radioso-mcp-signing-secret"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "RADIOSO_TRUSTED_PROXY_HOPS"
        value = "2"
      }
      env {
        name  = "OPERATOR_MCP_ENABLED"
        value = tostring(var.operator_mcp_enabled)
      }
      dynamic "env" {
        for_each = var.operator_mcp_enabled ? [var.operator_mcp_public_origin] : []
        content {
          name  = "OPERATOR_MCP_RESOURCE_URL"
          value = "${env.value}/operator/mcp"
        }
      }
      dynamic "env" {
        for_each = var.operator_mcp_enabled ? [local.app_base_url] : []
        content {
          name  = "OPERATOR_MCP_ISSUER_URL"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.operator_mcp_enabled ? [var.operator_mcp_credential_epoch] : []
        content {
          name  = "OPERATOR_MCP_CREDENTIAL_EPOCH"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.operator_mcp_enabled ? [var.operator_mcp_rollout_workspace_ids] : []
        content {
          name  = "OPERATOR_MCP_ROLLOUT_WORKSPACE_IDS"
          value = join(",", var.operator_mcp_rollout_workspace_ids)
        }
      }
      dynamic "env" {
        for_each = var.operator_mcp_enabled ? [var.operator_mcp_verification_budget_per_minute] : []
        content {
          name  = "OPERATOR_MCP_VERIFICATION_BUDGET_PER_MINUTE"
          value = tostring(var.operator_mcp_verification_budget_per_minute)
        }
      }
      dynamic "env" {
        for_each = var.operator_mcp_enabled ? [true] : []
        content {
          name = "OPERATOR_MCP_INTERNAL_SECRET"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secrets["operator-mcp-internal-secret"].secret_id
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

  lifecycle {
    precondition {
      condition     = !var.otel_logs_enabled || local.otel_logs_endpoint != null
      error_message = "otel_logs_endpoint or posthog_host must be set when otel_logs_enabled is true."
    }

    precondition {
      condition     = !var.otel_logs_enabled || local.posthog_api_key_configured
      error_message = "posthog_api_key must be set when otel_logs_enabled is true."
    }

    ignore_changes = [
      client,
      client_version,
      template[0].containers[0].image,
    ]
  }
}

# Public access for backend (needed for webhook connectors)
resource "google_cloud_run_v2_service_iam_member" "backend_public" {
  count    = var.deploy_services && var.backend_public_invocation_enabled ? 1 : 0
  name     = google_cloud_run_v2_service.backend[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- Standalone MCP Cloud Run service ---

# The production backend image already contains the compiled MCP package. The
# standalone runtime caches only short-lived session tokens; the backend maps a
# grant version to its conversation atomically in PostgreSQL, so instances may
# scale independently without splitting a conversation.
resource "google_cloud_run_v2_service" "mcp" {
  count    = var.deploy_services && var.radioso_mcp_enabled ? 1 : 0
  name     = "${local.resource_name_prefix}-mcp"
  location = var.region

  template {
    service_account = data.google_service_account.backend.email

    scaling {
      min_instance_count = 0
      max_instance_count = var.backend_max_instances
    }

    containers {
      image   = var.backend_image
      command = ["node"]
      args    = ["../packages/radioso-mcp-server/dist/src/cli/http.js"]

      ports {
        container_port = 8080
      }

      # Cloud Run's default startup probe only opens a TCP connection, which a process
      # that boots but cannot serve still satisfies. Probing the health route instead
      # makes a broken revision fail its rollout rather than take traffic.
      dynamic "startup_probe" {
        for_each = var.container_health_probes_enabled ? [1] : []
        content {
          initial_delay_seconds = 10
          period_seconds        = 10
          timeout_seconds       = 5
          failure_threshold     = 12
          http_get {
            path = "/healthz"
            port = 8080
          }
        }
      }

      dynamic "liveness_probe" {
        for_each = var.container_health_probes_enabled ? [1] : []
        content {
          period_seconds    = 30
          timeout_seconds   = 5
          failure_threshold = 3
          http_get {
            path = "/healthz"
            port = 8080
          }
        }
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
        value = "radioso-mcp"
      }
      env {
        name  = "RADIOSO_BASE_URL"
        value = google_cloud_run_v2_service.backend[0].uri
      }
      env {
        name  = "RADIOSO_MCP_BIND_HOST"
        value = "0.0.0.0"
      }
      env {
        name  = "RADIOSO_MCP_BIND_PORT"
        value = "8080"
      }
      env {
        name = "RADIOSO_MCP_SIGNING_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["radioso-mcp-signing-secret"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "RADIOSO_TRUSTED_PROXY_HOPS"
        value = "2"
      }
      env {
        name  = "OPERATOR_MCP_ENABLED"
        value = tostring(var.operator_mcp_enabled)
      }
      dynamic "env" {
        for_each = var.operator_mcp_enabled ? [var.operator_mcp_public_origin] : []
        content {
          name  = "OPERATOR_MCP_RESOURCE_URL"
          value = "${env.value}/operator/mcp"
        }
      }
      dynamic "env" {
        for_each = var.operator_mcp_enabled ? [local.app_base_url] : []
        content {
          name  = "OPERATOR_MCP_ISSUER_URL"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.operator_mcp_enabled ? [var.operator_mcp_credential_epoch] : []
        content {
          name  = "OPERATOR_MCP_CREDENTIAL_EPOCH"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.operator_mcp_enabled ? [var.operator_mcp_rollout_workspace_ids] : []
        content {
          name  = "OPERATOR_MCP_ROLLOUT_WORKSPACE_IDS"
          value = join(",", var.operator_mcp_rollout_workspace_ids)
        }
      }
      dynamic "env" {
        for_each = var.operator_mcp_enabled ? [true] : []
        content {
          name = "OPERATOR_MCP_INTERNAL_SECRET"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secrets["operator-mcp-internal-secret"].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    precondition {
      condition     = var.backend_public_invocation_enabled
      error_message = "backend_public_invocation_enabled must be true when radioso_mcp_enabled is true so the standalone MCP service can call the backend converse API."
    }

    ignore_changes = [
      client,
      client_version,
      template[0].containers[0].image,
    ]
  }
}

resource "google_cloud_run_v2_service_iam_member" "mcp_public" {
  count    = var.deploy_services && var.radioso_mcp_enabled ? 1 : 0
  name     = google_cloud_run_v2_service.mcp[0].name
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
    service_account = data.google_service_account.frontend.email

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
        value = coalesce(var.frontend_backend_internal_url_override, google_cloud_run_v2_service.backend[0].uri)
      }
      env {
        name  = "RADIOSO_EDITION"
        value = var.radioso_edition
      }
      env {
        name  = "NEXT_PUBLIC_RADIOSO_EDITION"
        value = var.radioso_edition
      }
      dynamic "env" {
        for_each = var.deploy_services && var.radioso_mcp_enabled ? ["${google_cloud_run_v2_service.mcp[0].uri}/mcp"] : []
        content {
          name  = "RADIOSO_MCP_PUBLIC_URL"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.operator_mcp_enabled ? ["${var.operator_mcp_public_origin}/operator/mcp"] : []
        content {
          name  = "RADIOSO_OPERATOR_MCP_PUBLIC_URL"
          value = env.value
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.secrets,
  ]

  lifecycle {
    ignore_changes = [
      client,
      client_version,
      template[0].containers[0].image,
    ]
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
  name     = "${local.resource_name_prefix}-worker"
  location = var.region

  template {
    service_account = data.google_service_account.worker.email

    scaling {
      min_instance_count = var.worker_min_instances
      max_instance_count = var.worker_max_instances
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.vpc.name
        subnetwork = google_compute_subnetwork.subnet.name
      }
    }

    containers {
      image = var.backend_image

      command = ["npm", "run", "start:worker-server"]

      env {
        name = "WORKER_TASK_AUTH_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["worker-task-auth-token"].secret_id
            version = "latest"
          }
        }
      }

      resources {
        cpu_idle = true
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
        value = "radioso-worker"
      }
      # Retention is enforced by the worker's own sweep, so the window has to reach the worker.
      # Without this the service falls back to its in-process default and the documented knob
      # does nothing on a Terraform-managed deployment.
      env {
        name  = "COPILOT_CONVERSATION_RETENTION_DAYS"
        value = tostring(var.copilot_conversation_retention_days)
      }
      env {
        name  = "PRODUCT_ANALYTICS_SINKS"
        value = var.product_analytics_sinks
      }
      env {
        name  = "ERROR_SINKS"
        value = var.error_sinks
      }
      dynamic "env" {
        for_each = var.ops_event_webhook_url == null ? [] : [var.ops_event_webhook_url]
        content {
          name  = "OPS_EVENT_WEBHOOK_URL"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.ops_event_webhook_events == null ? [] : [var.ops_event_webhook_events]
        content {
          name  = "OPS_EVENT_WEBHOOK_EVENTS"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.ops_event_webhook_url != null ? [var.ops_event_webhook_min_error_severity] : []
        content {
          name  = "OPS_EVENT_WEBHOOK_MIN_ERROR_SEVERITY"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.ops_event_webhook_url != null ? [var.ops_event_webhook_queue_limit] : []
        content {
          name  = "OPS_EVENT_WEBHOOK_QUEUE_LIMIT"
          value = tostring(env.value)
        }
      }
      dynamic "env" {
        for_each = local.ops_event_webhook_secret_configured ? [true] : []
        content {
          name = "OPS_EVENT_WEBHOOK_SECRET"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secrets["ops-event-webhook-secret"].secret_id
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.posthog_host == null ? [] : [var.posthog_host]
        content {
          name  = "POSTHOG_HOST"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.otel_logs_enabled ? [true] : []
        content {
          name  = "OTEL_LOGS_ENABLED"
          value = "true"
        }
      }
      dynamic "env" {
        for_each = var.otel_logs_enabled && local.otel_logs_endpoint != null ? [local.otel_logs_endpoint] : []
        content {
          name  = "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.otel_logs_enabled ? [var.otel_logs_min_level] : []
        content {
          name  = "OTEL_LOGS_MIN_LEVEL"
          value = env.value
        }
      }
      env {
        name  = "RADIOSO_EDITION"
        value = var.radioso_edition
      }
      dynamic "env" {
        for_each = local.enterprise_application_modules == null ? [] : [local.enterprise_application_modules]
        content {
          name  = "RADIOSO_APPLICATION_MODULES"
          value = env.value
        }
      }
      env {
        name  = "RADIOSO_WIDGET_ORIGIN"
        value = local.app_base_url
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["database-url"].secret_id
            version = "latest"
          }
        }
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
      dynamic "env" {
        for_each = var.radioso_edition == "enterprise" ? ["radioso_staff_session"] : []
        content {
          name  = "STAFF_SESSION_COOKIE_NAME"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.radioso_edition == "enterprise" ? [tostring(var.staff_session_ttl_hours)] : []
        content {
          name  = "STAFF_SESSION_TTL_HOURS"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.ee_usage_admin_token_configured ? [1] : []
        content {
          name = "EE_USAGE_ADMIN_TOKEN"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secrets["ee-usage-admin-token"].secret_id
              version = "latest"
            }
          }
        }
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
        name  = "WORKER_TASKS_CRAWL_QUEUE_NAME"
        value = google_cloud_tasks_queue.website_crawls[0].name
      }
      env {
        name  = "ACTION_DISPATCH_TASK_QUEUE_NAME"
        value = google_cloud_tasks_queue.conversation_actions[0].name
      }
      env {
        name  = "WORKER_TASKS_SERVICE_URL"
        value = local.worker_tasks_service_url
      }
      env {
        name  = "WORKER_TASKS_CRAWL_SERVICE_URL"
        value = try(google_cloud_run_v2_service.crawler_worker[0].uri, "")
      }
      env {
        name  = "WORKER_TASKS_INVOKER_SERVICE_ACCOUNT"
        value = data.google_service_account.worker_task_invoker.email
      }
      env {
        name  = "DOCUMENT_PROCESSING_JOB_LEASE_MS"
        value = tostring(var.document_processing_job_lease_ms)
      }
      env {
        name  = "WEBSITE_CRAWL_JOB_LEASE_MS"
        value = tostring(var.website_crawl_job_lease_ms)
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
        for_each = var.resend_mail_api_key != null ? [google_secret_manager_secret.secrets["resend-mail-api-key"].secret_id] : []
        content {
          name = "RESEND_MAIL_API_KEY"
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = local.posthog_api_key_configured ? [google_secret_manager_secret.secrets["posthog-api-key"].secret_id] : []
        content {
          name = "POSTHOG_API_KEY"
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.otel_logs_enabled && local.posthog_api_key_configured ? [google_secret_manager_secret.secrets["posthog-api-key"].secret_id] : []
        content {
          name = "OTEL_EXPORTER_OTLP_LOGS_AUTH_BEARER"
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.mail_from_email != null ? [var.mail_from_email] : []
        content {
          name  = "MAIL_FROM_EMAIL"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.mail_from_name != null ? [var.mail_from_name] : []
        content {
          name  = "MAIL_FROM_NAME"
          value = env.value
        }
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

  lifecycle {
    ignore_changes = [
      client,
      client_version,
      template[0].containers[0].image,
    ]
  }
}

resource "google_cloud_run_v2_service_iam_member" "document_worker_invoker" {
  count    = var.deploy_services ? 1 : 0
  name     = google_cloud_run_v2_service.document_worker[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${data.google_service_account.worker_task_invoker.email}"
}

# --- Crawler worker Cloud Run service ---
# A dedicated worker service receives website-crawl Cloud Tasks pushes.
# Scheduled recovery handles missed dispatches without keeping a crawler
# instance warm continuously.

resource "google_cloud_run_v2_service" "crawler_worker" {
  count    = var.deploy_services ? 1 : 0
  name     = "${local.resource_name_prefix}-crawler-worker"
  location = var.region

  template {
    service_account = data.google_service_account.worker.email

    scaling {
      min_instance_count = var.crawler_worker_min_instances
      max_instance_count = var.crawler_worker_max_instances
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.vpc.name
        subnetwork = google_compute_subnetwork.subnet.name
      }
    }

    containers {
      image = var.backend_image

      command = ["npm", "run", "start:crawler-worker-server"]

      env {
        name = "WORKER_TASK_AUTH_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["worker-task-auth-token"].secret_id
            version = "latest"
          }
        }
      }

      resources {
        cpu_idle = true
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
        value = "radioso-crawler-worker"
      }
      env {
        name  = "PRODUCT_ANALYTICS_SINKS"
        value = var.product_analytics_sinks
      }
      env {
        name  = "ERROR_SINKS"
        value = var.error_sinks
      }
      dynamic "env" {
        for_each = var.ops_event_webhook_url == null ? [] : [var.ops_event_webhook_url]
        content {
          name  = "OPS_EVENT_WEBHOOK_URL"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.ops_event_webhook_events == null ? [] : [var.ops_event_webhook_events]
        content {
          name  = "OPS_EVENT_WEBHOOK_EVENTS"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.ops_event_webhook_url != null ? [var.ops_event_webhook_min_error_severity] : []
        content {
          name  = "OPS_EVENT_WEBHOOK_MIN_ERROR_SEVERITY"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.ops_event_webhook_url != null ? [var.ops_event_webhook_queue_limit] : []
        content {
          name  = "OPS_EVENT_WEBHOOK_QUEUE_LIMIT"
          value = tostring(env.value)
        }
      }
      dynamic "env" {
        for_each = local.ops_event_webhook_secret_configured ? [true] : []
        content {
          name = "OPS_EVENT_WEBHOOK_SECRET"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secrets["ops-event-webhook-secret"].secret_id
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.posthog_host == null ? [] : [var.posthog_host]
        content {
          name  = "POSTHOG_HOST"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.otel_logs_enabled ? [true] : []
        content {
          name  = "OTEL_LOGS_ENABLED"
          value = "true"
        }
      }
      dynamic "env" {
        for_each = var.otel_logs_enabled && local.otel_logs_endpoint != null ? [local.otel_logs_endpoint] : []
        content {
          name  = "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.otel_logs_enabled ? [var.otel_logs_min_level] : []
        content {
          name  = "OTEL_LOGS_MIN_LEVEL"
          value = env.value
        }
      }
      env {
        name  = "RADIOSO_EDITION"
        value = var.radioso_edition
      }
      dynamic "env" {
        for_each = local.enterprise_application_modules == null ? [] : [local.enterprise_application_modules]
        content {
          name  = "RADIOSO_APPLICATION_MODULES"
          value = env.value
        }
      }
      env {
        name  = "RADIOSO_WIDGET_ORIGIN"
        value = local.app_base_url
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["database-url"].secret_id
            version = "latest"
          }
        }
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
      dynamic "env" {
        for_each = var.radioso_edition == "enterprise" ? ["radioso_staff_session"] : []
        content {
          name  = "STAFF_SESSION_COOKIE_NAME"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.radioso_edition == "enterprise" ? [tostring(var.staff_session_ttl_hours)] : []
        content {
          name  = "STAFF_SESSION_TTL_HOURS"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.ee_usage_admin_token_configured ? [1] : []
        content {
          name = "EE_USAGE_ADMIN_TOKEN"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secrets["ee-usage-admin-token"].secret_id
              version = "latest"
            }
          }
        }
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
        name  = "WORKER_TASKS_CRAWL_QUEUE_NAME"
        value = google_cloud_tasks_queue.website_crawls[0].name
      }
      env {
        name  = "ACTION_DISPATCH_TASK_QUEUE_NAME"
        value = google_cloud_tasks_queue.conversation_actions[0].name
      }
      env {
        name  = "WORKER_TASKS_SERVICE_URL"
        value = local.worker_tasks_service_url
      }
      # WORKER_TASKS_CRAWL_SERVICE_URL is intentionally omitted on the crawler
      # worker: it never enqueues crawl tasks (only consumes them), so the
      # crawl dispatcher would just fall back to WORKER_TASKS_SERVICE_URL even
      # if invoked. Omitting it also avoids a self-reference cycle on the
      # crawler_worker resource.
      env {
        name  = "WORKER_TASKS_INVOKER_SERVICE_ACCOUNT"
        value = data.google_service_account.worker_task_invoker.email
      }
      env {
        name  = "DOCUMENT_PROCESSING_JOB_LEASE_MS"
        value = tostring(var.document_processing_job_lease_ms)
      }
      env {
        name  = "WEBSITE_CRAWL_JOB_LEASE_MS"
        value = tostring(var.website_crawl_job_lease_ms)
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
        for_each = local.posthog_api_key_configured ? [google_secret_manager_secret.secrets["posthog-api-key"].secret_id] : []
        content {
          name = "POSTHOG_API_KEY"
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.otel_logs_enabled && local.posthog_api_key_configured ? [google_secret_manager_secret.secrets["posthog-api-key"].secret_id] : []
        content {
          name = "OTEL_EXPORTER_OTLP_LOGS_AUTH_BEARER"
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
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

  lifecycle {
    ignore_changes = [
      client,
      client_version,
      template[0].containers[0].image,
    ]
  }
}

resource "google_cloud_run_v2_service_iam_member" "crawler_worker_invoker" {
  count    = var.deploy_services ? 1 : 0
  name     = google_cloud_run_v2_service.crawler_worker[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${data.google_service_account.worker_task_invoker.email}"
}
check "operator_mcp_configuration" {
  assert {
    condition     = !var.operator_mcp_enabled || (var.radioso_mcp_enabled && var.operator_mcp_public_origin != null)
    error_message = "operator_mcp_enabled requires radioso_mcp_enabled and operator_mcp_public_origin."
  }
}
