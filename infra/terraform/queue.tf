data "google_service_account" "worker_task_invoker" {
  account_id = "${local.resource_name_prefix}-worker-task"
}

resource "google_cloud_tasks_queue" "document_processing" {
  count    = var.deploy_services ? 1 : 0
  name     = var.worker_task_queue_name
  location = var.region

  rate_limits {
    max_dispatches_per_second = var.worker_task_max_dispatches_per_second
    max_concurrent_dispatches = var.worker_task_max_concurrent_dispatches
  }

  retry_config {
    max_attempts = 10
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_tasks_queue" "website_crawls" {
  count    = var.deploy_services ? 1 : 0
  name     = var.worker_crawl_task_queue_name
  location = var.region

  rate_limits {
    max_dispatches_per_second = var.worker_crawl_task_max_dispatches_per_second
    max_concurrent_dispatches = var.worker_crawl_task_max_concurrent_dispatches
  }

  retry_config {
    max_attempts = 10
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_tasks_queue" "conversation_actions" {
  count    = var.deploy_services ? 1 : 0
  name     = var.action_dispatch_task_queue_name
  location = var.region

  rate_limits {
    max_dispatches_per_second = var.action_dispatch_task_max_dispatches_per_second
    max_concurrent_dispatches = var.action_dispatch_task_max_concurrent_dispatches
  }

  retry_config {
    max_attempts = 10
  }

  depends_on = [google_project_service.apis]
}

# Wakes the worker task server for durable background jobs (background_jobs). Each task
# asks for one drain; the job table stays authoritative, so a duplicate task finds nothing.
resource "google_cloud_tasks_queue" "background_jobs" {
  count    = var.deploy_services ? 1 : 0
  name     = var.background_job_task_queue_name
  location = var.region

  rate_limits {
    max_dispatches_per_second = var.background_job_task_max_dispatches_per_second
    max_concurrent_dispatches = var.background_job_task_max_concurrent_dispatches
  }

  retry_config {
    max_attempts = 10
  }

  depends_on = [google_project_service.apis]
}

# Inbound/review/reconcile drains for the email channel. Kept at low concurrency
# because the receiving provider's rate limits are undocumented (research B7).
resource "google_cloud_tasks_queue" "email_channel" {
  count    = var.deploy_services ? 1 : 0
  name     = var.email_channel_task_queue_name
  location = var.region

  rate_limits {
    max_dispatches_per_second = var.email_channel_task_max_dispatches_per_second
    max_concurrent_dispatches = var.email_channel_task_max_concurrent_dispatches
  }

  retry_config {
    max_attempts = 10
  }

  depends_on = [google_project_service.apis]
}
