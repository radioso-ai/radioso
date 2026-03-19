# Quickstart: Deploy Hivec to GCP

## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.5
- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) (`gcloud`)
- A GCP project with billing enabled
- Docker (for building and pushing images)

## Step 1: Authenticate

```bash
gcloud auth login
gcloud auth application-default login
gcloud config set project YOUR_PROJECT_ID
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

## Step 3: Build and Push Container Images

```bash
# Authenticate Docker with Artifact Registry (after Step 4 creates the registry)
gcloud auth configure-docker REGION-docker.pkg.dev

# Build and push backend
docker build -f infra/backend.Dockerfile -t REGION-docker.pkg.dev/PROJECT_ID/hivec/backend:latest .
docker push REGION-docker.pkg.dev/PROJECT_ID/hivec/backend:latest

# Build and push frontend
docker build -f frontend/Dockerfile -t REGION-docker.pkg.dev/PROJECT_ID/hivec/frontend:latest ./frontend
docker push REGION-docker.pkg.dev/PROJECT_ID/hivec/frontend:latest
```

> Note: On first deploy, you may need to run `terraform apply` first (Step 4) to create the Artifact Registry, then build/push images, then run `terraform apply` again to update Cloud Run with the actual images.

## Step 4: Deploy Infrastructure

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars — set project_id, region, image tags, secrets, etc.
terraform init -backend-config="bucket=YOUR_STATE_BUCKET_NAME"
terraform apply
```

## Step 5: Verify

After `terraform apply` completes, check the outputs:

```bash
terraform output frontend_url
terraform output backend_url
```

Visit the frontend URL — you should see the Hivec login page. The backend health endpoint should return 200.

## Updating

To deploy new container images:

1. Build and push new images with updated tags
2. Update `backend_image` / `frontend_image` in `terraform.tfvars`
3. Run `terraform apply`

## Tearing Down

```bash
# Remove all application infrastructure
cd infra/terraform
terraform destroy

# Optionally remove the state bucket (one-time cleanup)
cd infra/terraform/bootstrap
terraform destroy
```
