resource "google_storage_bucket" "documents" {
  name          = local.document_storage_bucket_name
  location      = var.region
  project       = var.project_id
  force_destroy = true

  uniform_bucket_level_access = true

  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "backend_documents_access" {
  bucket = google_storage_bucket.documents.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${data.google_service_account.backend.email}"
}

resource "google_storage_bucket_iam_member" "worker_documents_access" {
  bucket = google_storage_bucket.documents.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${data.google_service_account.worker.email}"
}
