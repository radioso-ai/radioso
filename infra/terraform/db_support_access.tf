# Engineer access to the stack's database. Engineers never connect as the application's own user:
# they run the `<prefix>-db-support` job, which signs in to Postgres as the db-support service
# account through IAM database authentication. pgAudit records every statement it runs
# (infra/db-support/setup.sql), and the foundation root keeps those records for 12 months. The job
# reads its query from, and writes its result to, a bucket that keeps objects for a day, so result
# rows stay out of the job's log.
#
# The foundation root creates the service account and its Cloud SQL login grant, so apply it
# before turning `db_support_access_enabled` on. infra/db-support/README.md has the rollout.
locals {
  db_support_results_bucket_name = "${var.project_id}-${local.resource_name_prefix}-db-support-results"
}

data "google_service_account" "db_support" {
  count = var.db_support_access_enabled ? 1 : 0

  account_id = "${local.resource_name_prefix}-db-support"
}

# An IAM service-account user has no database privileges until setup.sql grants them.
resource "google_sql_user" "db_support" {
  count = var.db_support_access_enabled ? 1 : 0

  name     = trimsuffix(data.google_service_account.db_support[0].email, ".gserviceaccount.com")
  instance = google_sql_database_instance.postgres.name
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
}

resource "google_storage_bucket" "db_support_results" {
  count = var.db_support_access_enabled ? 1 : 0

  name          = local.db_support_results_bucket_name
  location      = var.region
  project       = var.project_id
  force_destroy = true

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # A deleted result is gone at once rather than kept for the default seven days of soft delete.
  soft_delete_policy {
    retention_duration_seconds = 0
  }

  # The query script deletes each run's objects once it has printed the result; this catches a run
  # that never got that far.
  lifecycle_rule {
    condition {
      age = 1
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "db_support_results_access" {
  count = var.db_support_access_enabled ? 1 : 0

  bucket = google_storage_bucket.db_support_results[0].name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${data.google_service_account.db_support[0].email}"
}

# Cloud Storage volumes on a job need the google-beta provider and the BETA launch stage at the
# pinned provider version.
resource "google_cloud_run_v2_job" "db_support" {
  count    = var.db_support_access_enabled ? 1 : 0
  provider = google-beta

  name         = "${local.resource_name_prefix}-db-support"
  location     = var.region
  project      = var.project_id
  launch_stage = "BETA"

  template {
    task_count = 1

    template {
      service_account       = data.google_service_account.db_support[0].email
      max_retries           = 0
      timeout               = "900s"
      execution_environment = "EXECUTION_ENVIRONMENT_GEN2"

      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          network    = google_compute_network.vpc.name
          subnetwork = google_compute_subnetwork.subnet.name
        }
      }

      containers {
        # Pinned by digest, because the job holds write access to every table. db-support.sh
        # pins the same image for setup; bump both together.
        image   = "docker.io/library/postgres:16-alpine@sha256:81e77a4833487b8132fe4b00bedd39dc3f74b8641e387f19312a48f7de218c2e"
        command = ["/bin/sh", "-c", file("${path.module}/../db-support/run-query.sh"), "db-support"]

        env {
          name  = "DB_HOST"
          value = google_sql_database_instance.postgres.private_ip_address
        }
        env {
          name  = "DB_NAME"
          value = google_sql_database.radioso.name
        }
        env {
          name  = "DB_USER"
          value = google_sql_user.db_support[0].name
        }

        volume_mounts {
          name       = "results"
          mount_path = "/results"
        }
      }

      volumes {
        name = "results"
        gcs {
          bucket    = google_storage_bucket.db_support_results[0].name
          read_only = false
        }
      }
    }
  }

  depends_on = [google_storage_bucket_iam_member.db_support_results_access]
}
