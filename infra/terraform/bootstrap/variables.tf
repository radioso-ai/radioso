variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for the state bucket"
  type        = string
  default     = "us-central1"
}

variable "state_bucket_name" {
  description = "Name for the GCS bucket that stores Terraform state"
  type        = string
}
