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

  cleanup_policy_dry_run = false

  depends_on = [google_project_service.apis]
}
