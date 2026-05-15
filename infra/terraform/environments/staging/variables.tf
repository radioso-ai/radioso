variable "region" {
  description = "GCP region for the staging deployment."
  type        = string
  default     = "us-central1"
}

variable "deploy_services" {
  description = "Whether to create the Cloud Run services after shared infrastructure exists."
  type        = bool
  default     = true
}

variable "backend_image" {
  description = "Full backend image URL for staging."
  type        = string
  default     = null
}

variable "frontend_image" {
  description = "Full frontend image URL for staging."
  type        = string
  default     = null
}

variable "radioso_edition" {
  description = "Radioso edition deployed to staging."
  type        = string
  default     = "enterprise"
}

variable "backend_max_instances" {
  description = "Maximum backend Cloud Run instances for staging."
  type        = number
  default     = 2
}

variable "frontend_max_instances" {
  description = "Maximum frontend Cloud Run instances for staging."
  type        = number
  default     = 2
}

variable "worker_max_instances" {
  description = "Maximum worker Cloud Run instances for staging."
  type        = number
  default     = 5
}

variable "db_tier" {
  description = "Cloud SQL tier for staging. This is the main cost lever because Cloud SQL does not auto-scale to zero."
  type        = string
  default     = "db-f1-micro"
}

variable "worker_task_max_dispatches_per_second" {
  description = "Cloud Tasks dispatch rate for staging document jobs."
  type        = number
  default     = 10
}

variable "worker_task_max_concurrent_dispatches" {
  description = "Maximum concurrent Cloud Tasks dispatches for staging document jobs."
  type        = number
  default     = 20
}

variable "website_crawl_job_lease_ms" {
  description = "Lease duration for in-flight website crawl jobs."
  type        = number
  default     = 900000
}

variable "document_processing_job_lease_ms" {
  description = "Lease duration for in-flight document jobs."
  type        = number
  default     = 300000
}

variable "document_storage_bucket_name" {
  description = "Optional override for the staging document bucket."
  type        = string
  default     = null
}

variable "document_upload_max_bytes" {
  description = "Maximum uploaded document size in bytes."
  type        = number
  default     = 10485760
}

variable "openai_api_key" {
  description = "OpenAI API key for staging."
  type        = string
  sensitive   = true
}

variable "session_cookie_secret" {
  description = "Session signing secret for staging."
  type        = string
  sensitive   = true
}

variable "workspace_token_secret" {
  description = "Workspace token secret for staging."
  type        = string
  sensitive   = true
}

variable "public_chat_session_secret" {
  description = "Public chat session signing secret for staging."
  type        = string
  sensitive   = true
}

variable "radioso_mcp_signing_secret" {
  description = "MCP session signing secret for staging."
  type        = string
  sensitive   = true
  default     = null
}

variable "connector_encryption_key" {
  description = "Connector encryption key for staging."
  type        = string
  sensitive   = true
}

variable "resend_mail_api_key" {
  description = "Resend API key for Enterprise auth mail in staging."
  type        = string
  sensitive   = true
  default     = null
}

variable "ee_mail_from_email" {
  description = "Verified sender email address for Enterprise auth mail in staging."
  type        = string
  default     = null
}

variable "ee_mail_from_name" {
  description = "Sender display name for Enterprise auth mail in staging."
  type        = string
  default     = "Radioso"
}

variable "metrics_auth_token" {
  description = "Optional metrics auth token for staging."
  type        = string
  sensitive   = true
  default     = null
}

variable "openai_chat_model" {
  description = "OpenAI chat model name."
  type        = string
  default     = "gpt-5.4-mini"
}

variable "openai_rerank_model" {
  description = "OpenAI rerank model name."
  type        = string
  default     = "gpt-5.4-nano"
}

variable "openai_vector_model" {
  description = "OpenAI embedding model name."
  type        = string
  default     = "text-embedding-3-small"
}

variable "session_ttl_hours" {
  description = "Session TTL in hours."
  type        = number
  default     = 168
}

variable "metrics_enabled" {
  description = "Whether to expose the backend metrics endpoint in staging."
  type        = bool
  default     = false
}

variable "connector_public_base_url" {
  description = "Optional connector callback base URL."
  type        = string
  default     = null
}

variable "radioso_mcp_enabled" {
  description = "Whether to expose backend-hosted MCP in staging."
  type        = bool
  default     = false
}

variable "radioso_mcp_base_url_override" {
  description = "Optional backend base URL used by the hosted MCP runtime."
  type        = string
  default     = null
}

variable "app_base_url_override" {
  description = "Optional override for the main public app URL."
  type        = string
  default     = null
}

variable "public_chat_base_url_override" {
  description = "Optional override for the public chat URL."
  type        = string
  default     = null
}

variable "worker_tasks_service_url_override" {
  description = "Optional override for the worker service public URL."
  type        = string
  default     = null
}
