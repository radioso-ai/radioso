terraform {
  required_version = ">= 1.7"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }

  backend "gcs" {
    # Configure via:
    # terraform init -backend-config=backend.hcl
  }
}

locals {
  project_id = "radioso-494120"
  prefix     = "radioso-live-eu"
  pool_id    = "github-actions-live-eu"

  terraform_member = "serviceAccount:${local.prefix}-gha@${local.project_id}.iam.gserviceaccount.com"
  runtime_accounts = {
    for name in ["backend", "frontend", "worker", "worker_task"] :
    name => "${local.prefix}-${replace(name, "_", "-")}@${local.project_id}.iam.gserviceaccount.com"
  }
}

provider "google" {
  project = local.project_id
  region  = "europe-west1"
}

data "google_project" "this" {
  project_id = local.project_id
}

module "foundation" {
  source = "../.."

  project_id     = local.project_id
  project_number = data.google_project.this.number
  environment    = "live-eu"
  region         = "europe-west1"

  # Must match the bucket in ../../../environments/live-eu/backend.hcl.
  terraform_state_bucket_name = "radioso-494120-terraform-state-eu"

  # live-eu shares radioso-494120 with live, whose foundation owns the project's APIs and the
  # _Default log bucket.
  manage_project_services = false

  # Named apart from live's pool so the two coexist in one project.
  github_actions_workload_identity_pool_id     = local.pool_id
  github_actions_workload_identity_provider_id = local.pool_id
}

# Adoption of the identity plane the routine root used to own (#1596). Each block is a no-op once
# the object is in this state; the CI identity's project roles are imported only where the
# foundation still declares them, so the plan's creates are the genuinely new grants.

import {
  to = module.foundation.google_service_account.ci["terraform"]
  id = "projects/${local.project_id}/serviceAccounts/${trimprefix(local.terraform_member, "serviceAccount:")}"
}

import {
  for_each = local.runtime_accounts
  to       = module.foundation.google_service_account.runtime[each.key]
  id       = "projects/${local.project_id}/serviceAccounts/${each.value}"
}

import {
  for_each = toset([
    "roles/artifactregistry.admin",
    "roles/cloudscheduler.admin",
    "roles/cloudsql.admin",
    "roles/compute.networkAdmin",
    "roles/run.admin",
    "roles/secretmanager.admin",
    "roles/storage.admin",
  ])
  to = module.foundation.google_project_iam_member.ci_project_role["terraform ${each.value}"]
  id = "${local.project_id} ${each.value} ${local.terraform_member}"
}

import {
  for_each = local.runtime_accounts
  to       = module.foundation.google_service_account_iam_member.ci_act_as["terraform ${each.key}"]
  id       = "projects/${local.project_id}/serviceAccounts/${each.value} roles/iam.serviceAccountUser ${local.terraform_member}"
}

import {
  for_each = toset(["backend", "worker"])
  to       = module.foundation.google_project_iam_member.runtime_cloud_tasks_enqueuer[each.value]
  id       = "${local.project_id} roles/cloudtasks.enqueuer serviceAccount:${local.runtime_accounts[each.value]}"
}

import {
  for_each = toset(["backend", "worker"])
  to       = module.foundation.google_service_account_iam_member.runtime_worker_task_act_as[each.value]
  id       = "projects/${local.project_id}/serviceAccounts/${local.runtime_accounts["worker_task"]} roles/iam.serviceAccountUser serviceAccount:${local.runtime_accounts[each.value]}"
}

import {
  to = module.foundation.google_storage_bucket_iam_member.terraform_state_access
  id = "radioso-494120-terraform-state-eu roles/storage.objectAdmin ${local.terraform_member}"
}

import {
  to = module.foundation.google_iam_workload_identity_pool.github_actions
  id = "projects/${local.project_id}/locations/global/workloadIdentityPools/${local.pool_id}"
}

import {
  to = module.foundation.google_iam_workload_identity_pool_provider.github_actions
  id = "projects/${local.project_id}/locations/global/workloadIdentityPools/${local.pool_id}/providers/${local.pool_id}"
}

output "ci_service_account_emails" {
  value = module.foundation.ci_service_account_emails
}
