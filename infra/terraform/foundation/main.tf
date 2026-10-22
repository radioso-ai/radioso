terraform {
  required_version = ">= 1.7"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
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

  # The routine Terraform root manages these and nothing above resource-level IAM, so this
  # identity holds no project IAM administration. Every role here maps to resources in
  # infra/terraform/*.tf; the monitoring roles cover alerting that an environment turns on
  # from GitHub values alone, without a code change that could add them first.
  terraform_project_roles = setunion(
    [
      "roles/artifactregistry.admin",
      "roles/cloudscheduler.admin",
      "roles/cloudsql.admin",
      "roles/cloudtasks.queueAdmin",
      "roles/compute.networkAdmin",
      "roles/iam.serviceAccountViewer",
      "roles/monitoring.alertPolicyEditor",
      "roles/monitoring.notificationChannelEditor",
      "roles/monitoring.uptimeCheckConfigEditor",
      "roles/run.admin",
      "roles/secretmanager.admin",
      "roles/storage.admin",
    ],
    var.manage_project_services ? ["roles/serviceusage.serviceUsageAdmin"] : [],
  )

  # Log buckets and log-based metrics without roles/logging.configWriter, whose sink
  # permissions could route every log line out of the project.
  terraform_logging_permissions = concat(
    [
      "logging.logMetrics.create",
      "logging.logMetrics.delete",
      "logging.logMetrics.get",
      "logging.logMetrics.list",
      "logging.logMetrics.update",
    ],
    var.manage_project_services ? [
      "logging.buckets.create",
      "logging.buckets.get",
      "logging.buckets.list",
      "logging.buckets.update",
    ] : [],
  )

  # One identity per workflow. `workflow` is the file GitHub names in the OIDC token's
  # job_workflow_ref (the called file for a reusable workflow), and only runs of that file on
  # main may impersonate the identity. `acts_as` lists the runtime accounts it may attach to
  # what it deploys.
  ci_identities = merge(
    {
      terraform = {
        account_id    = "${local.resource_name_prefix}-gha"
        display_name  = "Radioso ${var.environment} GitHub Actions Terraform"
        workflow      = "terraform.yml"
        project_roles = local.terraform_project_roles
        acts_as       = keys(local.runtime_service_accounts)
      }
      # Push access comes from the routine root, which grants it on the environment's image
      # repository: live and live-eu share a project.
      deploy = {
        account_id    = "${local.resource_name_prefix}-deploy"
        display_name  = "Radioso ${var.environment} GitHub Actions image deploy"
        workflow      = "_deploy-cloud-run.yml"
        project_roles = toset(["roles/run.developer"])
        acts_as       = ["backend", "frontend", "worker"]
      }
    },
    var.docs_deployer_enabled ? {
      docs = {
        account_id   = "${local.resource_name_prefix}-docs"
        display_name = "Radioso ${var.environment} GitHub Actions docs deploy"
        workflow     = "deploy-docs.yml"
        # firebase-tools reads the web app config, API key included, during a Hosting deploy.
        project_roles = toset(["roles/firebasehosting.admin", "roles/serviceusage.apiKeysViewer"])
        acts_as       = []
      }
    } : {},
  )

  ci_project_roles = merge([
    for identity, config in local.ci_identities : {
      for role in config.project_roles : "${identity} ${role}" => { identity = identity, role = role }
    }
  ]...)

  ci_act_as = merge([
    for identity, config in local.ci_identities : {
      for runtime in config.acts_as : "${identity} ${runtime}" => { identity = identity, runtime = runtime }
    }
  ]...)

  github_actions_pool_principal = "principalSet://iam.googleapis.com/projects/${var.project_number}/locations/global/workloadIdentityPools/${google_iam_workload_identity_pool.github_actions.workload_identity_pool_id}"
  github_workflow_ref_prefix    = "${var.github_repository_owner}/${var.github_repository_name}/.github/workflows"
}

resource "google_project_service" "required_apis" {
  for_each = var.manage_project_services ? local.required_apis : toset([])

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_service_account" "ci" {
  for_each = local.ci_identities

  project      = var.project_id
  account_id   = each.value.account_id
  display_name = each.value.display_name

  depends_on = [google_project_service.required_apis]
}

resource "google_service_account" "runtime" {
  for_each = local.runtime_service_accounts

  project      = var.project_id
  account_id   = each.value.account_id
  display_name = each.value.display_name

  depends_on = [google_project_service.required_apis]
}

resource "google_project_iam_member" "ci_project_role" {
  for_each = local.ci_project_roles

  project = var.project_id
  role    = each.value.role
  member  = google_service_account.ci[each.value.identity].member
}

resource "google_project_iam_custom_role" "terraform_logging" {
  project     = var.project_id
  role_id     = replace("${local.resource_name_prefix}-terraform-logging", "-", "_")
  title       = "Radioso ${var.environment} Terraform logging config"
  description = "Log bucket settings and log-based metrics for the ${var.environment} Terraform identity, without log sinks."
  permissions = local.terraform_logging_permissions
}

resource "google_project_iam_member" "terraform_logging" {
  project = var.project_id
  role    = google_project_iam_custom_role.terraform_logging.name
  member  = google_service_account.ci["terraform"].member
}

resource "google_storage_bucket_iam_member" "terraform_state_access" {
  bucket = var.terraform_state_bucket_name
  role   = "roles/storage.objectAdmin"
  member = google_service_account.ci["terraform"].member
}

resource "google_project_iam_member" "runtime_cloud_tasks_enqueuer" {
  for_each = toset(["backend", "worker"])

  project = var.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = google_service_account.runtime[each.value].member
}

resource "google_service_account_iam_member" "ci_act_as" {
  for_each = local.ci_act_as

  service_account_id = google_service_account.runtime[each.value.runtime].name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.ci[each.value.identity].member
}

resource "google_service_account_iam_member" "runtime_worker_task_act_as" {
  for_each = toset(["backend", "worker"])

  service_account_id = google_service_account.runtime["worker_task"].name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.runtime[each.value].member
}

resource "google_iam_workload_identity_pool" "github_actions" {
  project                   = var.project_id
  workload_identity_pool_id = var.github_actions_workload_identity_pool_id
  display_name              = "GitHub Actions ${title(var.environment)}"
  description               = "OIDC trust for GitHub Actions deployments to Radioso ${var.environment}"

  depends_on = [google_project_service.required_apis]
}

resource "google_iam_workload_identity_pool_provider" "github_actions" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github_actions.workload_identity_pool_id
  workload_identity_pool_provider_id = var.github_actions_workload_identity_provider_id
  display_name                       = "GitHub Actions ${title(var.environment)}"
  description                        = "OIDC provider for ${var.github_repository_owner}/${var.github_repository_name}"

  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.actor"            = "assertion.actor"
    "attribute.job_workflow_ref" = "assertion.job_workflow_ref"
    "attribute.ref"              = "assertion.ref"
    "attribute.repository"       = "assertion.repository"
  }

  attribute_condition = "assertion.repository == '${var.github_repository_owner}/${var.github_repository_name}' && assertion.ref == 'refs/heads/main'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "ci_workload_identity_user" {
  for_each = local.ci_identities

  service_account_id = google_service_account.ci[each.key].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.github_actions_pool_principal}/attribute.job_workflow_ref/${local.github_workflow_ref_prefix}/${each.value.workflow}@refs/heads/main"

  # The mapping this principal matches on has to exist before the grant is useful.
  depends_on = [google_iam_workload_identity_pool_provider.github_actions]
}
