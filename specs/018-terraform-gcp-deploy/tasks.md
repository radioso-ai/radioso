# Tasks: Terraform GCP Deployment

**Input**: Design documents from `/specs/018-terraform-gcp-deploy/`
**Prerequisites**: plan.md, spec.md, research.md, quickstart.md

**Tests**: Not applicable — this is an IaC feature. Validation is via `terraform validate` and `terraform plan`.

**Organization**: Tasks grouped by deployment concern, mapped to user stories. US1 (deploy from scratch) spans most phases since it requires all resources. US2 (update) and US3 (teardown) are validated by configuration choices made during US1.

**Cost Note**: All compute uses Cloud Run min instances = 0 and Cloud SQL `db-f1-micro` by default. Configurable via variables.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Bootstrap state management and project scaffolding

- [ ] T001 Create `infra/terraform/bootstrap/main.tf` — GCS bucket with versioning for Terraform remote state, using local backend
- [ ] T002 [P] Create `infra/terraform/bootstrap/variables.tf` — inputs: `project_id`, `region`, `state_bucket_name`
- [ ] T003 [P] Create `infra/terraform/bootstrap/outputs.tf` — outputs: `state_bucket_name`, `state_bucket_url`
- [ ] T004 Create `infra/terraform/versions.tf` — pin `hashicorp/google` ~> 5.x and `hashicorp/google-beta` ~> 5.x, require Terraform >= 1.5
- [ ] T005 Create `infra/terraform/main.tf` — provider config (project, region), GCS backend block, locals
- [ ] T006 Create `infra/terraform/variables.tf` — all tunable inputs with descriptions, types, defaults, and `sensitive` markers
- [ ] T007 [P] Create `infra/terraform/terraform.tfvars.example` — documented variable template with placeholder values

**Checkpoint**: `terraform init` succeeds in both `bootstrap/` and `infra/terraform/`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Enable GCP APIs and networking that all resources depend on

**⚠️ CRITICAL**: No compute, database, or secret resources can be created until APIs and networking are in place

- [ ] T008 Create `infra/terraform/apis.tf` — enable required GCP APIs: `run.googleapis.com`, `sqladmin.googleapis.com`, `secretmanager.googleapis.com`, `artifactregistry.googleapis.com`, `vpcaccess.googleapis.com`, `servicenetworking.googleapis.com`, `compute.googleapis.com`
- [ ] T009 Create `infra/terraform/networking.tf` — VPC network, subnet, private services access (google_service_networking_connection), serverless VPC connector for Cloud Run → Cloud SQL

**Checkpoint**: `terraform validate` passes; `terraform plan` shows API and networking resources

---

## Phase 3: User Story 1 — Deploy Hivec to GCP from Scratch (Priority: P1) 🎯 MVP

**Goal**: `terraform apply` against a fresh GCP project provisions a fully running Hivec instance — frontend via HTTPS, backend API responding, database with pgvector.

**Independent Test**: Run `terraform apply` in an empty GCP project, visit frontend URL, hit backend `/health`.

### Implementation for User Story 1

- [ ] T010 [P] [US1] Create `infra/terraform/database.tf` — Cloud SQL PostgreSQL 16 instance (`db-f1-micro` default), database `radioso`, user with generated password, `cloudsql.enable_pgvector` flag, private IP only, no public IP
- [ ] T011 [P] [US1] Create `infra/terraform/registry.tf` — Artifact Registry Docker repository in same region as Cloud Run
- [ ] T012 [P] [US1] Create `infra/terraform/secrets.tf` — Secret Manager secrets for `database-password`, `openai-api-key`, `session-cookie-secret`, `connector-encryption-key`; secret versions from sensitive variables; IAM bindings granting Cloud Run SA `secretAccessor`
- [ ] T013 [US1] Create `infra/terraform/compute.tf` — Backend Cloud Run service: image from variable, port 8080, `DATABASE_URL` env var constructed from Cloud SQL outputs, secret references for `OPENAI_API_KEY`/`SESSION_COOKIE_SECRET`/`CONNECTOR_ENCRYPTION_KEY`, VPC connector, min instances 0, max instances configurable, public invoker access
- [ ] T014 [US1] Add frontend Cloud Run service to `infra/terraform/compute.tf` — image from variable, port 3000, `NEXT_PUBLIC_API_URL` env var pointing to backend URL, public invoker access (allUsers), min instances 0
- [ ] T015 [US1] Create `infra/terraform/outputs.tf` — outputs: `frontend_url`, `backend_url`, `cloud_sql_connection_name`, `artifact_registry_url`

**Checkpoint**: `terraform plan` shows complete resource set; `terraform apply` deploys a working stack

---

## Phase 4: User Story 2 — Update Deployment via Infrastructure Changes (Priority: P2)

**Goal**: Modify a Terraform variable (image tag, replica count) and `terraform apply` updates the running app with zero/minimal downtime.

**Independent Test**: Change `backend_image` tag in `terraform.tfvars`, run `terraform apply`, verify new version serves traffic.

### Implementation for User Story 2

- [ ] T016 [US2] Verify `infra/terraform/variables.tf` has separate `backend_image` and `frontend_image` variables so image tags can be updated independently
- [ ] T017 [US2] Verify Cloud Run services in `infra/terraform/compute.tf` use rolling update strategy (Cloud Run default) — no additional config needed, but confirm no `traffic` block overrides prevent gradual rollout

**Checkpoint**: Changing an image tag variable and running `terraform plan` shows only the expected Cloud Run revision change

---

## Phase 5: User Story 3 — Tear Down Infrastructure Cleanly (Priority: P3)

**Goal**: `terraform destroy` removes all GCP resources with no orphans.

**Independent Test**: After `terraform destroy`, verify via `gcloud` that no Hivec resources remain.

### Implementation for User Story 3

- [ ] T018 [US3] Add `deletion_protection = false` to Cloud SQL instance in `infra/terraform/database.tf` (with variable to enable in prod) so `terraform destroy` can remove it
- [ ] T019 [US3] Ensure `infra/terraform/registry.tf` uses `force_delete = true` (or variable-controlled) so Artifact Registry can be destroyed even with images present
- [ ] T020 [US3] Verify all resources in all `.tf` files have no lifecycle rules that prevent destruction; run `terraform plan -destroy` to confirm clean teardown

**Checkpoint**: `terraform destroy` completes with no errors; `gcloud` shows no lingering resources

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, validation, and hardening

- [ ] T021 [P] Run `terraform validate` and `terraform fmt` across all `.tf` files; fix any issues
- [ ] T022 [P] Verify `terraform.tfvars.example` includes all variables with clear comments
- [ ] T023 Update `specs/018-terraform-gcp-deploy/quickstart.md` if any steps changed during implementation
- [ ] T024 Run `terraform plan` with example values and verify zero errors and expected resource count

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (needs `versions.tf`, `main.tf`, `variables.tf`)
- **User Story 1 (Phase 3)**: Depends on Phase 2 (needs APIs enabled, networking in place)
  - T010, T011, T012 can run in parallel (database, registry, secrets are independent)
  - T013 depends on T010 (database outputs) and T012 (secret references) and T009 (VPC connector)
  - T014 depends on T013 (backend URL needed for frontend env var)
  - T015 depends on T013, T014 (needs all resource references for outputs)
- **User Story 2 (Phase 4)**: Depends on Phase 3 (verifies update workflow against existing configs)
- **User Story 3 (Phase 5)**: Depends on Phase 3 (verifies teardown of created resources)
- **Polish (Phase 6)**: Depends on all prior phases

### Parallel Opportunities

- T002, T003 in parallel (bootstrap vars and outputs)
- T004, T005, T006, T007 partially parallelizable (versions.tf and tfvars.example independent; main.tf and variables.tf interrelated)
- T008, T009 sequential (networking depends on APIs)
- T010, T011, T012 in parallel (different files, no dependencies)
- T016, T017 in parallel (different verification tasks)
- T021, T022 in parallel (different files)

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup — bootstrap + scaffolding
2. Complete Phase 2: Foundational — APIs + networking
3. Complete Phase 3: US1 — database, secrets, registry, compute, outputs
4. **STOP and VALIDATE**: `terraform apply` in a test GCP project
5. Verify frontend loads, backend responds, database has pgvector

### Incremental Delivery

1. Setup + Foundational → scaffolding ready
2. Add US1 → working deployment (MVP!)
3. Add US2 → verified update workflow
4. Add US3 → verified clean teardown
5. Polish → formatted, documented, validated
