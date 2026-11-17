# Engineer database access: the db-support identity may sign in to Cloud SQL with IAM, and the
# record of what it ran is kept for 12 months in the environment's region. The routine root adds
# the database user, the pgAudit flag and the job that runs queries (../db_support_access.tf).
#
# This lives in the foundation because it grants a project role, changes the project's audit
# configuration and adds a sink, none of which the Terraform workflow's identity can do.
locals {
  db_access_audit_bucket_id = "${local.resource_name_prefix}-db-access"

  # pgAudit records arrive as Cloud SQL Data Access audit entries, as do IAM sign-ins to the
  # instance. The instance is matched as in the regional log filter (logging.tf).
  db_access_audit_filter = join(" AND ", [
    "LOG_ID(\"cloudaudit.googleapis.com/data_access\")",
    "resource.type=\"cloudsql_database\"",
    "resource.labels.database_id=~\"^${var.project_id}:${local.resource_name_prefix}-db(-|$)\"",
  ])
}

# Signing in to a Cloud SQL instance with IAM. The account can only reach an instance that has a
# database user for it, which only its own environment's instance does.
resource "google_project_iam_member" "db_support_cloudsql_login" {
  project = var.project_id
  role    = "roles/cloudsql.instanceUser"
  member  = google_service_account.runtime["db_support"].member
}

# Cloud SQL writes pgAudit records only as Data Access audit entries, which are off by default.
# The setting is project-wide, so the environment that owns the project's services owns it too.
resource "google_project_iam_audit_config" "cloudsql" {
  count = var.manage_project_services ? 1 : 0

  project = var.project_id
  service = "cloudsql.googleapis.com"

  audit_log_config {
    log_type = "DATA_READ"
  }
  audit_log_config {
    log_type = "DATA_WRITE"
  }
}

resource "google_logging_project_bucket_config" "db_access_audit" {
  project        = var.project_id
  location       = var.region
  bucket_id      = local.db_access_audit_bucket_id
  description    = "Audit records of engineer access to the ${var.environment} environment's database, kept 12 months."
  retention_days = 365
}

resource "google_logging_project_sink" "db_access_audit" {
  project     = var.project_id
  name        = local.db_access_audit_bucket_id
  description = "Routes the ${var.environment} database's pgAudit records and IAM sign-ins to their 12-month bucket."
  filter      = local.db_access_audit_filter

  # A sink writing to a bucket in its own project is authorized without an IAM grant.
  destination = "logging.googleapis.com/${google_logging_project_bucket_config.db_access_audit.id}"
}
