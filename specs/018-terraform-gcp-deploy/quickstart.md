# Quickstart: Deploy Hivec to GCP

## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.5
- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) (`gcloud`)
- A GCP project with billing enabled
- Docker (for building and pushing images)

## Step 1: Authenticate

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

If Terraform is not configured with Application Default Credentials, use a short-lived access token when initializing or applying against the GCS backend:

```bash
ACCESS_TOKEN="$(gcloud auth print-access-token)"
terraform init -reconfigure \
  -backend-config="bucket=YOUR_STATE_BUCKET_NAME" \
  -backend-config="access_token=${ACCESS_TOKEN}"
```

## Step 2: Bootstrap the State Bucket

This is a one-time operation that creates the GCS bucket for Terraform remote state.

```bash
cd infra/terraform/bootstrap
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your project_id and region
terraform init
terraform apply
```

Note the output `state_bucket_name` — you'll need it in Step 4.

## Step 3: Create the Shared Infrastructure

This first `terraform apply` enables project APIs, creates networking, Cloud SQL, Secret Manager secrets, the GCS document-storage bucket, and the Artifact Registry repository.

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars — set project_id, region, secrets, and deploy_services = false
terraform init -backend-config="bucket=YOUR_STATE_BUCKET_NAME"
terraform apply
```

After this completes, note the `artifact_registry_url` and `document_storage_bucket_name` outputs for the next step.

## Step 4: Build and Push Container Images

```bash
# Authenticate Docker with Artifact Registry
gcloud auth configure-docker REGION-docker.pkg.dev

# Build and push backend
docker build --platform linux/amd64 -f infra/backend.Dockerfile -t REGION-docker.pkg.dev/PROJECT_ID/radioso/backend:latest .
docker push REGION-docker.pkg.dev/PROJECT_ID/radioso/backend:latest

# Build and push frontend
docker build --platform linux/amd64 -f frontend/Dockerfile -t REGION-docker.pkg.dev/PROJECT_ID/radioso/frontend:latest .
docker push REGION-docker.pkg.dev/PROJECT_ID/radioso/frontend:latest
```

## Step 5: Deploy the Cloud Run Revisions

```bash
cd infra/terraform
# Update terraform.tfvars with the real backend_image and frontend_image tags
# Set deploy_services = true
# The apply creates three runtimes:
# - radioso-backend
# - radioso-frontend
# - radioso-worker
# After the first service deploy, copy the backend_url output into
# connector_public_base_url if you need public connector callbacks.
set -a && source ../../backend/.env && set +a
export TF_VAR_openai_api_key="$OPENAI_API_KEY"
export TF_VAR_session_cookie_secret="$SESSION_COOKIE_SECRET"
export TF_VAR_workspace_token_secret="$WORKSPACE_TOKEN_SECRET"
export TF_VAR_website_embed_secret="$WEBSITE_EMBED_SECRET"
export TF_VAR_connector_encryption_key="$CONNECTOR_ENCRYPTION_KEY"
terraform apply
```

## Step 6: Verify

After `terraform apply` completes, check the outputs:

```bash
terraform output frontend_url
terraform output backend_url
```

Visit the frontend URL and confirm the login page renders. The backend health endpoint should return 200, and the worker service should appear as `radioso-worker` in Cloud Run with the configured fixed instance count.

## Notes From Live Deploy

- Build Cloud Run images with `--platform linux/amd64`. A native Apple Silicon image will fail on Cloud Run with `exec format error`.
- Cloud SQL PostgreSQL 16 rejected the `cloudsql.enable_pgvector` instance flag. Keep pgvector support at the database-extension level instead of Terraforming that flag.
- Backend startup reruns SQL migrations on container boot. Make migrations idempotent and record applied files in `schema_migrations`, otherwise Cloud Run revisions can crash on repeated startup.
- The worker runs as a dedicated Cloud Run service pinned to a fixed instance count because the current provider version in this repo does not support Cloud Run worker pools.
- Terraform sets `DOCUMENT_STORAGE_DRIVER=gcs` for the backend and worker. Local filesystem storage is only for local runs.

## Updating

To deploy new container images:

1. Build and push new images with updated tags
2. Update `backend_image` / `frontend_image` in `terraform.tfvars`
3. Run `terraform apply`

## Tearing Down

```bash
# Remove all application infrastructure
cd infra/terraform
# If Terraform reports that the Artifact Registry repository is not empty,
# delete the pushed images first and rerun terraform destroy.
terraform destroy

# Optionally remove the state bucket (one-time cleanup)
cd infra/terraform/bootstrap
terraform destroy
```
