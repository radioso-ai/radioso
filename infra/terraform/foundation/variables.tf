variable "project_id" {
  description = "GCP project ID that hosts the environment foundation."
  type        = string
}

variable "project_number" {
  description = "Numeric GCP project number used to construct the GitHub OIDC principal."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.project_number))
    error_message = "project_number must contain only decimal digits."
  }
}

variable "environment" {
  description = "Environment name used in foundation resource names."
  type        = string
}

variable "region" {
  description = "Default region for foundation resources."
  type        = string
}

variable "terraform_state_bucket_name" {
  description = "Existing GCS bucket that stores this environment's Terraform state."
  type        = string
}

variable "github_repository_owner" {
  description = "GitHub organization or user allowed to federate with this environment."
  type        = string
  default     = "radioso-ai"
}

variable "github_repository_name" {
  description = "GitHub repository allowed to federate with this environment."
  type        = string
  default     = "radioso"
}

variable "github_actions_workload_identity_pool_id" {
  description = "Workload Identity Pool ID used by GitHub Actions OIDC."
  type        = string
  default     = "github-actions"
}

variable "github_actions_workload_identity_provider_id" {
  description = "Workload Identity Pool provider ID used by GitHub Actions OIDC."
  type        = string
  default     = "github-actions"
}

variable "runtime_deployer_project_roles" {
  description = "Project-scoped roles retained by routine Terraform after foundation administration is removed."
  type        = set(string)
}
