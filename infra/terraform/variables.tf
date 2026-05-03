variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "environment" {
  description = "Deployment environment name used in resource naming and runtime configuration."
  type        = string

  validation {
    condition     = contains(["staging", "live"], var.environment)
    error_message = "environment must be either staging or live."
  }
}

variable "region" {
  description = "GCP region for all resources"
  type        = string
  default     = "us-central1"
}

# --- Container images ---

variable "backend_image" {
  description = "Full image URL for the backend Cloud Run service (e.g. us-central1-docker.pkg.dev/PROJECT/radioso/backend:latest)"
  type        = string
  default     = null

  validation {
    condition     = !var.deploy_services || var.backend_image != null
    error_message = "backend_image must be set when deploy_services is true."
  }
}

variable "frontend_image" {
  description = "Full image URL for the frontend Cloud Run service (e.g. us-central1-docker.pkg.dev/PROJECT/radioso/frontend:latest)"
  type        = string
  default     = null

  validation {
    condition     = !var.deploy_services || var.frontend_image != null
    error_message = "frontend_image must be set when deploy_services is true."
  }
}

variable "deploy_services" {
  description = "Whether to create the backend and frontend Cloud Run services. Set false on the first apply to create shared infrastructure before images exist."
  type        = bool
  default     = true
}

variable "radioso_edition" {
  description = "Radioso edition deployed to Cloud Run. Enterprise enables the hosted website embed module and frontend routes."
  type        = string
  default     = "oss"

  validation {
    condition     = contains(["oss", "enterprise"], var.radioso_edition)
    error_message = "radioso_edition must be either oss or enterprise."
  }
}

variable "worker_min_instances" {
  description = "Minimum number of worker Cloud Run instances. Must stay at least 1 so the durable document queue always has a live recovery poller."
  type        = number
  default     = 1

  validation {
    condition     = var.worker_min_instances >= 1
    error_message = "worker_min_instances must be at least 1 so the worker service can recover queued jobs when Cloud Tasks dispatch fails."
  }
}

variable "worker_max_instances" {
  description = "Maximum number of worker Cloud Run instances"
  type        = number
  default     = 5
}

# --- Database ---

variable "db_tier" {
  description = "Cloud SQL machine tier"
  type        = string
  default     = "db-f1-micro"
}

variable "db_deletion_protection" {
  description = "Enable deletion protection on Cloud SQL instance (disable for dev/staging)"
  type        = bool
  default     = false
}

# --- Cloud Run scaling ---

variable "backend_min_instances" {
  description = "Minimum number of backend Cloud Run instances (0 = scale to zero)"
  type        = number
  default     = 0
}

variable "backend_max_instances" {
  description = "Maximum number of backend Cloud Run instances"
  type        = number
  default     = 2
}

variable "frontend_min_instances" {
  description = "Minimum number of frontend Cloud Run instances (0 = scale to zero)"
  type        = number
  default     = 0
}

variable "frontend_max_instances" {
  description = "Maximum number of frontend Cloud Run instances"
  type        = number
  default     = 2
}

variable "worker_task_queue_name" {
  description = "Cloud Tasks queue name used to dispatch document processing jobs."
  type        = string
  default     = "radioso-document-processing"
}

variable "worker_task_max_dispatches_per_second" {
  description = "Cloud Tasks dispatch rate for document worker jobs."
  type        = number
  default     = 10
}

variable "worker_task_max_concurrent_dispatches" {
  description = "Maximum concurrent Cloud Tasks dispatches for document worker jobs."
  type        = number
  default     = 20
}

variable "document_processing_job_lease_ms" {
  description = "Lease duration for an in-flight document-processing job before a later delivery may reclaim it."
  type        = number
  default     = 300000
}

# --- Document storage ---

variable "document_storage_bucket_name" {
  description = "Optional override for the GCS bucket that stores original uploaded document files."
  type        = string
  default     = null
}

variable "document_upload_max_bytes" {
  description = "Maximum accepted uploaded file size in bytes."
  type        = number
  default     = 10485760
}

# --- Secrets (sensitive) ---

variable "openai_api_key" {
  description = "OpenAI API key"
  type        = string
  sensitive   = true
}

variable "session_cookie_secret" {
  description = "Session cookie signing secret"
  type        = string
  sensitive   = true
}

variable "workspace_token_secret" {
  description = "Workspace API token encryption secret"
  type        = string
  sensitive   = true
}

variable "public_chat_session_secret" {
  description = "Public chat session signing secret"
  type        = string
  sensitive   = true
}

variable "connector_encryption_key" {
  description = "Connector secret encryption key (32 bytes, base64-encoded)"
  type        = string
  sensitive   = true
}

variable "metrics_auth_token" {
  description = "Optional bearer token required to read the Prometheus metrics endpoint when enabled."
  type        = string
  sensitive   = true
  default     = null

  validation {
    condition     = !var.metrics_enabled || var.metrics_auth_token != null
    error_message = "metrics_auth_token must be set when metrics_enabled is true."
  }
}

# --- Backend env vars (non-secret) ---

variable "openai_chat_model" {
  description = "OpenAI chat model name"
  type        = string
  default     = "gpt-5-mini"
}

variable "openai_rerank_model" {
  description = "OpenAI rerank model name"
  type        = string
  default     = "gpt-4.1-mini"
}

variable "openai_vector_model" {
  description = "OpenAI embedding model name"
  type        = string
  default     = "text-embedding-3-small"
}

variable "session_ttl_hours" {
  description = "Session TTL in hours"
  type        = number
  default     = 168
}

variable "auth_skip_email_verification" {
  description = "Whether the deployment should skip email verification before first login."
  type        = bool
  default     = false
}

variable "metrics_enabled" {
  description = "Whether to expose the Prometheus metrics endpoint on the backend service."
  type        = bool
  default     = false
}

variable "connector_public_base_url" {
  description = "Optional public base URL used by connector callbacks. Set this to the backend public URL or custom domain after the service exists."
  type        = string
  default     = null
}

variable "app_base_url_override" {
  description = "Optional override for the main public Radioso app URL. Set this after the first deploy if backend-generated links should use the frontend Cloud Run URL."
  type        = string
  default     = null
}

variable "public_chat_base_url_override" {
  description = "Optional override for the public chat base URL. Defaults to app_base_url_override + /chat when that override is set."
  type        = string
  default     = null
}

variable "worker_tasks_service_url_override" {
  description = "Optional override for the worker Cloud Run public URL. Set this after the first deploy so retry dispatches target the worker run.app URL."
  type        = string
  default     = null
}

variable "mail_driver" {
  description = "Mail delivery driver to expose to the cloud runtimes. Use log until SMTP is configured."
  type        = string
  default     = "log"

  validation {
    condition     = contains(["noop", "log", "smtp"], var.mail_driver)
    error_message = "mail_driver must be one of noop, log, or smtp."
  }
}

variable "mail_from_email" {
  description = "Default from-address for verification and password reset email."
  type        = string
  default     = "noreply@example.com"
}

variable "mail_from_name" {
  description = "Default from-name for verification and password reset email."
  type        = string
  default     = "Radioso"
}

variable "mail_smtp_host" {
  description = "Optional SMTP host for future cloud email delivery."
  type        = string
  default     = null
}

variable "mail_smtp_port" {
  description = "Optional SMTP port for future cloud email delivery."
  type        = number
  default     = 587
}

variable "mail_smtp_secure" {
  description = "Whether future SMTP delivery should use implicit TLS."
  type        = bool
  default     = false
}

variable "mail_smtp_username" {
  description = "Optional SMTP username stored in Secret Manager when email delivery is enabled."
  type        = string
  sensitive   = true
  default     = null
}

variable "mail_smtp_password" {
  description = "Optional SMTP password stored in Secret Manager when email delivery is enabled."
  type        = string
  sensitive   = true
  default     = null

  validation {
    condition = var.mail_driver != "smtp" || (
      var.mail_smtp_host != null &&
      var.mail_smtp_username != null &&
      var.mail_smtp_password != null
    )
    error_message = "mail_smtp_host, mail_smtp_username, and mail_smtp_password must be set when mail_driver is smtp."
  }
}

variable "github_repository_owner" {
  description = "GitHub organization or user that owns the repository allowed to deploy via GitHub Actions."
  type        = string
  default     = "radioso-ai"
}

variable "github_repository_name" {
  description = "GitHub repository name allowed to deploy via GitHub Actions."
  type        = string
  default     = "radioso"
}

variable "github_actions_workload_identity_pool_id" {
  description = "Workload Identity Pool ID used by GitHub Actions OIDC."
  type        = string
  default     = "github-actions"
}

variable "github_actions_workload_identity_provider_id" {
  description = "Workload Identity Pool Provider ID used by GitHub Actions OIDC."
  type        = string
  default     = "github-actions"
}
