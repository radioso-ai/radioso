variable "project_id" {
  description = "GCP project ID for the EU live deployment."
  type        = string
  default     = "radioso-494120"
}

variable "environment" {
  description = "Environment name used for EU resource naming and runtime config."
  type        = string
  default     = "live-eu"
}

variable "region" {
  description = "GCP region for the EU live deployment."
  type        = string
  default     = "europe-west1"
}

variable "deploy_services" {
  description = "Whether to create the Cloud Run services after shared infrastructure exists."
  type        = bool
  default     = true
}

variable "backend_image" {
  description = "Full backend image URL for EU live."
  type        = string
  default     = null
}

variable "frontend_image" {
  description = "Full frontend image URL for EU live."
  type        = string
  default     = null
}

variable "radioso_edition" {
  description = "Radioso edition deployed to EU live."
  type        = string
  default     = "enterprise"
}

variable "backend_max_instances" {
  description = "Maximum backend Cloud Run instances for EU live."
  type        = number
  default     = 2
}

variable "frontend_max_instances" {
  description = "Maximum frontend Cloud Run instances for EU live."
  type        = number
  default     = 2
}

variable "worker_max_instances" {
  description = "Maximum worker Cloud Run instances for EU live."
  type        = number
  default     = 5
}

variable "db_tier" {
  description = "Cloud SQL tier for EU live."
  type        = string
  default     = "db-f1-micro"
}

variable "worker_task_max_dispatches_per_second" {
  description = "Cloud Tasks dispatch rate for EU live document jobs."
  type        = number
  default     = 10
}

variable "worker_task_max_concurrent_dispatches" {
  description = "Maximum concurrent Cloud Tasks dispatches for EU live document jobs."
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
  description = "Optional override for EU live document worker recovery. Null uses the root module default."
  type        = string
  default     = null
}

variable "crawler_worker_recovery_schedule" {
  description = "Optional override for EU live crawler worker recovery. Null uses the root module default."
  type        = string
  default     = null
}

variable "document_storage_bucket_name" {
  description = "Optional override for the EU live document bucket."
  type        = string
  default     = null
}

variable "document_upload_max_bytes" {
  description = "Maximum uploaded document size in bytes."
  type        = number
  default     = 10485760
}

variable "openai_api_key" {
  description = "OpenAI API key for EU live."
  type        = string
  sensitive   = true
}

variable "session_cookie_secret" {
  description = "Session signing secret for EU live."
  type        = string
  sensitive   = true
}

variable "workspace_token_secret" {
  description = "Workspace token secret for EU live."
  type        = string
  sensitive   = true
}

variable "public_chat_session_secret" {
  description = "Public chat session signing secret for EU live."
  type        = string
  sensitive   = true
}

variable "connector_encryption_key" {
  description = "Connector encryption key for EU live."
  type        = string
  sensitive   = true
}

variable "ee_usage_admin_token" {
  description = "Bearer token for EU live Enterprise admin and operator-console bootstrap endpoints."
  type        = string
  default     = null
  sensitive   = true
}

variable "resend_mail_api_key" {
  description = "Resend API key for Enterprise auth mail in EU live."
  type        = string
  sensitive   = true
  default     = null
}

variable "slack_oauth_client_id" {
  description = "Slack app OAuth client ID for the Slack channel in EU live."
  type        = string
  sensitive   = true
  default     = null
}

variable "slack_oauth_client_secret" {
  description = "Slack app OAuth client secret for the Slack channel in EU live."
  type        = string
  sensitive   = true
  default     = null
}

variable "slack_signing_secret" {
  description = "Slack app signing secret for inbound Slack event verification in EU live."
  type        = string
  sensitive   = true
  default     = null
}

variable "mail_from_email" {
  description = "Verified sender email address for Enterprise auth mail in EU live."
  type        = string
  default     = null
}

variable "mail_from_name" {
  description = "Sender display name for auth mail in EU live."
  type        = string
  default     = "Radioso"
}

variable "metrics_auth_token" {
  description = "Optional metrics auth token for EU live."
  type        = string
  sensitive   = true
  default     = null
}

variable "product_analytics_sinks" {
  description = "Comma-separated product analytics sink list for EU live."
  type        = string
  default     = "audit,posthog"
}

variable "error_sinks" {
  description = "Comma-separated error sink list for EU live."
  type        = string
  default     = "audit,posthog"
}

variable "posthog_api_key" {
  description = "PostHog project token for EU live error reporting."
  type        = string
  sensitive   = true
}

variable "posthog_host" {
  description = "PostHog EU ingestion host for EU live error reporting."
  type        = string
  default     = "https://eu.i.posthog.com"
}

variable "otel_logs_enabled" {
  description = "Whether EU live backend services export structured logs to PostHog through OTLP."
  type        = bool
  default     = true
}

variable "otel_logs_min_level" {
  description = "Minimum EU live backend log level exported through OpenTelemetry logs."
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
  description = "Whether to expose the backend metrics endpoint in EU live."
  type        = bool
  default     = false
}

variable "connector_public_base_url" {
  description = "Optional connector callback base URL."
  type        = string
  default     = null
}

variable "radioso_mcp_enabled" {
  description = "Whether to deploy standalone MCP in EU live."
  type        = bool
  default     = false
}

variable "operator_mcp_enabled" {
  description = "Whether to enable the separately authorized Operator MCP surface in EU live."
  type        = bool
  default     = false
}

variable "operator_mcp_public_origin" {
  description = "Canonical HTTPS origin for Operator MCP in EU live."
  type        = string
  default     = null
}

variable "operator_mcp_credential_epoch" {
  description = "Externally monotonic Operator MCP credential generation in EU live."
  type        = string
  default     = "1"
}

variable "operator_mcp_rollout_workspace_ids" {
  description = "Workspace UUIDs permitted to use Operator MCP in EU live. Empty keeps the surface unavailable."
  type        = list(string)
  default     = []
}

variable "operator_mcp_verification_budget_per_minute" {
  description = "Per-credential Operator MCP verification budget in EU live."
  type        = number
  default     = 6
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
  description = "Optional override for the EU worker service public URL."
  type        = string
  default     = null
}

variable "copilot_probe_budget_per_turn" {
  description = "Replayed turns one Ray turn may spend on verification in EU production. Kept in step with the root module default."
  type        = number
  default     = 6
}

variable "copilot_conversation_retention_days" {
  description = "Days a Ray conversation is kept after its last activity in EU production; 0 keeps them indefinitely. Kept in step with the root module default."
  type        = number
  default     = 90
}

variable "copilot_retention_schedule" {
  description = "Optional override for the EU production Ray retention sweep schedule. Null uses the root module default."
  type        = string
  default     = null
}

# --- Monitoring and alerting ---

variable "monitoring_enabled" {
  description = "Whether this stack creates Cloud Monitoring alert policies, the backend uptime check, and the application error log metric."
  type        = bool
  default     = false
}

variable "monitoring_notification_emails" {
  description = "Addresses that receive alert notifications."
  type        = list(string)
  default     = []
}

variable "monitoring_extra_notification_channel_ids" {
  description = "Full IDs of notification channels created outside Terraform, such as a Slack channel whose OAuth token should not live in state."
  type        = list(string)
  default     = []
}

variable "monitoring_uptime_host" {
  description = "Hostname the backend uptime check probes. Defaults to this stack's own Cloud Run backend host."
  type        = string
  default     = null
}

variable "monitoring_server_error_rate_threshold" {
  description = "Cloud Run 5xx responses per second, averaged over five minutes, that trigger the server-error alert."
  type        = number
  default     = 0.1
}

variable "monitoring_backend_latency_p95_ms" {
  description = "Backend p95 request latency in milliseconds that triggers the latency alert."
  type        = number
  default     = 5000
}

variable "monitoring_error_log_threshold" {
  description = "Error-level log lines from one service in five minutes that trigger the application error alert."
  type        = number
  default     = 10
}

variable "monitoring_cloudsql_memory_threshold" {
  description = "Cloud SQL memory utilization ratio that triggers the saturation alert."
  type        = number
  default     = 0.9
}

variable "monitoring_cloudsql_cpu_threshold" {
  description = "Cloud SQL CPU utilization ratio that triggers the saturation alert."
  type        = number
  default     = 0.9
}

variable "monitoring_cloudsql_disk_threshold" {
  description = "Cloud SQL disk utilization ratio that triggers the saturation alert."
  type        = number
  default     = 0.85
}

variable "monitoring_queue_depth_threshold" {
  description = "Cloud Tasks queue depth held for fifteen minutes that triggers the backlog alert."
  type        = number
  default     = 100
}

variable "monitoring_scheduler_failure_threshold" {
  description = "Error-level Cloud Scheduler execution logs in fifteen minutes that trigger the scheduler alert."
  type        = number
  default     = 0
}

variable "container_health_probes_enabled" {
  description = "Whether the backend and MCP Cloud Run services probe their health routes for startup and liveness."
  type        = bool
  default     = false
}

# --- Ops event feed ---

variable "ops_event_webhook_url" {
  description = "Destination for the ops event feed. Required when a sink list includes ops_webhook."
  type        = string
  default     = null
}

variable "ops_event_webhook_secret" {
  description = "Shared secret the ops event feed signs each delivery with."
  type        = string
  sensitive   = true
  default     = null
}

variable "ops_event_webhook_events" {
  description = "Comma-separated product analytics event names to forward. Every event is forwarded when unset."
  type        = string
  default     = null
}

variable "ops_event_webhook_min_error_severity" {
  description = "Lowest error severity the ops event feed forwards: info, warn, or error."
  type        = string
  default     = "error"
}

variable "ops_event_webhook_queue_limit" {
  description = "Bounded in-memory ops event queue depth before the oldest events are dropped."
  type        = number
  default     = 500
}
