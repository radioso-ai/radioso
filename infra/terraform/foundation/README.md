# Terraform foundation

This module owns the project configuration a person applies: each environment's identity plane,
and where its log entries are stored. The Terraform workflow's identity can't create the sinks or
exclusions that route logs.

- the CI identities GitHub Actions impersonates, one per workflow, with their project roles;
- the four application service accounts and the IAM the runtime services need between them;
- the GitHub OIDC workload identity pool and provider, and which workflow may impersonate which
  identity;
- the Terraform identity's access to the routine Terraform state bucket; and
- the log bucket, sink and exclusion of an environment that keeps its logs in its own region (see
  [Regional logs](#regional-logs)).

The routine runtime roots in `../environments/` consume these identities through `data` sources
and manage nothing above resource-level IAM, so the identity that applies them holds no project
IAM administration.

## Operating model

Each environment has its own foundation root in `environments/<env>/`, with its state under the
`radioso/foundation/<env>` prefix of that environment's state bucket. A person applies it with
their own Google credentials; no workflow does. The Terraform workflow can't apply its own
foundation, because changing the identity it runs as is exactly the privilege this split takes
away from it.

```sh
cd infra/terraform/foundation/environments/staging
export GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token)"
terraform init -backend-config=backend.hcl
terraform plan
terraform apply
```

Applying needs a project owner, or a principal holding Project IAM Admin, Role Administrator,
Service Account Admin, Workload Identity Pool Admin, Service Usage Admin, Storage Admin on the
state bucket, and Logs Configuration Writer where `regional_log_bucket_enabled` is on.

Every plan also reads the live project and service-account policies. Two `check` blocks warn when
a CI identity holds a project role, or trusts a workload identity principal, that this module
doesn't declare, so a grant made by hand shows up in the next plan. Remove it, or declare it here.

`live` and `live-eu` share the `radioso-494120` project. `live` owns the project's APIs and its
`_Default` log bucket; `live-eu` sets `manage_project_services = false` and runs on its own pool,
`github-actions-live-eu`. Image pushes are scoped to each environment's repository, and a
deployed revision can only run as that environment's accounts. The other project-wide roles, such
as `run.developer`, `run.admin`, and `secretmanager.admin`, reach both environments' resources.

The Terraform identity's object access to the state bucket covers this root's prefix too. Editing
foundation state grants nothing: the next plan refreshes against the live policies.

## CI identities

Each identity trusts one workflow file. The workload identity provider maps the OIDC token's
`job_workflow_ref` claim, and each identity's `roles/iam.workloadIdentityUser` grant names one
file on `refs/heads/main`. For a reusable workflow the claim names the called file, so every
caller of `_deploy-cloud-run.yml` deploys as the deploy identity. Renaming a workflow file means
updating `ci_identities` in `main.tf` and applying the foundation before the renamed file runs.

| Identity | Account | Workflow | GitHub environment variable |
| --- | --- | --- | --- |
| Terraform | `radioso-<env>-gha` | `terraform.yml` | `GCP_TERRAFORM_SERVICE_ACCOUNT` |
| Image deploy | `radioso-<env>-deploy` | `_deploy-cloud-run.yml` | `GCP_DEPLOY_SERVICE_ACCOUNT` |
| Docs deploy (live only) | `radioso-live-docs` | `deploy-docs.yml` | `GCP_DOCS_DEPLOY_SERVICE_ACCOUNT` |

The `ci_service_account_emails` output lists the accounts for an environment.

### Terraform identity

| Grant | Why |
| --- | --- |
| `roles/artifactregistry.admin` | The environment's image repository, its cleanup policies, and the deploy identity's push grant on it |
| `roles/cloudscheduler.admin` | Scheduler jobs |
| `roles/cloudsql.admin` | The Cloud SQL instance, database, and user |
| `roles/cloudtasks.queueAdmin` | Task queues |
| `roles/compute.networkAdmin` | VPC, subnet, private services range, and service networking peering |
| `roles/iam.serviceAccountViewer` | Reads the runtime service accounts the root attaches to services |
| `roles/monitoring.alertPolicyEditor`, `roles/monitoring.notificationChannelEditor`, `roles/monitoring.uptimeCheckConfigEditor` | Alerting, which an environment turns on from GitHub values alone (see `docs/monitoring-google-cloud.md`) |
| `roles/run.admin` | Cloud Run services and their invoker bindings |
| `roles/secretmanager.admin` | Secrets, their versions, and accessor bindings |
| `roles/storage.admin` | The documents bucket and its bindings |
| `roles/serviceusage.serviceUsageAdmin` | Project API enablement, where `manage_project_services` is on |
| Custom `radioso_<env>_terraform_logging` | Log-based metrics, plus `_Default` log bucket settings where `manage_project_services` is on. Not `roles/logging.configWriter`, whose sink permissions could route every log line out of the project |
| `roles/iam.serviceAccountUser` on the four runtime accounts | Attaching them to Cloud Run services and scheduler jobs |
| `roles/storage.objectAdmin` on the state bucket | Routine Terraform state |

The routine roots can also put a load balancer and CDN in front of the frontend
(`frontend_cdn_domain`). Turning that on is a code change, and that change also adds
`roles/compute.loadBalancerAdmin` here for the managed certificate, which `compute.networkAdmin`
can't create.

### Image deploy identity

| Grant | Why |
| --- | --- |
| `roles/artifactregistry.writer` on the `radioso-<env>` repository | Pushes the backend and frontend images. The routine root grants it alongside the repository it owns, so it reaches this environment's repository only |
| `roles/run.developer` | Updates the Cloud Run services to the new images |
| `roles/iam.serviceAccountUser` on the backend, frontend, and worker accounts | Deploying revisions that run as those accounts |

### Docs deploy identity

| Grant | Why |
| --- | --- |
| `roles/firebasehosting.admin` | Releases the docs portal to Firebase Hosting |
| `roles/serviceusage.apiKeysViewer` | `firebase-tools` reads the web app config, API key included, during a Hosting deploy |

## Regional logs

Every Cloud Run request and application log line lands in the project's `_Default` bucket, whose
location is `global` and can't change. `live` and `live-eu` share a project, so without routing,
EU entries would sit in that global bucket beside US ones. `live-eu` sets
`regional_log_bucket_enabled = true`, which adds:

- a `radioso-live-eu-logs` bucket in `europe-west1` with 30-day retention;
- a sink of the same name routing every entry about a resource in `europe-west1`, plus the
  `radioso-live-eu-db` Cloud SQL instance and any restore or clone of it (whose entries carry only
  a coarse `europe` region), to that bucket, leaving out the audit entries `_Required` already
  stores; and
- an exclusion on the `_Default` sink with the same filter, so the entries are stored once.

The filter takes every entry in the region, so it assumes `live-eu` is the project's only
environment in `europe-west1`. A second environment there would need a filter of its own.

`live`'s Terraform identity can update log bucket settings anywhere in the project, because it
owns `_Default`'s retention, so it could also change this bucket's. The next plan of this root
shows any such change as drift.

The routing sits here because the Terraform identity holds no sink or exclusion permission: a sink
could send every log line out of the project, and an exclusion could drop them. Log-based metrics
count entries whatever bucket stores them, so the routine root's alerts keep firing. Read the
bucket with `gcloud logging read '<filter>' --bucket=radioso-live-eu-logs --location=europe-west1
--view=_AllLogs --project=radioso-494120`; that needs `logging.views.access`, which Private Logs
Viewer and Logs View Accessor hold and Logs Viewer doesn't.

Apply it in two steps, because Google takes a few minutes to apply a sink or exclusion change and
an exclusion that lands before its sink drops those minutes of entries:

```sh
terraform apply -target=module.foundation.google_logging_project_sink.regional
gcloud logging read 'resource.type="cloud_run_revision"' --project=radioso-494120 \
  --bucket=radioso-live-eu-logs --location=europe-west1 --view=_AllLogs --limit=3 --freshness=10m
terraform apply
```

Run the full apply once the read returns entries.

Turning the routing off reverses the order, again in two steps:

```sh
terraform destroy -target=module.foundation.google_logging_project_exclusion.regional_from_default
# a few minutes later, set regional_log_bucket_enabled = false, then:
terraform apply
```

The second apply deletes the bucket and the entries it holds. Google keeps a deleted bucket's id
reserved for 7 days, so turning the routing back on inside that window fails until it frees.

## Changing a role

Add it to the identity's entry in `ci_identities`, or to `terraform_project_roles`, with the
resource or command that needs it. Apply the foundation for each environment before merging the
change that depends on it, so the workflow never runs ahead of its grant. Removing a role that an
environment root adopted also removes its entry from that root's `import` block, or the plan
fails on an import target with no configuration.

## A new environment

1. Create the Terraform state bucket with `../bootstrap`.
2. A person with the Service Usage API permission enables it once, so Terraform can manage the
   rest of the APIs:

   ```sh
   gcloud services enable serviceusage.googleapis.com --project PROJECT_ID
   ```

3. Copy an existing `environments/<env>/` root, drop its `import` blocks, set the project, region,
   pool, and state bucket, and apply it.
4. Set the GitHub environment variables in the table above from the `ci_service_account_emails`
   output, and `GCP_WORKLOAD_IDENTITY_PROVIDER` from `github_actions_workload_identity_provider`.
