variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "environment" {
  description = "Deployment environment name used in resource naming and runtime configuration."
  type        = string

  validation {
    condition     = contains(["staging", "live", "live-eu"], var.environment)
    error_message = "environment must be staging, live, or live-eu."
  }
}

variable "manage_project_services" {
  description = "Whether this stack owns the project-wide Google API enablement resources. Disable for additional regional stacks in a project whose primary Terraform state already manages APIs."
  type        = bool
  default     = true
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

variable "backend_public_invocation_enabled" {
  description = "Whether to grant unauthenticated Cloud Run invocation on the backend service."
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

variable "secret_replication_locations" {
  description = "Locations used for Secret Manager user-managed replication. Leave empty for automatic replication."
  type        = set(string)
  default     = []

  validation {
    condition     = alltrue([for location in var.secret_replication_locations : length(trimspace(location)) > 0])
    error_message = "secret_replication_locations cannot contain empty location names."
  }
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

variable "frontend_cdn_domain" {
  description = "Domain to serve the frontend behind an external HTTPS load balancer with Cloud CDN for the website-embed assets (e.g. \"radioso.ai\"). Leave empty to keep serving Cloud Run directly with no load balancer or CDN."
  type        = string
  default     = ""
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
  description = "Deprecated fallback cron schedule for both worker recovery jobs. Prefer document_worker_recovery_schedule and crawler_worker_recovery_schedule."
  type        = string
  default     = null
}

variable "document_worker_recovery_schedule" {
  description = "Optional cron schedule for bounded document worker recovery requests that process jobs missed by Cloud Tasks dispatch."
  type        = string
  default     = null
}

variable "crawler_worker_recovery_schedule" {
  description = "Optional cron schedule for bounded crawler worker recovery requests. Crawls are Cloud Tasks driven, so this can usually be much less frequent than document recovery."
  type        = string
  default     = null
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

# --- Conversation-action outbox drain (routine_action_requests) ---
# Pushed per action-emitting turn from the backend, drained on the same worker task
# Cloud Run service that handles document-processing pushes; the recovery sweep below
# is the safety net for pushes that were never sent or were lost.

variable "action_dispatch_task_queue_name" {
  description = "Cloud Tasks queue name used to push conversation-action outbox drain requests."
  type        = string
  default     = "radioso-conversation-actions"
}

variable "action_dispatch_task_max_dispatches_per_second" {
  description = "Cloud Tasks dispatch rate for conversation-action drain pushes."
  type        = number
  default     = 10
}

variable "action_dispatch_task_max_concurrent_dispatches" {
  description = "Maximum concurrent Cloud Tasks dispatches for conversation-action drain pushes."
  type        = number
  default     = 20
}

variable "action_dispatch_recovery_schedule" {
  description = "Optional cron schedule for the conversation-action outbox recovery sweep, covering drain pushes that were never sent or were lost. Defaults tighter than document recovery: a stuck outbox silently drops customer-facing leads (e.g. contact requests) rather than just delaying document indexing."
  type        = string
  default     = null
}

variable "action_dispatch_recovery_max_jobs" {
  description = "Maximum drain batches each scheduled action-dispatch recovery request may process. A batch is up to the worker's configured action-dispatch batch size (rows), not a single row."
  type        = number
  default     = 10

  validation {
    condition     = var.action_dispatch_recovery_max_jobs >= 1 && var.action_dispatch_recovery_max_jobs <= 50
    error_message = "action_dispatch_recovery_max_jobs must be between 1 and 50."
  }
}

variable "copilot_probe_budget_per_turn" {
  description = "Replayed turns one Ray turn may spend across its verification tools. A suite run is charged one per case, so this is a ceiling on model-backed work per turn rather than on tool calls."
  type        = number
  default     = 6

  # Whole numbers only. Terraform's number type accepts 1.5 happily; the backend parses this env
  # var as an integer and refuses to start, so a fractional value turns a config typo into a boot
  # failure rather than a plan error.
  validation {
    condition     = var.copilot_probe_budget_per_turn >= 1 && floor(var.copilot_probe_budget_per_turn) == var.copilot_probe_budget_per_turn
    error_message = "copilot_probe_budget_per_turn must be a whole number of at least 1."
  }
}

variable "copilot_conversation_retention_days" {
  description = "Days a Ray conversation is kept after its last activity before the worker sweep removes it, along with its messages and proposals. 0 keeps conversations indefinitely."
  type        = number
  default     = 90

  # Whole numbers only, for the same reason the probe budget is: the worker parses this as an
  # integer at startup.
  validation {
    condition     = var.copilot_conversation_retention_days >= 0 && floor(var.copilot_conversation_retention_days) == var.copilot_conversation_retention_days
    error_message = "copilot_conversation_retention_days must be a whole number of zero or greater."
  }
}

variable "copilot_retention_schedule" {
  description = "Optional cron schedule for the Ray conversation retention sweep. The worker enforces COPILOT_CONVERSATION_RETENTION_DAYS only when this sweep runs, so a deployment without it keeps copilot conversations forever."
  type        = string
  default     = null
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

variable "slack_oauth_client_id" {
  description = "Optional Slack app OAuth client ID for the Slack channel. Enables the backend Slack install flow when set."
  type        = string
  sensitive   = true
  default     = null
}

variable "slack_oauth_client_secret" {
  description = "Optional Slack app OAuth client secret for the Slack channel."
  type        = string
  sensitive   = true
  default     = null
}

variable "slack_signing_secret" {
  description = "Optional Slack app signing secret used to verify inbound Slack event requests."
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

variable "otel_logs_enabled" {
  description = "Whether backend Cloud Run services export structured logs to the OTLP logs endpoint."
  type        = bool
  default     = false
}

variable "otel_logs_endpoint" {
  description = "Optional OTLP HTTP logs endpoint. Defaults to <posthog_host>/i/v1/logs when logs are enabled for the PostHog sink."
  type        = string
  default     = null
}

variable "otel_logs_min_level" {
  description = "Minimum backend log level exported through OpenTelemetry logs."
  type        = string
  default     = "info"

  validation {
    condition     = contains(["trace", "debug", "info", "warn", "error", "fatal"], var.otel_logs_min_level)
    error_message = "otel_logs_min_level must be one of trace, debug, info, warn, error, or fatal."
  }
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

variable "staff_session_ttl_hours" {
  description = "Enterprise operator console staff session TTL in hours"
  type        = number
  default     = 8
}

variable "ee_usage_admin_token" {
  description = "Bearer token for the Enterprise usage-limits admin API and operator-console owner bootstrap. Leave unset to disable those break-glass endpoints."
  type        = string
  default     = null
  sensitive   = true
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
  description = "Whether Terraform should deploy the standalone public MCP Cloud Run service."
  type        = bool
  default     = false
}

variable "frontend_backend_internal_url_override" {
  description = "Optional backend URL used by the frontend server-side proxy. Defaults to the backend service in this stack."
  type        = string
  default     = null

  validation {
    condition = (
      var.frontend_backend_internal_url_override == null ||
      can(regex("^https://", var.frontend_backend_internal_url_override))
    )
    error_message = "frontend_backend_internal_url_override must be an HTTPS URL when set."
  }
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
  description = "Override for the document worker HTTPS endpoint used by Cloud Tasks. Supply a pre-routed stable endpoint during bootstrap; established workflows can use the discovered worker run.app URL. The crawler worker URL is discovered automatically and needs no override."
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
  description = "Addresses that receive alert notifications. One Cloud Monitoring email channel is created per address."
  type        = list(string)
  default     = []
}

variable "monitoring_extra_notification_channel_ids" {
  description = "Full IDs of notification channels created outside Terraform, such as a Slack channel whose OAuth token should not live in state. Format: projects/<project>/notificationChannels/<id>."
  type        = list(string)
  default     = []
}

variable "monitoring_uptime_host" {
  description = "Hostname the backend uptime check probes. Defaults to this stack's own Cloud Run backend host, which isolates the alert to one region."
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

  validation {
    condition     = var.monitoring_cloudsql_memory_threshold > 0 && var.monitoring_cloudsql_memory_threshold <= 1
    error_message = "monitoring_cloudsql_memory_threshold is a utilization ratio between 0 and 1."
  }
}

variable "monitoring_cloudsql_cpu_threshold" {
  description = "Cloud SQL CPU utilization ratio that triggers the saturation alert."
  type        = number
  default     = 0.9

  validation {
    condition     = var.monitoring_cloudsql_cpu_threshold > 0 && var.monitoring_cloudsql_cpu_threshold <= 1
    error_message = "monitoring_cloudsql_cpu_threshold is a utilization ratio between 0 and 1."
  }
}

variable "monitoring_cloudsql_disk_threshold" {
  description = "Cloud SQL disk utilization ratio that triggers the saturation alert."
  type        = number
  default     = 0.85

  validation {
    condition     = var.monitoring_cloudsql_disk_threshold > 0 && var.monitoring_cloudsql_disk_threshold <= 1
    error_message = "monitoring_cloudsql_disk_threshold is a utilization ratio between 0 and 1."
  }
}

variable "monitoring_queue_depth_threshold" {
  description = "Cloud Tasks queue depth held for fifteen minutes that triggers the backlog alert."
  type        = number
  default     = 100
}

variable "monitoring_scheduler_failure_threshold" {
  description = "Non-success Cloud Scheduler attempts in fifteen minutes that trigger the scheduler alert."
  type        = number
  default     = 0
}

variable "container_health_probes_enabled" {
  description = "Whether the backend and MCP Cloud Run services probe their health routes for startup and liveness. Enabling this makes a revision that boots but cannot serve fail its rollout instead of receiving traffic."
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
  description = "Shared secret the ops event feed signs each delivery with. Required when a sink list includes ops_webhook."
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
  description = "Lowest error severity the ops event feed forwards."
  type        = string
  default     = "error"

  validation {
    condition     = contains(["info", "warn", "error"], var.ops_event_webhook_min_error_severity)
    error_message = "ops_event_webhook_min_error_severity must be info, warn, or error."
  }
}
