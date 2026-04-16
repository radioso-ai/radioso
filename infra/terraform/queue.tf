resource "google_service_account" "worker_task_invoker" {
  account_id   = "${local.service_name}-worker-task"
  display_name = "Radioso Worker Task Invoker"
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

resource "google_project_iam_member" "backend_cloud_tasks_enqueuer" {
  project = var.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = "serviceAccount:${google_service_account.backend.email}"
}

resource "google_service_account_iam_member" "backend_worker_task_act_as" {
  service_account_id = google_service_account.worker_task_invoker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.backend.email}"
}
