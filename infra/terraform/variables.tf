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
  description = "Minimum number of worker Cloud Run instances (0 = scale to zero). Set above 0 only when the polling fallback must stay warm continuously."
  type        = number
  default     = 0

  validation {
    condition     = var.worker_min_instances >= 0
    error_message = "worker_min_instances must be 0 or greater."
  }
}

variable "worker_max_instances" {
  description = "Maximum number of worker Cloud Run instances"
  type        = number
  default     = 5
}

variable "crawler_worker_min_instances" {
  description = "Minimum number of crawler worker Cloud Run instances (0 = scale to zero). Scheduled recovery handles missed Cloud Tasks dispatches."
  type        = number
  default     = 0

  validation {
    condition     = var.crawler_worker_min_instances >= 0
    error_message = "crawler_worker_min_instances must be 0 or greater."
  }
}

variable "crawler_worker_max_instances" {
  description = "Maximum number of crawler worker Cloud Run instances. Crawls are network-bound and can run in parallel without contending with embedding workloads."
  type        = number
  default     = 3
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

variable "worker_crawl_task_queue_name" {
  description = "Cloud Tasks queue name used to dispatch website crawl jobs."
  type        = string
  default     = "radioso-website-crawls"
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

variable "worker_crawl_task_max_dispatches_per_second" {
  description = "Cloud Tasks dispatch rate for website crawl jobs."
  type        = number
  default     = 1
}

variable "worker_crawl_task_max_concurrent_dispatches" {
  description = "Maximum concurrent Cloud Tasks dispatches for website crawl jobs."
  type        = number
  default     = 5
}

variable "document_processing_job_lease_ms" {
  description = "Lease duration for an in-flight document-processing job before a later delivery may reclaim it."
  type        = number
  default     = 300000
}

variable "website_crawl_job_lease_ms" {
  description = "Lease duration for an in-flight website crawl job before a later delivery may reclaim it."
  type        = number
  default     = 900000
}

variable "worker_recovery_schedule" {
  description = "Cron schedule for bounded worker recovery requests that process jobs missed by Cloud Tasks dispatch."
  type        = string
  default     = "*/15 * * * *"
}

variable "worker_recovery_max_jobs" {
  description = "Maximum jobs each scheduled worker recovery request may process."
  type        = number
  default     = 5

  validation {
    condition     = var.worker_recovery_max_jobs >= 1 && var.worker_recovery_max_jobs <= 50
    error_message = "worker_recovery_max_jobs must be between 1 and 50."
  }
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

variable "radioso_mcp_signing_secret" {
  description = "Signing secret used by the hosted MCP HTTP session layer."
  type        = string
  sensitive   = true
  default     = null
}

variable "connector_encryption_key" {
  description = "Connector secret encryption key (32 bytes, base64-encoded)"
  type        = string
  sensitive   = true
}

variable "resend_mail_api_key" {
  description = "Resend API key used by transactional auth mail."
  type        = string
  sensitive   = true
  default     = null
}

variable "mail_from_email" {
  description = "Verified sender email address for transactional auth mail."
  type        = string
  default     = null
}

variable "mail_from_name" {
  description = "Sender display name for transactional auth mail."
  type        = string
  default     = "Radioso"
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

variable "posthog_api_key" {
  description = "Optional PostHog project token used by Enterprise observability sinks."
  type        = string
  sensitive   = true
  default     = null
}

# --- Backend env vars (non-secret) ---

variable "product_analytics_sinks" {
  description = "Comma-separated product analytics sink list passed to the backend runtime."
  type        = string
  default     = "audit"
}

variable "error_sinks" {
  description = "Comma-separated error sink list passed to the backend runtime."
  type        = string
  default     = "audit"
}

variable "posthog_host" {
  description = "Optional PostHog ingestion host used by Enterprise observability sinks."
  type        = string
  default     = null
}

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

variable "radioso_mcp_enabled" {
  description = "Whether Terraform should expose the backend-hosted MCP route. When enabled, MCP is mounted in the backend rather than as a standalone service."
  type        = bool
  default     = false
}

variable "radioso_mcp_base_url_override" {
  description = "Optional public backend base URL used by the hosted MCP runtime when it calls Radioso APIs. Defaults to connector_public_base_url when set."
  type        = string
  default     = null
}

variable "app_base_url_override" {
  description = "Optional override for the main public Radioso app URL. Required for Enterprise so backend-generated auth links use a real frontend URL."
  type        = string
  default     = null

  validation {
    condition = (
      var.radioso_edition != "enterprise" ||
      (
        var.app_base_url_override != null &&
        length(trimspace(var.app_base_url_override)) > 0
      )
    )
    error_message = "app_base_url_override must be set when radioso_edition is enterprise."
  }
}

variable "public_chat_base_url_override" {
  description = "Optional override for the public chat base URL. Defaults to app_base_url_override + /chat when that override is set."
  type        = string
  default     = null
}

variable "worker_tasks_service_url_override" {
  description = "Optional override for the document worker Cloud Run public URL. Set this after the first deploy so retry dispatches target the worker run.app URL. The crawler worker URL is discovered automatically and needs no override."
  type        = string
  default     = null
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
