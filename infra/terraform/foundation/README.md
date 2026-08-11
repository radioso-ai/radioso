# Terraform foundation

This root owns deployment identity and trust boundaries that routine Terraform
must only consume:

- the GitHub Actions deployer service account;
- the four application service accounts;
- GitHub OIDC workload identity pool, provider, and impersonation grant;
- deployer access to the environment Terraform-state bucket; and
- service-account and Cloud Tasks IAM required by the runtime services.

It deliberately does not own application secrets, document storage, Cloud SQL,
Cloud Run, or VPC resources. Those remain in the routine runtime stack until a
later least-privilege phase.

## Operating model

Run this root only with a human/bootstrap GCP principal. Do not add it to the
routine GitHub deployment workflow: that workflow assumes the identity and OIDC
trust this root establishes. Give it a separate remote backend prefix, as shown
in `backend.hcl.example`.

Create an environment-specific `terraform.tfvars` from
`terraform.tfvars.example`, and a local `backend.hcl` from
`backend.hcl.example`. Set `project_number` to the project's numeric ID. Neither
file should contain secret values.

The foundation owns the IAM, IAM Credentials, Security Token Service, and Cloud
Resource Manager APIs that its identity resources require. One bootstrap
exception remains: before this root can use Terraform to manage APIs, a human
principal with `serviceusage.services.enable` must enable the Service Usage API:

```sh
gcloud services enable serviceusage.googleapis.com --project PROJECT_ID
```

The foundation then keeps that API enabled along with its identity prerequisites.

## One-time migration from the existing runtime state

This change preserves every existing resource ID. It is a state transfer, not a
resource recreation. Perform this procedure for each environment in a scheduled
maintenance window using a human principal with the existing foundation-level
permissions.

1. Back up the routine environment state with `terraform state pull` before any
   changes. Initialise this root against its new backend, then import the
   existing foundation APIs and identity resources into the foundation state.
2. Import the current GitHub deployer service account, all four runtime service
   accounts, its state-bucket binding, retained project-role bindings, the four
   deployer `ServiceAccountUser` bindings, the two Cloud Tasks enqueuer
   bindings, the two worker-to-task `ServiceAccountUser` bindings, the workload
   identity pool and provider, and the workload-identity impersonation binding.
   Do not import the three temporary administration roles listed in step 5.
3. Update the routine root to this configuration only after the imports
   succeed. Before any routine plan or apply, remove the matching addresses from
   the old routine state with `terraform state rm`; do not run the old
   configuration while it still owns them.
4. Run plans in both roots. Neither plan may create or destroy identities,
   bindings, or OIDC resources. The
   GitHub environment variables retain their current values because the service
   account and provider names do not change.
5. After both plans are clean and a routine deployment succeeds, remove
   `roles/resourcemanager.projectIamAdmin`, `roles/iam.serviceAccountAdmin`, and
   `roles/iam.workloadIdentityPoolAdmin` from the routine deployer. Do this as a
   separate reviewed change, never before the verified transfer.

## State-address map

For an established environment, import these foundation addresses first, then
remove the corresponding legacy addresses from the runtime state. Replace the
role iteration keys with the exact role strings in that environment's
`terraform.tfvars`.

| Foundation address | Legacy runtime address |
| --- | --- |
| `google_project_service.required_apis["API"]` | `module.radioso.google_project_service.apis["API"]` for existing staging/live API state; none for live-eu |
| `google_service_account.github_actions_deployer` | `module.radioso.google_service_account.github_actions_deployer` |
| `google_service_account.runtime["backend"]` | `module.radioso.google_service_account.backend` |
| `google_service_account.runtime["frontend"]` | `module.radioso.google_service_account.frontend` |
| `google_service_account.runtime["worker"]` | `module.radioso.google_service_account.worker` |
| `google_service_account.runtime["worker_task"]` | `module.radioso.google_service_account.worker_task_invoker` |
| `google_project_iam_member.runtime_deployer_role["ROLE"]` | `module.radioso.google_project_iam_member.github_actions_*` |
| `google_service_account_iam_member.runtime_deployer_act_as["SERVICE"]` | `module.radioso.google_service_account_iam_member.github_actions_*_act_as` |
| `google_project_iam_member.runtime_cloud_tasks_enqueuer["backend" or "worker"]` | `module.radioso.google_project_iam_member.*_cloud_tasks_enqueuer` |
| `google_service_account_iam_member.runtime_worker_task_act_as["backend" or "worker"]` | `module.radioso.google_service_account_iam_member.*_worker_task_act_as` |
| `google_iam_workload_identity_pool.github_actions` | `module.radioso.google_iam_workload_identity_pool.github_actions` |
| `google_iam_workload_identity_pool_provider.github_actions` | `module.radioso.google_iam_workload_identity_pool_provider.github_actions` |
| `google_service_account_iam_member.github_actions_workload_identity_user` | `module.radioso.google_service_account_iam_member.github_actions_workload_identity_user` |

The state-bucket IAM grant was applied outside the old Terraform state. Import
it only into `google_storage_bucket_iam_member.runtime_deployer_state_access`;
there is no legacy address to remove.

Examples of the import identifiers, with `PROJECT_ID`, `PROJECT_NUMBER`,
`GHA_EMAIL`, `STATE_BUCKET`, `POOL_ID`, and `PROVIDER_ID` substituted:

```sh
terraform import google_service_account.github_actions_deployer \
  "projects/PROJECT_ID/serviceAccounts/GHA_EMAIL"
terraform import 'google_project_service.required_apis["iam.googleapis.com"]' \
  "PROJECT_ID/iam.googleapis.com"
terraform import 'google_service_account.runtime["backend"]' \
  "projects/PROJECT_ID/serviceAccounts/radioso-ENVIRONMENT-backend@PROJECT_ID.iam.gserviceaccount.com"
terraform import google_storage_bucket_iam_member.runtime_deployer_state_access \
  "STATE_BUCKET roles/storage.objectAdmin serviceAccount:GHA_EMAIL"
terraform import google_iam_workload_identity_pool.github_actions \
  "projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID"
terraform import google_iam_workload_identity_pool_provider.github_actions \
  "projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/providers/PROVIDER_ID"
```

For each retained project role and each service-account policy binding, use the
following provider import shapes:

```sh
terraform import 'google_project_iam_member.runtime_deployer_role["ROLE"]' \
  "PROJECT_ID ROLE serviceAccount:GHA_EMAIL"
terraform import 'google_service_account_iam_member.runtime_deployer_act_as["backend"]' \
  "projects/PROJECT_ID/serviceAccounts/radioso-ENVIRONMENT-backend@PROJECT_ID.iam.gserviceaccount.com roles/iam.serviceAccountUser serviceAccount:GHA_EMAIL"
terraform import 'google_project_iam_member.runtime_cloud_tasks_enqueuer["backend"]' \
  "PROJECT_ID roles/cloudtasks.enqueuer serviceAccount:radioso-ENVIRONMENT-backend@PROJECT_ID.iam.gserviceaccount.com"
terraform import 'google_service_account_iam_member.runtime_worker_task_act_as["backend"]' \
  "projects/PROJECT_ID/serviceAccounts/radioso-ENVIRONMENT-worker-task@PROJECT_ID.iam.gserviceaccount.com roles/iam.serviceAccountUser serviceAccount:radioso-ENVIRONMENT-backend@PROJECT_ID.iam.gserviceaccount.com"
```

Record the exact executed imports and state removals in the change record before
carrying this out in an environment.
