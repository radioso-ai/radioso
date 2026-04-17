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
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.radioso.repository_id}"
}

output "document_storage_bucket_name" {
  description = "GCS bucket storing original uploaded document files"
  value       = google_storage_bucket.documents.name
}

output "worker_service_name" {
  description = "Dedicated Cloud Run service that processes queued document jobs"
  value       = try(google_cloud_run_v2_service.document_worker[0].name, null)
}

output "worker_service_url" {
  description = "Dedicated Cloud Run service URL for internal document-processing tasks"
  value       = try(google_cloud_run_v2_service.document_worker[0].uri, null)
}

output "worker_task_queue_name" {
  description = "Cloud Tasks queue name used for document processing dispatch"
  value       = try(google_cloud_tasks_queue.document_processing[0].name, null)
}
