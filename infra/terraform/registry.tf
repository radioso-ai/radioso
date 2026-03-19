resource "google_artifact_registry_repository" "hivec" {
  location      = var.region
  repository_id = local.service_name
  format        = "DOCKER"
  description   = "Container images for Hivec frontend and backend"

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }

  depends_on = [google_project_service.apis]
}
