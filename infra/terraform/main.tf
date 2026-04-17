provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

data "google_project" "current" {
  project_id = var.project_id
}

locals {
  service_name                 = "radioso"
  document_storage_bucket_name = coalesce(var.document_storage_bucket_name, "${var.project_id}-${local.service_name}-documents")
}
