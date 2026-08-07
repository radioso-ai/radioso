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
