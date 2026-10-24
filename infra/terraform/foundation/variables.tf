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
  description = "Region of the environment's runtime resources, including its Artifact Registry repository."
  type        = string
}

variable "terraform_state_bucket_name" {
  description = "Existing GCS bucket that stores this environment's routine Terraform state."
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

variable "manage_project_services" {
  description = "Whether this environment's stacks own the project-wide API enablement and the _Default log bucket. Disable for an additional regional environment in a project whose primary environment already owns them."
  type        = bool
  default     = true
}

variable "regional_log_bucket_enabled" {
  description = "Whether this environment's log entries are stored in a log bucket in its own region instead of the project's global _Default bucket. Enable for an environment that promises regional residency."
  type        = bool
  default     = false
}

variable "docs_deployer_enabled" {
  description = "Whether this environment hosts the docs portal on Firebase Hosting, which adds the docs deploy identity."
  type        = bool
  default     = false
}
