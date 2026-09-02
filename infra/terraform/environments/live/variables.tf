variable "project_id" {
  description = "GCP project ID for the live deployment."
  type        = string
  default     = "radioso-494120"
}

variable "environment" {
  description = "Environment name used for resource naming and runtime config."
  type        = string
  default     = "live"
}

variable "region" {
  description = "GCP region for the live deployment."
  type        = string
  default     = "us-central1"
}

variable "deploy_services" {
  description = "Whether to create the Cloud Run services after shared infrastructure exists."
  type        = bool
  default     = true
}

variable "backend_public_invocation_enabled" {
  description = "Whether the independent US backend accepts unauthenticated requests through api-us.radioso.ai."
  type        = bool
  default     = true
}

variable "backend_image" {
  description = "Full backend image URL for live."
  type        = string
  default     = null
}

variable "frontend_image" {
  description = "Full frontend image URL for live."
  type        = string
  default     = null
}

variable "radioso_edition" {
  description = "Radioso edition deployed to live."
  type        = string
  default     = "enterprise"
}

variable "backend_max_instances" {
  description = "Maximum backend Cloud Run instances for live."
  type        = number
  default     = 2
}

variable "frontend_max_instances" {
  description = "Maximum frontend Cloud Run instances for live."
  type        = number
  default     = 2
}

variable "worker_max_instances" {
  description = "Maximum worker Cloud Run instances for live."
  type        = number
  default     = 5
}

variable "db_tier" {
  description = "Cloud SQL tier for live."
  type        = string
  default     = "db-f1-micro"
}

variable "worker_task_max_dispatches_per_second" {
  description = "Cloud Tasks dispatch rate for live document jobs."
  type        = number
  default     = 10
}

variable "worker_task_max_concurrent_dispatches" {
  description = "Maximum concurrent Cloud Tasks dispatches for live document jobs."
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

variable "document_worker_recovery_schedule" {
  description = "Optional override for live document worker recovery. Null uses the root module default."
  type        = string
  default     = null
}

variable "crawler_worker_recovery_schedule" {
  description = "Optional override for live crawler worker recovery. Null uses the root module default."
  type        = string
  default     = null
}

variable "document_storage_bucket_name" {
  description = "Optional override for the live document bucket."
  type        = string
  default     = null
}

variable "document_upload_max_bytes" {
  description = "Maximum uploaded document size in bytes."
  type        = number
  default     = 10485760
}

variable "openai_api_key" {
  description = "OpenAI API key for live."
  type        = string
  sensitive   = true
}

variable "session_cookie_secret" {
  description = "Session signing secret for live."
  type        = string
  sensitive   = true
}

variable "workspace_token_secret" {
  description = "Workspace token secret for live."
  type        = string
  sensitive   = true
}

variable "public_chat_session_secret" {
  description = "Public chat session signing secret for live."
  type        = string
  sensitive   = true
}

variable "connector_encryption_key" {
  description = "Connector encryption key for live."
  type        = string
  sensitive   = true
}

variable "ee_usage_admin_token" {
  description = "Bearer token for live Enterprise admin and operator-console bootstrap endpoints."
  type        = string
  default     = null
  sensitive   = true
}

variable "resend_mail_api_key" {
  description = "Resend API key for Enterprise auth mail in live."
  type        = string
  sensitive   = true
  default     = null
}

variable "slack_oauth_client_id" {
  description = "Slack app OAuth client ID for the Slack channel in live."
  type        = string
  sensitive   = true
  default     = null
}

variable "slack_oauth_client_secret" {
  description = "Slack app OAuth client secret for the Slack channel in live."
  type        = string
  sensitive   = true
  default     = null
}

variable "slack_signing_secret" {
  description = "Slack app signing secret for inbound Slack event verification in live."
  type        = string
  sensitive   = true
  default     = null
}

variable "mail_from_email" {
  description = "Verified sender email address for Enterprise auth mail in live."
  type        = string
  default     = null
}

variable "mail_from_name" {
  description = "Sender display name for auth mail in live."
  type        = string
  default     = "Radioso"
}

variable "metrics_auth_token" {
  description = "Optional metrics auth token for live."
  type        = string
  sensitive   = true
  default     = null
}

variable "product_analytics_sinks" {
  description = "Comma-separated product analytics sink list for live."
  type        = string
  default     = "audit,posthog"
}

variable "error_sinks" {
  description = "Comma-separated error sink list for live."
  type        = string
  default     = "audit,posthog"
}

variable "posthog_api_key" {
  description = "PostHog project token for live error reporting."
  type        = string
  sensitive   = true
}

variable "posthog_host" {
  description = "PostHog ingestion host for live error reporting."
  type        = string
  default     = "https://us.i.posthog.com"
}

variable "otel_logs_enabled" {
  description = "Whether live backend services export structured logs to PostHog through OTLP."
  type        = bool
  default     = false
}

variable "otel_logs_min_level" {
  description = "Minimum live backend log level exported through OpenTelemetry logs."
  type        = string
  default     = "info"
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
  description = "Whether to expose the backend metrics endpoint in live."
  type        = bool
  default     = false
}

variable "connector_public_base_url" {
  description = "Optional connector callback base URL."
  type        = string
  default     = null
}

variable "radioso_mcp_enabled" {
  description = "Whether to deploy standalone MCP in live."
  type        = bool
  default     = false
}

variable "frontend_backend_internal_url_override" {
  description = "Optional backend URL override for the US frontend. Null uses the backend from the same US stack."
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

variable "copilot_probe_budget_per_turn" {
  description = "Replayed turns one Ray turn may spend on verification in production. Kept in step with the root module default."
  type        = number
  default     = 6
}

variable "copilot_conversation_retention_days" {
  description = "Days a Ray conversation is kept after its last activity in production; 0 keeps them indefinitely. Kept in step with the root module default."
  type        = number
  default     = 90
}

variable "copilot_retention_schedule" {
  description = "Optional override for the production Ray retention sweep schedule. Null uses the root module default."
  type        = string
  default     = null
}
