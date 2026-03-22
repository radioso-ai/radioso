# Implementation Plan: Terraform GCP Deployment

**Branch**: `018-terraform-gcp-deploy` | **Date**: 2026-03-19 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/018-terraform-gcp-deploy/spec.md`

## Summary

Add Terraform infrastructure-as-code to provision and manage Hivec on Google Cloud Platform. The stack deploys two Cloud Run services (frontend + backend), a Cloud SQL PostgreSQL 16 instance with pgvector, VPC networking, Secret Manager for credentials, and Artifact Registry for container images. A separate bootstrap module creates the GCS state bucket. No application code is modified.

## Technical Context

**Language/Version**: HCL (Terraform >= 1.5)
**Primary Dependencies**: `hashicorp/google` provider (~> 5.x), `hashicorp/google-beta` provider (~> 5.x)
**Storage**: GCS bucket for Terraform remote state; Cloud SQL PostgreSQL 16 for application data
**Testing**: `terraform validate`, `terraform plan` (dry-run verification), manual smoke test against deployed stack
**Target Platform**: Google Cloud Platform (Cloud Run, Cloud SQL, Secret Manager, Artifact Registry, VPC)
**Project Type**: Infrastructure-as-code (no application code changes)
**Performance Goals**: Deployment completes in under 15 minutes; Cloud Run services respond within seconds of deployment
**Constraints**: Must not modify application code; must not introduce CI/CD pipeline; must not provision custom domains or GKE
**Scale/Scope**: Single environment (production); 2 Cloud Run services, 1 Cloud SQL instance, ~5 secrets, 1 VPC

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Spec exists and is approved**: PASS — spec at `specs/018-terraform-gcp-deploy/spec.md`, all clarifications resolved.
- **Backend work includes TDD**: N/A — this feature adds no backend application code. Terraform configs are validated via `terraform validate` and `terraform plan`.
- **Stack remains Node.js for backend and React for frontend**: PASS — no application stack changes. Terraform deploys the existing Node.js backend and React frontend containers as-is.
- **Database is PostgreSQL with pgvector**: PASS — Cloud SQL provisions PostgreSQL 16 with pgvector extension.
- **LLM provider is GPT-5.2**: N/A — no LLM integration changes. OpenAI API key is passed through Secret Manager.
- **Secrets managed via .env / .env.example**: PASS — production secrets live in GCP Secret Manager (not in code). Local `.env` workflow is unchanged. A `terraform.tfvars.example` will document required Terraform variables.
- **Customer data handling**: PASS — database accessible only via private VPC; Cloud Run services use IAM and private networking; secrets never appear in Terraform source.
- **Module boundaries explicit**: PASS — all Terraform lives in `infra/terraform/`, organized by concern. No application module boundaries are affected.
- **Responsibility-limited files identified**: PASS — `infra/docker-compose.yml` is not modified. No existing application files are touched.
- **No architecture/refactor stories needed**: PASS — greenfield infrastructure directory, no existing Terraform to refactor.

## Project Structure

### Documentation (this feature)

```text
specs/018-terraform-gcp-deploy/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── quickstart.md        # Phase 1 output - deployment guide
└── checklists/
    └── requirements.md  # Spec quality checklist
```

### Source Code (repository root)

```text
infra/
├── docker-compose.yml       # Existing - NOT modified
├── backend.Dockerfile       # Existing - NOT modified
├── terraform/
│   ├── bootstrap/
│   │   ├── main.tf          # GCS state bucket + versioning
│   │   ├── variables.tf     # Project ID, region, bucket name
│   │   └── outputs.tf       # Bucket name, bucket URL
│   ├── main.tf              # Provider config, backend block, module wiring
│   ├── variables.tf         # All tunable inputs
│   ├── outputs.tf           # Frontend URL, backend URL, DB connection, registry URL
│   ├── versions.tf          # Required providers and versions
│   ├── terraform.tfvars.example  # Documented variable template
│   ├── networking.tf        # VPC, subnet, VPC connector, private services access
│   ├── database.tf          # Cloud SQL instance, database, user, pgvector
│   ├── secrets.tf           # Secret Manager secrets (OpenAI key, session secret, etc.)
│   ├── registry.tf          # Artifact Registry repository
│   ├── compute.tf           # Cloud Run services (backend + frontend)
│   └── apis.tf              # google_project_service resources for required APIs
```

**Structure Decision**: Flat file layout within `infra/terraform/` organized by GCP concern. The bootstrap module is a separate directory with its own state. This keeps the config simple and navigable for a small-to-medium deployment without over-engineering into nested modules.

## Module Ownership & Seams

- **Transport Layer**: N/A — no application transport changes.
- **Orchestration Layer**: `main.tf` — wires together all resource files, sets provider config and backend.
- **Domain Layer**: Individual `.tf` files own one GCP concern each (networking, database, secrets, compute, registry, APIs).
- **Persistence/Integration Layer**: `database.tf` owns Cloud SQL lifecycle; `secrets.tf` owns Secret Manager; `registry.tf` owns Artifact Registry.
- **Files Kept Small**: Each `.tf` file owns a single concern. `main.tf` contains only provider/backend config and any cross-cutting locals.
- **Planned Extractions**: None needed — greenfield layout. If multi-environment support is added later, the flat files can be refactored into reusable modules.
- **Required Refactor Stories**: None — no existing Terraform code.

## Complexity Tracking

No constitution violations to justify. This is a greenfield infrastructure addition that does not touch application code.

---

## Implementation Phases

### Phase 0: Bootstrap & APIs

1. Create `infra/terraform/bootstrap/` with `main.tf`, `variables.tf`, `outputs.tf`
   - Provision GCS bucket with versioning enabled for state storage
   - Variables: `project_id`, `region`, `state_bucket_name`
2. Create `infra/terraform/versions.tf` — pin `hashicorp/google` and `hashicorp/google-beta` providers
3. Create `infra/terraform/apis.tf` — enable required GCP APIs:
   - `run.googleapis.com`
   - `sqladmin.googleapis.com`
   - `secretmanager.googleapis.com`
   - `artifactregistry.googleapis.com`
   - `vpcaccess.googleapis.com`
   - `servicenetworking.googleapis.com`
   - `compute.googleapis.com`

### Phase 1: Networking & Database

4. Create `infra/terraform/networking.tf`:
   - VPC network
   - Subnet
   - Private services access (for Cloud SQL)
   - Serverless VPC connector (for Cloud Run → Cloud SQL)
5. Create `infra/terraform/database.tf`:
   - Cloud SQL PostgreSQL 16 instance (configurable tier, e.g., `db-f1-micro` for dev, `db-custom-2-7680` for prod)
   - Database named `radioso`
   - Database user with generated password
   - pgvector extension via `google_sql_database` flags or post-deploy
   - Private IP only (no public IP)

### Phase 2: Secrets & Registry

6. Create `infra/terraform/secrets.tf`:
   - Secret Manager secrets for: `database-password`, `openai-api-key`, `session-cookie-secret`, `connector-encryption-key`
   - Secret versions populated from Terraform variables (marked `sensitive`)
   - IAM bindings granting Cloud Run service accounts `secretAccessor` role
7. Create `infra/terraform/registry.tf`:
   - Artifact Registry Docker repository
   - Output the repository URL for image push commands

### Phase 3: Compute (Cloud Run)

8. Create `infra/terraform/compute.tf`:
   - **Backend Cloud Run service**:
     - Image from Artifact Registry variable
     - Port 8080
     - Environment variables: `DATABASE_URL` (constructed from Cloud SQL outputs), secret references for `OPENAI_API_KEY`, `SESSION_COOKIE_SECRET`, `CONNECTOR_ENCRYPTION_KEY`
     - VPC connector for private Cloud SQL access
     - Min instances: 0 (configurable), Max instances: configurable
   - **Frontend Cloud Run service**:
     - Image from Artifact Registry variable
     - Port 3000
     - Environment variable: `NEXT_PUBLIC_API_URL` pointing to backend Cloud Run URL
     - Public access (allUsers invoker)
   - Backend also gets public access (or frontend-only, depending on connector webhook needs)

### Phase 4: Variables, Outputs & Documentation

9. Create `infra/terraform/variables.tf` — all inputs with descriptions, types, defaults where appropriate
10. Create `infra/terraform/outputs.tf` — frontend URL, backend URL, Cloud SQL connection name, Artifact Registry URL
11. Create `infra/terraform/main.tf` — provider block, backend block (GCS), locals
12. Create `infra/terraform/terraform.tfvars.example` — documented template
13. Create `specs/018-terraform-gcp-deploy/quickstart.md` — step-by-step deployment guide

### Dependency Graph

```
apis.tf
  └── networking.tf
        ├── database.tf
        │     └── secrets.tf (database password)
        └── compute.tf (needs VPC connector, secrets, database, registry)
  └── registry.tf
```

All resources depend on APIs being enabled first. Cloud Run depends on networking, database, secrets, and registry all being ready.
