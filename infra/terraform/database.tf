resource "random_password" "db_password" {
  length  = 32
  special = false
}

resource "random_password" "worker_task_auth_token" {
  length  = 48
  special = false
}

resource "random_password" "radioso_mcp_signing_secret" {
  length  = 48
  special = false
}

resource "random_password" "operator_mcp_internal_secret" {
  length  = 48
  special = false
}

resource "random_password" "edge_proof_secret" {
  length  = 48
  special = false
}

resource "google_sql_database_instance" "postgres" {
  name                = "${local.resource_name_prefix}-db"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = var.db_deletion_protection

  settings {
    tier              = var.db_tier
    edition           = "ENTERPRISE"
    availability_type = "ZONAL"

    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = google_compute_network.vpc.id
      enable_private_path_for_google_cloud_services = true
    }

    # Pinned rather than left to the provider's defaults, because deleted conversation data lives on
    # in backups until they age out: seven daily backups, and seven days of point-in-time recovery
    # logs where recovery is on. The data retention docs state the same windows.
    #
    # Turning point-in-time recovery on restarts the instance, so it is a per-stack variable that
    # defaults to off, the value the provider has applied all along, and an unrelated plan shows no
    # recovery diff. Enable it per stack deliberately, in a quiet window.
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = var.db_point_in_time_recovery_enabled
      transaction_log_retention_days = var.db_point_in_time_recovery_enabled ? 7 : null

      backup_retention_settings {
        retained_backups = 7
        retention_unit   = "COUNT"
      }
    }
  }

  depends_on = [google_service_networking_connection.private_services]
}

resource "google_sql_database" "radioso" {
  name     = "radioso"
  instance = google_sql_database_instance.postgres.name
}

resource "google_sql_user" "radioso" {
  name     = "radioso"
  instance = google_sql_database_instance.postgres.name
  password = random_password.db_password.result
}
