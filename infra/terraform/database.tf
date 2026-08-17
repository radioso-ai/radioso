resource "random_password" "db_password" {
  length  = 32
  special = false
}

resource "random_password" "worker_task_auth_token" {
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

    backup_configuration {
      enabled = true
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
