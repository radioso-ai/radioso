# Research: Terraform GCP Deployment

**Feature**: 018-terraform-gcp-deploy
**Date**: 2026-03-19

## R1: Cloud Run for containerized web services

**Decision**: Use Cloud Run (fully managed) for both frontend and backend containers.
**Rationale**: Cloud Run provides serverless container hosting with HTTPS out of the box, automatic scaling, and pay-per-use pricing. It directly supports the existing Dockerfiles without modification. No cluster management overhead.
**Alternatives considered**:
- GKE (Google Kubernetes Engine) — rejected per spec anti-goal; overkill for 2 services
- Compute Engine VMs — rejected; requires manual scaling, patching, and load balancer setup
- Cloud Run on GKE — rejected; adds K8s complexity without benefit at this scale

## R2: Cloud SQL for managed PostgreSQL with pgvector

**Decision**: Use Cloud SQL for PostgreSQL 16 with the `pgvector` extension via database flags.
**Rationale**: Cloud SQL is GCP's managed PostgreSQL offering. It supports pgvector natively via the `cloudsql.enable_pgvector` database flag. Handles backups, patching, and high availability. Private IP connectivity keeps the database off the public internet.
**Alternatives considered**:
- AlloyDB — higher performance but significantly more expensive; not needed at current scale
- Self-managed PostgreSQL on Compute Engine — rejected; operational overhead for backups, failover, patching
- Cloud SQL for PostgreSQL 15 — rejected; the app requires PostgreSQL 16

## R3: Private networking between Cloud Run and Cloud SQL

**Decision**: Use VPC with Private Services Access + Serverless VPC Connector.
**Rationale**: Cloud SQL private IP requires a VPC with private services access. Cloud Run connects to the VPC via a Serverless VPC Connector. This keeps database traffic off the public internet and avoids the need for Cloud SQL Auth Proxy sidecar containers.
**Alternatives considered**:
- Cloud SQL Auth Proxy as a sidecar — adds container complexity; unnecessary with private IP + VPC connector
- Public IP with authorized networks — less secure; exposes database to internet
- Direct VPC egress (Cloud Run v2) — newer feature, may not be GA in all regions; VPC connector is well-established

## R4: Secret management approach

**Decision**: Use GCP Secret Manager with Cloud Run secret volume mounts / environment variable references.
**Rationale**: Secret Manager is GCP's native secrets service. Cloud Run has first-class support for mounting secrets as environment variables. Secrets never appear in Terraform source or state as plaintext (Terraform marks them `sensitive`). IAM controls who can access each secret.
**Alternatives considered**:
- Terraform `sensitive` variables only (no Secret Manager) — rejected; secrets would appear in state file
- HashiCorp Vault — rejected; additional service to manage; overkill for current scale
- Encrypted `.env` files in GCS — rejected; no audit trail, no versioning, no IAM integration

## R5: Terraform state management

**Decision**: Separate bootstrap module creates a GCS bucket with versioning; main config uses it as backend.
**Rationale**: The bootstrap module resolves the chicken-and-egg problem (Terraform needs a bucket to store state, but can't create the bucket using remote state). Versioning on the bucket provides state rollback capability. Object locking prevents concurrent modifications.
**Alternatives considered**:
- Manual bucket creation — rejected per user preference (Option B in spec clarification)
- Local state only — rejected; no team collaboration, risk of state loss
- Terraform Cloud — rejected; adds external dependency and potential cost

## R6: Artifact Registry for container images

**Decision**: Use Artifact Registry (Docker format) in the same GCP region as Cloud Run.
**Rationale**: Artifact Registry is GCP's recommended container registry (replacing Container Registry). Co-locating with Cloud Run minimizes image pull latency. IAM integration controls push/pull access.
**Alternatives considered**:
- Container Registry (gcr.io) — deprecated in favor of Artifact Registry
- Docker Hub — rejected; adds external dependency, egress costs, and rate limits
- GitHub Container Registry — rejected; adds cross-cloud dependency

## R7: pgvector extension enablement on Cloud SQL

**Decision**: Enable pgvector via Cloud SQL database flags (`cloudsql.enable_pgvector = on`) and then create the extension via the application's existing migration (which runs `CREATE EXTENSION IF NOT EXISTS vector`).
**Rationale**: Cloud SQL requires the database flag to make pgvector available, but the actual `CREATE EXTENSION` is handled by the app's existing migration SQL. This keeps Terraform focused on infrastructure and the app responsible for its own schema.
**Alternatives considered**:
- Terraform `google_sql_database` with provisioner to run SQL — rejected; mixes infrastructure and application concerns
- Separate Terraform provider for PostgreSQL DDL — rejected; application migrations already handle this
