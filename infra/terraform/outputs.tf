output "frontend_url" {
  description = "Public URL of the Hivec frontend"
  value       = google_cloud_run_v2_service.frontend.uri
}

output "backend_url" {
  description = "Public URL of the Hivec backend API"
  value       = google_cloud_run_v2_service.backend.uri
}

output "cloud_sql_connection_name" {
  description = "Cloud SQL instance connection name (for Cloud SQL Auth Proxy if needed)"
  value       = google_sql_database_instance.postgres.connection_name
}

output "artifact_registry_url" {
  description = "Artifact Registry repository URL for pushing Docker images"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.hivec.repository_id}"
}
