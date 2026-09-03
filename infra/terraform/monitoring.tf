# Alerting that keeps working when Radioso does not.
#
# Every signal here comes from Google Cloud's own metrics and logs, so a hard-down
# backend, a crash-looping revision, or a database that has stopped answering still
# reaches an operator. Signals the application derives about itself (signups,
# completed conversations) travel through the product analytics sinks instead.
#
# `live` and `live-eu` are two regional stacks in one project. Every resource here is
# named from local.resource_name_prefix and every condition filters to this stack's own
# services, so the two stacks alert independently without colliding in project state.

locals {
  monitoring_enabled = var.monitoring_enabled && var.deploy_services

  # Derived from configuration rather than from the resources themselves. These lists feed
  # `count`, which Terraform must resolve during plan; reading a not-yet-created resource's
  # attributes here would make a first apply fail instead of creating the alerts.
  monitored_service_names = var.deploy_services ? compact([
    "${local.resource_name_prefix}-backend",
    var.radioso_mcp_enabled ? "${local.resource_name_prefix}-mcp" : null,
    "${local.resource_name_prefix}-frontend",
    "${local.resource_name_prefix}-worker",
    "${local.resource_name_prefix}-crawler-worker",
  ]) : []

  monitored_queue_names = var.deploy_services ? [
    var.worker_task_queue_name,
    var.worker_crawl_task_queue_name,
    var.action_dispatch_task_queue_name,
  ] : []

  monitored_scheduler_job_names = var.deploy_services ? [
    "${local.resource_name_prefix}-document-worker-recovery",
    "${local.resource_name_prefix}-crawler-worker-recovery",
    "${local.resource_name_prefix}-action-dispatch-recovery",
    "${local.resource_name_prefix}-copilot-retention",
  ] : []

  # Cloud Monitoring filters use one_of(); Cloud Logging filters use (a OR b). The two
  # query languages are not interchangeable, so each list is rendered for its consumer.
  monitoring_service_filter = join(",", [for name in local.monitored_service_names : "\"${name}\""])
  logging_service_filter    = join(" OR ", [for name in local.monitored_service_names : "\"${name}\""])
  monitoring_queue_filter   = join(",", [for name in local.monitored_queue_names : "\"${name}\""])
  logging_scheduler_filter = join(" OR ", [
    for name in local.monitored_scheduler_job_names : "\"${name}\""
  ])

  # coalesce() errors when every argument is null, which is the ordinary state before the
  # first apply creates the backend service. try() keeps that a null host — and so a
  # skipped uptime check — rather than a plan-time failure.
  backend_uptime_host = try(coalesce(
    var.monitoring_uptime_host,
    try(trimprefix(google_cloud_run_v2_service.backend[0].uri, "https://"), null),
  ), null)

  # Cloud SQL reports under `project:instance`, which is not the `project:region:instance`
  # connection name the rest of the stack uses.
  monitored_database_id = "${var.project_id}:${google_sql_database_instance.postgres.name}"

  # Alert policies address channels by ID. Email channels are created here. Slack channels
  # are not: that channel type stores an OAuth token Terraform would have to hold in state,
  # so create it once in the console and pass its ID through the extra-channels variable.
  notification_channel_ids = concat(
    [for channel in google_monitoring_notification_channel.email : channel.id],
    var.monitoring_extra_notification_channel_ids,
  )

  alert_documentation = "Radioso ${var.environment} (${var.region}). Runbook: docs/monitoring-alerts.md"
}

resource "google_monitoring_notification_channel" "email" {
  for_each = local.monitoring_enabled ? toset(var.monitoring_notification_emails) : toset([])

  display_name = "Radioso ${var.environment} ops (${each.value})"
  type         = "email"

  labels = {
    email_address = each.value
  }

  depends_on = [google_project_service.apis]
}

# --- Is the API answering at all ---

resource "google_monitoring_uptime_check_config" "backend" {
  count = local.monitoring_enabled ? 1 : 0

  display_name = "${local.resource_name_prefix}-backend-health"
  timeout      = "10s"
  period       = "60s"

  http_check {
    path         = "/health"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = local.backend_uptime_host
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_monitoring_alert_policy" "backend_unreachable" {
  count = local.monitoring_enabled ? 1 : 0

  display_name = "${local.resource_name_prefix} backend unreachable"
  combiner     = "OR"

  conditions {
    display_name = "Health check failing from more than one probe location"

    condition_threshold {
      filter = join(" AND ", [
        "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\"",
        "resource.type=\"uptime_url\"",
        "metric.label.\"check_id\"=\"${google_monitoring_uptime_check_config.backend[0].uptime_check_id}\"",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "60s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = local.notification_channel_ids
  depends_on            = [google_project_service.apis]
  documentation {
    content = "The backend stopped answering /health. Check Cloud Run revision health and Cloud SQL availability first. ${local.alert_documentation}"
  }
}

# --- Is it answering correctly ---

resource "google_monitoring_alert_policy" "cloud_run_server_errors" {
  count = local.monitoring_enabled && length(local.monitored_service_names) > 0 ? 1 : 0

  display_name = "${local.resource_name_prefix} Cloud Run 5xx rate"
  combiner     = "OR"

  conditions {
    display_name = "Sustained 5xx responses"

    condition_threshold {
      filter = join(" AND ", [
        "metric.type=\"run.googleapis.com/request_count\"",
        "resource.type=\"cloud_run_revision\"",
        "metric.label.\"response_code_class\"=\"5xx\"",
        "resource.label.\"service_name\"=one_of(${local.monitoring_service_filter})",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = var.monitoring_server_error_rate_threshold
      duration        = "300s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.service_name"]
      }
    }
  }

  notification_channels = local.notification_channel_ids
  depends_on            = [google_project_service.apis]
  documentation {
    content = "A Cloud Run service is returning 5xx responses above ${var.monitoring_server_error_rate_threshold}/s averaged over five minutes. ${local.alert_documentation}"
  }
}

resource "google_monitoring_alert_policy" "backend_latency" {
  count = local.monitoring_enabled && var.deploy_services ? 1 : 0

  display_name = "${local.resource_name_prefix} backend p95 latency"
  combiner     = "OR"

  conditions {
    display_name = "p95 request latency above threshold"

    condition_threshold {
      filter = join(" AND ", [
        "metric.type=\"run.googleapis.com/request_latencies\"",
        "resource.type=\"cloud_run_revision\"",
        "resource.label.\"service_name\"=\"${local.resource_name_prefix}-backend\"",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = var.monitoring_backend_latency_p95_ms
      duration        = "300s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_PERCENTILE_95"
        cross_series_reducer = "REDUCE_MEAN"
        group_by_fields      = ["resource.label.service_name"]
      }
    }
  }

  notification_channels = local.notification_channel_ids
  depends_on            = [google_project_service.apis]
  documentation {
    content = "Backend p95 latency exceeded ${var.monitoring_backend_latency_p95_ms}ms for five minutes. Chat turns time out well before an operator notices them individually. ${local.alert_documentation}"
  }
}

# --- What the application itself is reporting ---

# The backend writes Pino JSON to stdout. Cloud Logging classifies a line by its
# `severity` field, which the backend logger sets from the numeric pino level; the
# `jsonPayload.level` clause keeps this metric accurate for revisions predating that.
resource "google_logging_metric" "application_errors" {
  count = local.monitoring_enabled && length(local.monitored_service_names) > 0 ? 1 : 0

  name = "${local.resource_name_prefix}-application-errors"
  filter = join(" AND ", [
    "resource.type=\"cloud_run_revision\"",
    "resource.labels.service_name=(${local.logging_service_filter})",
    "(severity>=ERROR OR jsonPayload.level>=50)",
  ])

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"

    labels {
      key         = "service_name"
      value_type  = "STRING"
      description = "Cloud Run service that logged the error."
    }
  }

  label_extractors = {
    "service_name" = "EXTRACT(resource.labels.service_name)"
  }

  depends_on = [google_project_service.apis]
}

resource "google_monitoring_alert_policy" "application_error_rate" {
  count = local.monitoring_enabled && length(local.monitored_service_names) > 0 ? 1 : 0

  display_name = "${local.resource_name_prefix} application error logs"
  combiner     = "OR"

  conditions {
    display_name = "Error-level log volume above threshold"

    condition_threshold {
      filter = join(" AND ", [
        "metric.type=\"logging.googleapis.com/user/${google_logging_metric.application_errors[0].name}\"",
        "resource.type=\"cloud_run_revision\"",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = var.monitoring_error_log_threshold
      duration        = "0s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.service_name"]
      }
    }
  }

  notification_channels = local.notification_channel_ids
  depends_on            = [google_project_service.apis]
  documentation {
    content = "More than ${var.monitoring_error_log_threshold} error-level log lines in five minutes. Open Cloud Logging for the named service and read the stack traces. ${local.alert_documentation}"
  }
}

# --- Can it still reach its own state ---

resource "google_monitoring_alert_policy" "cloudsql_saturation" {
  count = local.monitoring_enabled ? 1 : 0

  display_name = "${local.resource_name_prefix} Cloud SQL saturation"
  combiner     = "OR"

  dynamic "conditions" {
    for_each = {
      memory = {
        metric      = "cloudsql.googleapis.com/database/memory/utilization"
        threshold   = var.monitoring_cloudsql_memory_threshold
        description = "memory"
      }
      cpu = {
        metric      = "cloudsql.googleapis.com/database/cpu/utilization"
        threshold   = var.monitoring_cloudsql_cpu_threshold
        description = "CPU"
      }
      disk = {
        metric      = "cloudsql.googleapis.com/database/disk/utilization"
        threshold   = var.monitoring_cloudsql_disk_threshold
        description = "disk"
      }
    }

    content {
      display_name = "Cloud SQL ${conditions.value.description} utilization high"

      condition_threshold {
        filter = join(" AND ", [
          "metric.type=\"${conditions.value.metric}\"",
          "resource.type=\"cloudsql_database\"",
          "resource.label.\"database_id\"=\"${local.monitored_database_id}\"",
        ])
        comparison      = "COMPARISON_GT"
        threshold_value = conditions.value.threshold
        duration        = "300s"

        aggregations {
          alignment_period   = "300s"
          per_series_aligner = "ALIGN_MEAN"
        }
      }
    }
  }

  # Enabling alerting with nowhere to deliver it is a configuration mistake that would
  # otherwise apply cleanly and stay silent. One policy carries the check for all of them.
  lifecycle {
    precondition {
      condition     = length(local.notification_channel_ids) > 0
      error_message = "monitoring_enabled requires at least one notification target: set monitoring_notification_emails or monitoring_extra_notification_channel_ids."
    }
  }

  notification_channels = local.notification_channel_ids
  depends_on            = [google_project_service.apis]
  documentation {
    content = "The Cloud SQL instance backing this stack is saturated. A starved instance answers slowly enough that chat turns hit their statement timeout and die without an application-level error. Raise db_tier if this is sustained rather than spiky. ${local.alert_documentation}"
  }
}

# --- Are the queues draining ---

resource "google_monitoring_alert_policy" "task_queue_backlog" {
  count = local.monitoring_enabled && length(local.monitored_queue_names) > 0 ? 1 : 0

  display_name = "${local.resource_name_prefix} task queue backlog"
  combiner     = "OR"

  conditions {
    display_name = "Queue depth stuck above threshold"

    condition_threshold {
      filter = join(" AND ", [
        "metric.type=\"cloudtasks.googleapis.com/queue/depth\"",
        "resource.type=\"cloud_tasks_queue\"",
        "resource.label.\"queue_id\"=one_of(${local.monitoring_queue_filter})",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = var.monitoring_queue_depth_threshold
      duration        = "900s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_MAX"
        cross_series_reducer = "REDUCE_MAX"
        group_by_fields      = ["resource.label.queue_id"]
      }
    }
  }

  notification_channels = local.notification_channel_ids
  depends_on            = [google_project_service.apis]
  documentation {
    content = "A Cloud Tasks queue has held more than ${var.monitoring_queue_depth_threshold} tasks for fifteen minutes. Documents stop being indexed and conversation actions stop being delivered while this is true, with no user-visible error. ${local.alert_documentation}"
  }
}

resource "google_logging_metric" "scheduler_job_failures" {
  count = local.monitoring_enabled && length(local.monitored_scheduler_job_names) > 0 ? 1 : 0

  name = "${local.resource_name_prefix}-scheduler-job-failures"
  filter = join(" AND ", [
    "resource.type=\"cloud_scheduler_job\"",
    "resource.labels.job_id=(${local.logging_scheduler_filter})",
    "resource.labels.location=\"${var.region}\"",
    "logName=\"projects/${var.project_id}/logs/cloudscheduler.googleapis.com%2Fexecutions\"",
    "jsonPayload.\"@type\"=\"type.googleapis.com/google.cloud.scheduler.logging.AttemptFinished\"",
    "severity>=ERROR",
  ])

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"

    labels {
      key         = "job_id"
      value_type  = "STRING"
      description = "Cloud Scheduler job that logged a failed execution attempt."
    }
  }

  label_extractors = {
    "job_id" = "EXTRACT(resource.labels.job_id)"
  }

  depends_on = [google_project_service.apis]
}

resource "google_monitoring_alert_policy" "scheduler_job_failures" {
  count = local.monitoring_enabled && length(local.monitored_scheduler_job_names) > 0 ? 1 : 0

  display_name = "${local.resource_name_prefix} scheduler job failures"
  combiner     = "OR"

  conditions {
    display_name = "Scheduled job execution attempts logging errors"

    condition_threshold {
      filter = join(" AND ", [
        "metric.type=\"logging.googleapis.com/user/${google_logging_metric.scheduler_job_failures[0].name}\"",
        "resource.type=\"cloud_scheduler_job\"",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = var.monitoring_scheduler_failure_threshold
      duration        = "0s"

      aggregations {
        alignment_period     = "900s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.job_id"]
      }
    }
  }

  notification_channels = local.notification_channel_ids
  depends_on            = [google_project_service.apis]
  documentation {
    content = "A Cloud Scheduler job is failing. These jobs are the recovery path for document processing, website crawls, and conversation-action delivery, so a silent failure here shows up later as a stalled queue. ${local.alert_documentation}"
  }
}
