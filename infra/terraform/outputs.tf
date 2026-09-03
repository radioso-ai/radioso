output "frontend_url" {
  description = "Public URL of the Radioso frontend"
  value       = try(google_cloud_run_v2_service.frontend[0].uri, null)
}

output "frontend_cdn_ip" {
  description = "Global IP of the frontend HTTPS load balancer. Point the frontend domain's A record here. Null when frontend_cdn_domain is unset."
  value       = try(google_compute_global_address.frontend[0].address, null)
}

output "frontend_service_name" {
  description = "Cloud Run service name for the Radioso frontend"
  value       = try(google_cloud_run_v2_service.frontend[0].name, null)
}

output "backend_url" {
  description = "Public URL of the Radioso backend API"
  value       = try(google_cloud_run_v2_service.backend[0].uri, null)
}

output "backend_service_name" {
  description = "Cloud Run service name for the Radioso backend API"
  value       = try(google_cloud_run_v2_service.backend[0].name, null)
}

output "mcp_url" {
  description = "Public standalone MCP endpoint. Null when MCP deployment is disabled."
  value       = try("${google_cloud_run_v2_service.mcp[0].uri}/mcp", null)
}

output "cloud_sql_connection_name" {
  description = "Cloud SQL instance connection name (for Cloud SQL Auth Proxy if needed)"
  value       = google_sql_database_instance.postgres.connection_name
}

output "artifact_registry_url" {
  description = "Artifact Registry repository URL for pushing Docker images"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.radioso.repository_id}"
}

output "artifact_registry_repository_id" {
  description = "Artifact Registry Docker repository ID used for application images"
  value       = google_artifact_registry_repository.radioso.repository_id
}

output "environment" {
  description = "Resolved deployment environment."
  value       = var.environment
}

output "app_base_url" {
  description = "Resolved public Radioso app URL used in backend-generated links."
  value       = local.app_base_url
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

output "crawler_worker_service_name" {
  description = "Dedicated Cloud Run service that runs website crawl jobs"
  value       = try(google_cloud_run_v2_service.crawler_worker[0].name, null)
}

output "crawler_worker_service_url" {
  description = "Dedicated Cloud Run service URL for internal website-crawl tasks"
  value       = try(google_cloud_run_v2_service.crawler_worker[0].uri, null)
}

output "worker_task_queue_name" {
  description = "Cloud Tasks queue name used for document processing dispatch"
  value       = try(google_cloud_tasks_queue.document_processing[0].name, null)
}

output "worker_crawl_task_queue_name" {
  description = "Cloud Tasks queue name used for website crawl dispatch"
  value       = try(google_cloud_tasks_queue.website_crawls[0].name, null)
}

output "monitoring_notification_channel_ids" {
  description = "Notification channels alert policies deliver to, including any supplied outside Terraform."
  value       = local.notification_channel_ids
}

output "backend_uptime_check_id" {
  description = "Cloud Monitoring uptime check watching the backend health endpoint. Null when monitoring is disabled."
  value       = try(google_monitoring_uptime_check_config.backend[0].uptime_check_id, null)
}

output "application_error_log_metric_name" {
  description = "Log-based metric counting error-level application logs across this stack's Cloud Run services. Null when monitoring is disabled."
  value       = try(google_logging_metric.application_errors[0].name, null)
}
