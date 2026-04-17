locals {
  secrets = {
    "database-password"        = random_password.db_password.result
    "openai-api-key"           = var.openai_api_key
    "session-cookie-secret"    = var.session_cookie_secret
    "workspace-token-secret"   = var.workspace_token_secret
    "website-embed-secret"     = var.website_embed_secret
    "connector-encryption-key" = var.connector_encryption_key
  }
}

resource "google_secret_manager_secret" "secrets" {
  for_each  = local.secrets
  secret_id = "${local.service_name}-${each.key}"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "secrets" {
  for_each    = local.secrets
  secret      = google_secret_manager_secret.secrets[each.key].id
  secret_data = each.value
}

# Grant Cloud Run backend service account access to all secrets
resource "google_secret_manager_secret_iam_member" "backend_access" {
  for_each  = local.secrets
  secret_id = google_secret_manager_secret.secrets[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.backend.email}"
}

resource "google_secret_manager_secret_iam_member" "frontend_website_embed_access" {
  secret_id = google_secret_manager_secret.secrets["website-embed-secret"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.frontend.email}"
}

resource "google_secret_manager_secret_iam_member" "worker_access" {
  for_each  = local.secrets
  secret_id = google_secret_manager_secret.secrets[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.worker.email}"
}
