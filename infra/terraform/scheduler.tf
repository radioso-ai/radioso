locals {
  document_worker_recovery_url = var.deploy_services ? "${google_cloud_run_v2_service.document_worker[0].uri}/internal/tasks/document-processing/recover" : null
  crawler_worker_recovery_url  = var.deploy_services ? "${google_cloud_run_v2_service.crawler_worker[0].uri}/internal/tasks/website-crawl/recover" : null
  worker_recovery_body         = base64encode(jsonencode({ maxJobs = var.worker_recovery_max_jobs }))
  # Same worker task Cloud Run service as document-processing recovery — the
  # conversation-action drain endpoints are additional routes on that service, not a
  # separate service.
  action_dispatch_recovery_url  = var.deploy_services ? "${google_cloud_run_v2_service.document_worker[0].uri}/internal/tasks/actions/recover" : null
  action_dispatch_recovery_body = base64encode(jsonencode({ maxJobs = var.action_dispatch_recovery_max_jobs }))
  # Retention has no per-item queue behind it, so this schedule is the whole trigger.
  copilot_retention_url = var.deploy_services ? "${google_cloud_run_v2_service.document_worker[0].uri}/internal/tasks/copilot-retention/sweep" : null
}

resource "google_cloud_scheduler_job" "document_worker_recovery" {
  count    = var.deploy_services ? 1 : 0
  name     = "${local.resource_name_prefix}-document-worker-recovery"
  region   = var.region
  schedule = local.document_worker_recovery_schedule

  http_target {
    http_method = "POST"
    uri         = local.document_worker_recovery_url
    body        = local.worker_recovery_body
    headers = {
      "Content-Type"           = "application/json"
      "X-Radioso-Worker-Token" = random_password.worker_task_auth_token.result
    }
    oidc_token {
      service_account_email = data.google_service_account.worker_task_invoker.email
      audience              = local.document_worker_recovery_url
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_scheduler_job" "crawler_worker_recovery" {
  count    = var.deploy_services ? 1 : 0
  name     = "${local.resource_name_prefix}-crawler-worker-recovery"
  region   = var.region
  schedule = local.crawler_worker_recovery_schedule

  http_target {
    http_method = "POST"
    uri         = local.crawler_worker_recovery_url
    body        = local.worker_recovery_body
    headers = {
      "Content-Type"           = "application/json"
      "X-Radioso-Worker-Token" = random_password.worker_task_auth_token.result
    }
    oidc_token {
      service_account_email = data.google_service_account.worker_task_invoker.email
      audience              = local.crawler_worker_recovery_url
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_scheduler_job" "action_dispatch_recovery" {
  count    = var.deploy_services ? 1 : 0
  name     = "${local.resource_name_prefix}-action-dispatch-recovery"
  region   = var.region
  schedule = local.action_dispatch_recovery_schedule

  http_target {
    http_method = "POST"
    uri         = local.action_dispatch_recovery_url
    body        = local.action_dispatch_recovery_body
    headers = {
      "Content-Type"           = "application/json"
      "X-Radioso-Worker-Token" = random_password.worker_task_auth_token.result
    }
    oidc_token {
      service_account_email = data.google_service_account.worker_task_invoker.email
      audience              = local.action_dispatch_recovery_url
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_scheduler_job" "copilot_retention" {
  count    = var.deploy_services ? 1 : 0
  name     = "${local.resource_name_prefix}-copilot-retention"
  region   = var.region
  schedule = local.copilot_retention_schedule

  http_target {
    http_method = "POST"
    uri         = local.copilot_retention_url
    body        = base64encode(jsonencode({}))
    headers = {
      "Content-Type"           = "application/json"
      "X-Radioso-Worker-Token" = random_password.worker_task_auth_token.result
    }
    oidc_token {
      service_account_email = data.google_service_account.worker_task_invoker.email
      audience              = local.copilot_retention_url
    }
  }

  depends_on = [google_project_service.apis]
}
