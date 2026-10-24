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

  # Every entry about a resource in this region, so this must be the project's only environment in
  # it. Cloud Run services and jobs, Cloud Scheduler jobs and Cloud Tasks queues label an entry with
  # the region it ran in. Cloud SQL labels it with a coarse `europe` or `us-central`, so instances
  # are matched by the routine root's name, `<prefix>-db`, plus any suffix a restore or clone adds;
  # anchoring on `-db` keeps live's filter off live-eu's instance.
  regional_log_filter = join(" OR ", [
    "resource.labels.location=\"${var.region}\"",
    "resource.labels.database_id=~\"^${var.project_id}:${local.resource_name_prefix}-db(-|$)\"",
  ])

  # Admin-activity, system-event and access-transparency audit entries are stored in `_Required`,
  # which no sink can move, so the sink skips a second, billed copy of them.
  regional_sink_filter = "(${local.regional_log_filter}) AND NOT LOG_ID(\"cloudaudit.googleapis.com/activity\") AND NOT LOG_ID(\"cloudaudit.googleapis.com/system_event\") AND NOT LOG_ID(\"cloudaudit.googleapis.com/access_transparency\")"
}

resource "google_logging_project_bucket_config" "regional" {
  count = var.regional_log_bucket_enabled ? 1 : 0

  project        = var.project_id
  location       = var.region
  bucket_id      = local.regional_log_bucket_id
  description    = "Log entries about the ${var.environment} environment's resources in ${var.region}."
  retention_days = 30
}

resource "google_logging_project_sink" "regional" {
  count = var.regional_log_bucket_enabled ? 1 : 0

  project     = var.project_id
  name        = local.regional_log_bucket_id
  description = "Routes entries about resources in ${var.region}, the ${var.environment} environment's region, to its bucket there."
  filter      = local.regional_sink_filter

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
  description = "Keeps entries about resources in ${var.region} out of _Default; the ${var.environment} environment's bucket there stores them."
  filter      = local.regional_log_filter

  depends_on = [google_logging_project_sink.regional]
}
