output "frontend_url" {
  description = "Public URL of the Hivec frontend"
  value       = try(google_cloud_run_v2_service.frontend[0].uri, null)
}

output "backend_url" {
  description = "Public URL of the Hivec backend API"
  value       = try(google_cloud_run_v2_service.backend[0].uri, null)
}

output "cloud_sql_connection_name" {
  description = "Cloud SQL instance connection name (for Cloud SQL Auth Proxy if needed)"
  value       = google_sql_database_instance.postgres.connection_name
}

output "artifact_registry_url" {
  description = "Artifact Registry repository URL for pushing Docker images"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.hivec.repository_id}"
}
