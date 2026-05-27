locals {
  document_worker_recovery_url = var.deploy_services ? "${google_cloud_run_v2_service.document_worker[0].uri}/internal/tasks/document-processing/recover" : null
  crawler_worker_recovery_url  = var.deploy_services ? "${google_cloud_run_v2_service.crawler_worker[0].uri}/internal/tasks/website-crawl/recover" : null
  worker_recovery_body         = base64encode(jsonencode({ maxJobs = var.worker_recovery_max_jobs }))
}

resource "google_cloud_scheduler_job" "document_worker_recovery" {
  count    = var.deploy_services ? 1 : 0
  name     = "${local.resource_name_prefix}-document-worker-recovery"
  region   = var.region
  schedule = var.worker_recovery_schedule

  http_target {
    http_method = "POST"
    uri         = local.document_worker_recovery_url
    body        = local.worker_recovery_body
    headers = {
      "Content-Type" = "application/json"
    }
    oidc_token {
      service_account_email = google_service_account.worker_task_invoker.email
      audience              = local.document_worker_recovery_url
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_scheduler_job" "crawler_worker_recovery" {
  count    = var.deploy_services ? 1 : 0
  name     = "${local.resource_name_prefix}-crawler-worker-recovery"
  region   = var.region
  schedule = var.worker_recovery_schedule

  http_target {
    http_method = "POST"
    uri         = local.crawler_worker_recovery_url
    body        = local.worker_recovery_body
    headers = {
      "Content-Type" = "application/json"
    }
    oidc_token {
      service_account_email = google_service_account.worker_task_invoker.email
      audience              = local.crawler_worker_recovery_url
    }
  }

  depends_on = [google_project_service.apis]
}
