terraform {
  required_version = ">= 1.5"

  backend "gcs" {}

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  resource_name_prefix = "radioso-${var.environment}"
  required_apis = toset([
    "cloudresourcemanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "serviceusage.googleapis.com",
    "sts.googleapis.com",
  ])
  runtime_service_accounts = {
    backend = {
      account_id   = "${local.resource_name_prefix}-backend"
      display_name = "Radioso ${var.environment} backend Cloud Run"
    }
    frontend = {
      account_id   = "${local.resource_name_prefix}-frontend"
      display_name = "Radioso ${var.environment} frontend Cloud Run"
    }
    worker = {
      account_id   = "${local.resource_name_prefix}-worker"
      display_name = "Radioso ${var.environment} document worker"
    }
    worker_task = {
      account_id   = "${local.resource_name_prefix}-worker-task"
      display_name = "Radioso ${var.environment} worker task invoker"
    }
  }
}

resource "google_project_service" "required_apis" {
  for_each = var.manage_project_services ? local.required_apis : toset([])

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_service_account" "github_actions_deployer" {
  account_id   = "${local.resource_name_prefix}-gha"
  display_name = "Radioso ${var.environment} GitHub Actions deployer"

  depends_on = [google_project_service.required_apis]
}

resource "google_service_account" "runtime" {
  for_each = local.runtime_service_accounts

  account_id   = each.value.account_id
  display_name = each.value.display_name

  depends_on = [google_project_service.required_apis]
}

resource "google_project_iam_member" "runtime_deployer_role" {
  for_each = var.runtime_deployer_project_roles

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.github_actions_deployer.email}"
}

resource "google_storage_bucket_iam_member" "runtime_deployer_state_access" {
  bucket = var.terraform_state_bucket_name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.github_actions_deployer.email}"
}

resource "google_project_iam_member" "runtime_cloud_tasks_enqueuer" {
  for_each = toset(["backend", "worker"])

  project = var.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = "serviceAccount:${google_service_account.runtime[each.value].email}"
}

resource "google_service_account_iam_member" "runtime_deployer_act_as" {
  for_each = google_service_account.runtime

  service_account_id = each.value.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.github_actions_deployer.email}"
}

resource "google_service_account_iam_member" "runtime_worker_task_act_as" {
  for_each = toset(["backend", "worker"])

  service_account_id = google_service_account.runtime["worker_task"].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.runtime[each.value].email}"
}

resource "google_iam_workload_identity_pool" "github_actions" {
  workload_identity_pool_id = var.github_actions_workload_identity_pool_id
  display_name              = "GitHub Actions ${title(var.environment)}"
  description               = "OIDC trust for GitHub Actions deployments to Radioso ${var.environment}"

  depends_on = [google_project_service.required_apis]
}

resource "google_iam_workload_identity_pool_provider" "github_actions" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github_actions.workload_identity_pool_id
  workload_identity_pool_provider_id = var.github_actions_workload_identity_provider_id
  display_name                       = "GitHub Actions ${title(var.environment)}"
  description                        = "OIDC provider for ${var.github_repository_owner}/${var.github_repository_name}"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.actor"      = "assertion.actor"
    "attribute.ref"        = "assertion.ref"
    "attribute.repository" = "assertion.repository"
  }

  attribute_condition = "assertion.repository == '${var.github_repository_owner}/${var.github_repository_name}' && assertion.ref == 'refs/heads/main'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_actions_workload_identity_user" {
  service_account_id = google_service_account.github_actions_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/projects/${var.project_number}/locations/global/workloadIdentityPools/${google_iam_workload_identity_pool.github_actions.workload_identity_pool_id}/attribute.repository/${var.github_repository_owner}/${var.github_repository_name}"
}
