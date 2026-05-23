locals {
  radioso_mcp_signing_secret_configured = try(length(trimspace(nonsensitive(var.radioso_mcp_signing_secret))) > 0, false)
  posthog_api_key_configured            = try(length(trimspace(nonsensitive(var.posthog_api_key))) > 0, false)

  secret_values = merge(
    {
      "database-password"          = random_password.db_password.result
      "openai-api-key"             = var.openai_api_key
      "session-cookie-secret"      = var.session_cookie_secret
      "workspace-token-secret"     = var.workspace_token_secret
      "public-chat-session-secret" = var.public_chat_session_secret
      "connector-encryption-key"   = var.connector_encryption_key
    },
    var.radioso_mcp_enabled && local.radioso_mcp_signing_secret_configured ? {
      "radioso-mcp-signing-secret" = var.radioso_mcp_signing_secret
    } : {},
    var.resend_mail_api_key != null ? {
      "resend-mail-api-key" = var.resend_mail_api_key
    } : {},
    nonsensitive(var.metrics_auth_token) == null ? {} : {
      "metrics-auth-token" = var.metrics_auth_token
    },
    local.posthog_api_key_configured ? {
      "posthog-api-key" = var.posthog_api_key
    } : {},
  )

  secret_names = toset(keys(merge(
    {
      "database-password"          = true
      "openai-api-key"             = true
      "session-cookie-secret"      = true
      "workspace-token-secret"     = true
      "public-chat-session-secret" = true
      "connector-encryption-key"   = true
    },
    var.radioso_mcp_enabled && local.radioso_mcp_signing_secret_configured ? {
      "radioso-mcp-signing-secret" = true
    } : {},
    var.resend_mail_api_key != null ? {
      "resend-mail-api-key" = true
    } : {},
    nonsensitive(var.metrics_auth_token) == null ? {} : {
      "metrics-auth-token" = true
    },
    local.posthog_api_key_configured ? {
      "posthog-api-key" = true
    } : {},
  )))
}

resource "google_secret_manager_secret" "secrets" {
  for_each  = local.secret_names
  secret_id = "${local.resource_name_prefix}-${each.key}"

  replication {
    auto {}
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
  member    = "serviceAccount:${google_service_account.backend.email}"
}

resource "google_secret_manager_secret_iam_member" "worker_access" {
  for_each  = local.secret_names
  secret_id = google_secret_manager_secret.secrets[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.worker.email}"
}
