locals {
  posthog_api_key_configured           = nonsensitive(try(length(trimspace(var.posthog_api_key)) > 0, false))
  slack_oauth_client_id_configured     = nonsensitive(try(length(trimspace(var.slack_oauth_client_id)) > 0, false))
  slack_oauth_client_secret_configured = nonsensitive(try(length(trimspace(var.slack_oauth_client_secret)) > 0, false))
  slack_signing_secret_configured      = nonsensitive(try(length(trimspace(var.slack_signing_secret)) > 0, false))
  ee_usage_admin_token_configured      = nonsensitive(try(length(trimspace(var.ee_usage_admin_token)) > 0, false))

  secret_values = merge(
    {
      "database-url"               = "postgres://${google_sql_user.radioso.name}:${random_password.db_password.result}@${google_sql_database_instance.postgres.private_ip_address}:5432/${google_sql_database.radioso.name}"
      "database-password"          = random_password.db_password.result
      "worker-task-auth-token"     = random_password.worker_task_auth_token.result
      "openai-api-key"             = var.openai_api_key
      "session-cookie-secret"      = var.session_cookie_secret
      "workspace-token-secret"     = var.workspace_token_secret
      "public-chat-session-secret" = var.public_chat_session_secret
      "connector-encryption-key"   = var.connector_encryption_key
      "radioso-mcp-signing-secret" = random_password.radioso_mcp_signing_secret.result
    },
    var.resend_mail_api_key != null ? {
      "resend-mail-api-key" = var.resend_mail_api_key
    } : {},
    nonsensitive(var.metrics_auth_token) == null ? {} : {
      "metrics-auth-token" = var.metrics_auth_token
    },
    local.posthog_api_key_configured ? {
      "posthog-api-key" = var.posthog_api_key
    } : {},
    local.slack_oauth_client_id_configured ? {
      "slack-oauth-client-id" = var.slack_oauth_client_id
    } : {},
    local.slack_oauth_client_secret_configured ? {
      "slack-oauth-client-secret" = var.slack_oauth_client_secret
    } : {},
    local.slack_signing_secret_configured ? {
      "slack-signing-secret" = var.slack_signing_secret
    } : {},
    local.ee_usage_admin_token_configured ? {
      "ee-usage-admin-token" = var.ee_usage_admin_token
    } : {},
  )

  secret_names = nonsensitive(toset(keys(merge(
    {
      "database-url"               = true
      "database-password"          = true
      "worker-task-auth-token"     = true
      "openai-api-key"             = true
      "session-cookie-secret"      = true
      "workspace-token-secret"     = true
      "public-chat-session-secret" = true
      "connector-encryption-key"   = true
      "radioso-mcp-signing-secret" = true
    },
    var.resend_mail_api_key != null ? {
      "resend-mail-api-key" = true
    } : {},
    nonsensitive(var.metrics_auth_token) == null ? {} : {
      "metrics-auth-token" = true
    },
    local.posthog_api_key_configured ? {
      "posthog-api-key" = true
    } : {},
    local.slack_oauth_client_id_configured ? {
      "slack-oauth-client-id" = true
    } : {},
    local.slack_oauth_client_secret_configured ? {
      "slack-oauth-client-secret" = true
    } : {},
    local.slack_signing_secret_configured ? {
      "slack-signing-secret" = true
    } : {},
    local.ee_usage_admin_token_configured ? {
      "ee-usage-admin-token" = true
    } : {},
  ))))
}

resource "google_secret_manager_secret" "secrets" {
  for_each  = local.secret_names
  secret_id = "${local.resource_name_prefix}-${each.key}"

  replication {
    dynamic "auto" {
      for_each = length(var.secret_replication_locations) == 0 ? [true] : []
      content {}
    }

    dynamic "user_managed" {
      for_each = length(var.secret_replication_locations) == 0 ? [] : [true]
      content {
        dynamic "replicas" {
          for_each = var.secret_replication_locations
          content {
            location = replicas.value
          }
        }
      }
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "secrets" {
  for_each    = local.secret_names
  secret      = google_secret_manager_secret.secrets[each.key].id
  secret_data = local.secret_values[each.key]
}

# Grant Cloud Run backend service account access to all secrets
resource "google_secret_manager_secret_iam_member" "backend_access" {
  for_each  = local.secret_names
  secret_id = google_secret_manager_secret.secrets[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${data.google_service_account.backend.email}"
}

resource "google_secret_manager_secret_iam_member" "worker_access" {
  for_each  = local.secret_names
  secret_id = google_secret_manager_secret.secrets[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${data.google_service_account.worker.email}"
}
