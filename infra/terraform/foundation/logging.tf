# An environment that shares its project with another stack can keep its own log entries in its
# own region. The project's `_Default` bucket is in `global` and its location can't change, so
# this adds a bucket in the environment's region, a sink that routes the environment's entries to
# it, and an exclusion that stops `_Default` from storing a second copy.
#
# Routing lives here rather than in the routine root because a sink can send every log line out
# of the project and an exclusion can drop them, and the Terraform workflow's identity holds
# neither permission.
locals {
  regional_log_bucket_id = "${local.resource_name_prefix}-logs"

  # Cloud Run services and jobs, Cloud Scheduler jobs and Cloud Tasks queues label an entry with
  # the region it ran in. Cloud SQL labels it with a coarse `europe` or `us-central`, so instances
  # are matched by the environment's name prefix, which also covers a restored or cloned instance.
  regional_log_filter = join(" OR ", [
    "resource.labels.location=\"${var.region}\"",
    "resource.labels.database_id=~\"^${var.project_id}:${local.resource_name_prefix}-\"",
  ])
}

resource "google_logging_project_bucket_config" "regional" {
  count = var.regional_log_bucket_enabled ? 1 : 0

  project        = var.project_id
  location       = var.region
  bucket_id      = local.regional_log_bucket_id
  description    = "Log entries of the ${var.environment} environment, kept in ${var.region}."
  retention_days = 30
}

resource "google_logging_project_sink" "regional" {
  count = var.regional_log_bucket_enabled ? 1 : 0

  project     = var.project_id
  name        = local.regional_log_bucket_id
  description = "Routes the ${var.environment} environment's log entries to its ${var.region} bucket."
  filter      = local.regional_log_filter

  # A sink writing to a bucket in its own project is authorized without an IAM grant.
  destination = "logging.googleapis.com/${google_logging_project_bucket_config.regional[0].id}"
}

# Terraform creates the exclusion after the sink and destroys it first. Google takes a few minutes
# to apply either change, so the README's two-step apply checks the sink delivers before the
# exclusion goes on.
resource "google_logging_project_exclusion" "regional_from_default" {
  count = var.regional_log_bucket_enabled ? 1 : 0

  project     = var.project_id
  name        = local.regional_log_bucket_id
  description = "Keeps the ${var.environment} environment's entries out of _Default; they are stored in ${var.region}."
  filter      = local.regional_log_filter

  depends_on = [google_logging_project_sink.regional]
}
