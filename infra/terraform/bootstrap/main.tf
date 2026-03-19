terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_storage_bucket" "terraform_state" {
  name     = var.state_bucket_name
  location = var.region
  project  = var.project_id

  versioning {
    enabled = true
  }

  uniform_bucket_level_access = true

  lifecycle {
    prevent_destroy = true
  }
}
