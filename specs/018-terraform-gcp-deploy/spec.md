# Feature Specification: Terraform GCP Deployment

**Feature Branch**: `018-terraform-gcp-deploy`
**Created**: 2026-03-19
**Status**: Draft
**Input**: User description: "Add Terraform infrastructure-as-code for deploying Hivec to Google Cloud Platform"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Deploy Hivec to GCP from Scratch (Priority: P1)

A developer runs `terraform apply` against a fresh GCP project and gets a fully running Hivec instance — frontend reachable via HTTPS, backend API responding, database provisioned and migrated — without any manual console steps beyond initial GCP project setup and authentication.

**Why this priority**: Without a working end-to-end deployment, no other infrastructure story delivers value. This is the foundation.

**Independent Test**: Run `terraform apply` in an empty GCP project, then verify the frontend URL loads the login page and the backend health endpoint returns 200.

**Acceptance Scenarios**:

1. **Given** a GCP project with billing enabled and Terraform authenticated, **When** the developer runs `terraform init && terraform apply`, **Then** all GCP resources are provisioned and the application is accessible via a public HTTPS URL within 15 minutes.
2. **Given** a successful deployment, **When** a user visits the frontend URL, **Then** the Hivec login page loads and the backend API health check responds successfully.
3. **Given** a successful deployment, **When** the developer inspects the database, **Then** the pgvector extension is enabled and all migrations have been applied.

---

### User Story 2 - Update Deployment via Infrastructure Changes (Priority: P2)

A developer modifies a Terraform variable (e.g., container image tag, instance size, replica count) and runs `terraform apply`. The change is applied with zero or minimal downtime, and the running application reflects the update.

**Why this priority**: Ongoing deployments and scaling are the primary day-to-day use of the IaC. Without safe updates, the infrastructure code is only useful once.

**Independent Test**: Change the backend container image tag in `terraform.tfvars`, run `terraform apply`, and verify the new version is serving traffic.

**Acceptance Scenarios**:

1. **Given** a running deployment, **When** the developer updates the backend image tag and runs `terraform apply`, **Then** Cloud Run deploys the new revision and routes traffic to it.
2. **Given** a running deployment, **When** the developer changes the frontend replica count, **Then** the change applies without service interruption.

---

### User Story 3 - Tear Down Infrastructure Cleanly (Priority: P3)

A developer runs `terraform destroy` and all GCP resources created by Terraform are removed. No orphaned resources remain, and no resources outside the Terraform state are affected.

**Why this priority**: Clean teardown is essential for cost management and for ephemeral/staging environments.

**Independent Test**: After `terraform destroy`, verify via GCP console or `gcloud` CLI that no Hivec resources remain in the project.

**Acceptance Scenarios**:

1. **Given** a fully deployed Hivec stack, **When** the developer runs `terraform destroy`, **Then** all managed resources are removed and the GCP project has no lingering Hivec-related resources.
2. **Given** a partially failed deployment, **When** the developer runs `terraform destroy`, **Then** Terraform removes whatever was created without errors.

---

### Edge Cases

- What happens when Terraform apply is interrupted mid-way (e.g., network failure)? Terraform state should allow safe re-run.
- What happens when the GCP project has API quotas that block resource creation? Terraform should surface clear error messages.
- What happens when the database already exists (e.g., re-applying after manual changes)? Terraform should detect drift and reconcile.
- What happens when container images referenced in variables don't exist in the registry? Deployment should fail fast with a clear error.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: All Terraform configuration lives in `infra/terraform/`. Application code (backend, frontend, packages) is not modified. The Terraform module owns GCP resource lifecycle; the existing Dockerfiles own container build.
- **Encapsulation Rule**: `infra/docker-compose.yml` remains the local development tool — Terraform does not replace or modify it. The two systems are independent.
- **New Seams Required**:
  - A `infra/terraform/` directory containing all `.tf` files, organized by concern (networking, compute, database, secrets).
  - A `infra/terraform/variables.tf` providing all tunable inputs (GCP project, region, image tags, instance sizes).
  - A `infra/terraform/outputs.tf` exposing key values (frontend URL, backend URL, database connection info).
- **Anti-Goals**:
  - Do not embed application configuration (environment variables, feature flags) directly in Terraform — use Secret Manager references and Cloud Run environment variable mappings.
  - Do not create a CI/CD pipeline as part of this feature — that is a separate concern.
  - Do not provision a custom domain or DNS — use the default Cloud Run URLs initially.
  - Do not add Kubernetes or GKE — Cloud Run is the target compute platform for simplicity.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provision a Cloud SQL for PostgreSQL 16 instance with the `pgvector` extension enabled via Terraform.
- **FR-002**: System MUST deploy the backend container to Cloud Run, configured with environment variables for database connection, OpenAI API key (from Secret Manager), and session secret (from Secret Manager).
- **FR-003**: System MUST deploy the frontend container to Cloud Run, configured to communicate with the backend service URL.
- **FR-004**: System MUST create a VPC with private services access so Cloud Run can reach Cloud SQL over a private network.
- **FR-005**: System MUST store sensitive values (OpenAI API key, session cookie secret, connector encryption key, database password) in GCP Secret Manager, referenced by Cloud Run services.
- **FR-006**: System MUST create an Artifact Registry repository for storing Docker images for both frontend and backend.
- **FR-007**: System MUST use Terraform variables for all environment-specific values: GCP project ID, region, image tags, database tier, and Cloud Run scaling parameters.
- **FR-008**: System MUST produce Terraform outputs for: frontend URL, backend URL, Cloud SQL instance connection name, and Artifact Registry repository URL.
- **FR-009**: System MUST enable only the required GCP APIs (Cloud Run, Cloud SQL, Secret Manager, Artifact Registry, VPC Access) via Terraform.
- **FR-010**: System MUST use remote state storage in a GCS bucket (configured via backend block) to support team collaboration. A separate bootstrap Terraform module MUST create the GCS state bucket before the main infrastructure is applied, resulting in a two-step deploy process: bootstrap first, then main apply.

### Key Entities

- **GCP Project**: The target Google Cloud project where all resources are deployed. Provided as a variable.
- **Cloud Run Service**: A managed container instance. Two exist: one for the backend (port 8080) and one for the frontend (port 3000).
- **Cloud SQL Instance**: A managed PostgreSQL 16 database with pgvector. Single instance with configurable tier.
- **Secret Manager Secret**: A GCP-managed secret holding a sensitive value. Multiple secrets are created (one per sensitive env var).
- **Artifact Registry Repository**: A Docker image repository in GCP for storing built container images.
- **VPC / VPC Connector**: Networking resources enabling private connectivity between Cloud Run and Cloud SQL.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer with GCP access can deploy Hivec from zero to a working HTTPS-accessible instance in under 15 minutes using only `terraform apply`.
- **SC-002**: All sensitive values (API keys, database credentials, session secrets) are stored in GCP Secret Manager — none appear in Terraform state as plaintext or in source code.
- **SC-003**: Running `terraform plan` on an already-deployed stack with no config changes shows zero resource changes (idempotency).
- **SC-004**: A developer can update the backend or frontend container image and have the new version serving traffic within 5 minutes of `terraform apply`.
- **SC-005**: `terraform destroy` removes all created GCP resources with no manual cleanup required.

## Assumptions

- The GCP project already exists with billing enabled.
- The developer has authenticated via `gcloud auth application-default login` or a service account key.
- Docker images are built and pushed to Artifact Registry separately (out of scope for Terraform).
- Database migrations are run by the application on startup (as currently designed), not by Terraform.
- A single environment (production) is targeted initially; multi-environment support (staging, dev) is a future enhancement.
- Default Cloud Run URLs are sufficient; custom domain setup is out of scope.
