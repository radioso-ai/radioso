resource "google_artifact_registry_repository" "radioso" {
  location      = var.region
  repository_id = local.resource_name_prefix
  format        = "DOCKER"
  description   = "Container images for Radioso ${var.environment}"

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }

  cleanup_policies {
    id     = "delete-untagged-older-than-7-days"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "604800s"
    }
  }

  cleanup_policies {
    id     = "delete-tagged-older-than-30-days"
    action = "DELETE"
    condition {
      tag_state  = "TAGGED"
      older_than = "2592000s"
    }
  }

  cleanup_policy_dry_run = false

  depends_on = [google_project_service.apis]
}

# The image deploy workflow's identity, from the foundation. Its push access is granted on this
# repository rather than the project, because live and live-eu share a project.
data "google_service_account" "deploy" {
  account_id = "${local.resource_name_prefix}-deploy"
}

resource "google_artifact_registry_repository_iam_member" "deploy_push" {
  location   = google_artifact_registry_repository.radioso.location
  repository = google_artifact_registry_repository.radioso.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${data.google_service_account.deploy.email}"
}
