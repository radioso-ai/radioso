variable "project_id" {
  description = "GCP project ID"
  type        = string
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

variable "website_embed_secret" {
  description = "Website embed request/session signing secret"
  type        = string
  sensitive   = true
}

variable "connector_encryption_key" {
  description = "Connector secret encryption key (32 bytes, base64-encoded)"
  type        = string
  sensitive   = true
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

variable "connector_public_base_url" {
  description = "Optional public base URL used by connector callbacks. Set this to the backend public URL or custom domain after the service exists."
  type        = string
  default     = null
}

variable "public_chat_base_url" {
  description = "Optional public base URL used when generating public chat links."
  type        = string
  default     = null
}
