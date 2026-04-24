data "google_project" "current" {
  project_id = var.project_id
}

resource "google_service_account" "github_actions_deployer" {
  account_id   = "${local.resource_name_prefix}-gha"
  display_name = "Radioso ${var.environment} GitHub Actions deployer"
}

resource "google_project_iam_member" "github_actions_run_admin" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.github_actions_deployer.email}"
}

resource "google_project_iam_member" "github_actions_artifact_registry_writer" {
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${google_service_account.github_actions_deployer.email}"
}

resource "google_service_account_iam_member" "github_actions_backend_act_as" {
  service_account_id = google_service_account.backend.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.github_actions_deployer.email}"
}

resource "google_service_account_iam_member" "github_actions_frontend_act_as" {
  service_account_id = google_service_account.frontend.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.github_actions_deployer.email}"
}

resource "google_service_account_iam_member" "github_actions_worker_act_as" {
  service_account_id = google_service_account.worker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.github_actions_deployer.email}"
}

resource "google_iam_workload_identity_pool" "github_actions" {
  workload_identity_pool_id = var.github_actions_workload_identity_pool_id
  display_name              = "GitHub Actions ${title(var.environment)}"
  description               = "OIDC trust for GitHub Actions deployments to Radioso ${var.environment}"

  depends_on = [
    google_project_service.apis["iam.googleapis.com"],
  ]
}

resource "google_iam_workload_identity_pool_provider" "github_actions" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github_actions.workload_identity_pool_id
  workload_identity_pool_provider_id = var.github_actions_workload_identity_provider_id
  display_name                       = "GitHub Actions ${title(var.environment)}"
  description                        = "OIDC provider for ${var.github_repository_owner}/${var.github_repository_name}"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.actor"      = "assertion.actor"
    "attribute.ref"        = "assertion.ref"
    "attribute.repository" = "assertion.repository"
  }

  attribute_condition = "assertion.repository == '${var.github_repository_owner}/${var.github_repository_name}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_actions_workload_identity_user" {
  service_account_id = google_service_account.github_actions_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/projects/${data.google_project.current.number}/locations/global/workloadIdentityPools/${google_iam_workload_identity_pool.github_actions.workload_identity_pool_id}/attribute.repository/${var.github_repository_owner}/${var.github_repository_name}"
}
