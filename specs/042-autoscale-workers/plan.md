# Implementation Plan: Autoscaled Workers

**Branch**: `042-autoscale-workers` | **Date**: 2026-04-16 | **Spec**: [/Users/dm/conductor/workspaces/radioso/louisville/specs/042-autoscale-workers/spec.md](/Users/dm/conductor/workspaces/radioso/louisville/specs/042-autoscale-workers/spec.md)
**Input**: Feature specification from `/specs/042-autoscale-workers/spec.md`

## Summary

Keep PostgreSQL as the durable source of truth for document-processing jobs, but replace production worker wake-up with request-driven dispatch so Cloud Run can scale the worker service from zero. The backend will enqueue durable jobs exactly as it does today, then dispatch worker requests through Cloud Tasks when configured. A dedicated worker HTTP runtime will process one job per request, reclaim stale claims after a bounded lease window, and rely on the durable job row for idempotency. Local development will keep the existing polling worker path so Docker and host workflows remain simple. Chat remains on the backend service, with Terraform exposing independent scaling bounds for backend-serving and worker-serving capacity.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24
**Primary Dependencies**: Express, `pg`, Zod, Pino, Vitest, Supertest, `@google-cloud/tasks`, existing local connector/document packages  
**Storage**: PostgreSQL 16 with `pgvector`; existing `document_processing_jobs`, `documents`, `chunks`, and audit events; Google Cloud Tasks for delivery only  
**Testing**: Vitest unit and integration tests, existing persistence/runtime regression coverage  
**Target Platform**: Linux container runtime on Cloud Run plus host/Docker local development  
**Project Type**: Web application with `backend/`, `frontend/`, and Terraform infrastructure  
**Performance Goals**: Worker service can scale above one instance under queued backlog, scale back toward zero when idle, and keep mixed-load chat latency within the approved success criteria  
**Constraints**: Preserve existing document status semantics; no new public customer-facing HTTP API; backend TDD required; local workflows must continue to support polling workers without Cloud Tasks configuration  
**Scale/Scope**: One backend-serving service plus one worker-serving service, with durable document jobs and request-driven worker task dispatch for production

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec.
- Backend work includes TDD with failing tests written before implementation.
- Stack remains Node.js for backend and React for frontend.
- Database remains PostgreSQL with `pgvector`.
- LLM provider defaults remain unchanged.
- Secrets and keys stay in `.env` and `.env.example`; new runtime config will be documented there.
- Customer data handling remains account/workspace-scoped; worker dispatch will carry only job identifiers and workspace/revision metadata, not raw document content.
- Module boundaries are explicit: routes/runtime apps stay orchestration-only, document processing stays in focused document services, job state remains in repositories, dispatch integration stays in a dedicated delivery seam.
- `backend/src/app/server/createApp.ts`, route handlers, and `backend/src/modules/chat/services/chatService.ts` remain responsibility-limited.
- No public backend HTTP contract changes are planned; internal worker routes will live in a dedicated worker runtime rather than the customer-facing API app, so no code-first OpenAPI changes are required.
- Runtime behavior and operator configuration change, so docs and environment examples must be updated in the same change.

**Post-design check**: Pass. The design introduces dedicated dispatch and worker-runtime seams instead of expanding existing HTTP routes or overloading the chat service.

## Project Structure

### Documentation (this feature)

```text
specs/042-autoscale-workers/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/
│   │   ├── config/
│   │   ├── server/
│   │   └── worker/                  # new internal worker HTTP app
│   ├── db/repositories/
│   ├── modules/documents/
│   │   ├── services/                # dispatch + task handling seams
│   │   └── infra/                   # Cloud Tasks integration
│   ├── runtime/
│   ├── documentWorker.ts            # existing polling worker for local/dev fallback
│   └── documentWorkerServer.ts      # new request-driven worker runtime
├── tests/
└── package.json

infra/
├── docker-compose.yml
├── docker-compose.dev.yml
└── terraform/
    ├── apis.tf
    ├── compute.tf
    ├── outputs.tf
    ├── queue.tf                     # new Cloud Tasks resources
    └── variables.tf
```

**Structure Decision**: Preserve the existing API runtime untouched for customer-facing routes. Add a dedicated worker HTTP composition seam under `backend/src/app/worker/` for internal task processing, a focused document-job dispatch seam under `backend/src/modules/documents/`, and explicit Terraform queue resources under `infra/terraform/`. The polling worker remains the local fallback and regression safety harness, while the worker HTTP runtime owns production request handling.

## Module Ownership & Seams

- **Transport Layer**:
  - `backend/src/app/http/routes/*` for customer-facing APIs
  - new `backend/src/app/worker/*` for internal worker task HTTP handling only
- **Orchestration Layer**:
  - `backend/src/runtime/*`
  - `DocumentIngestionService`, `DocumentImportService`, and `WorkspaceIngestionReprocessService` orchestrate queueing plus dispatch
  - new single-job worker task handler orchestrates claim, process, retry, and completion
- **Domain Layer**:
  - `DocumentProcessingService`
  - `DocumentProcessingWorker` for local polling semantics
  - new dispatch/task handler modules for allocation, lease recovery, and idempotent processing flow
- **Persistence/Integration Layer**:
  - `DocumentRepository`
  - `DocumentProcessingJobRepository`
  - new Cloud Tasks dispatch client
  - Terraform Cloud Run and Cloud Tasks resources
- **Files Kept Small**:
  - `backend/src/app/server/createApp.ts`
  - `backend/src/modules/chat/services/chatService.ts`
  - `backend/src/modules/documents/services/documentProcessingWorker.ts`
- **Planned Extractions**:
  - document-job dispatch port + implementations
  - job-by-id claim/recovery repository methods
  - worker task app/runtime entrypoint
  - Terraform queue and scaling configuration seams
- **Required Refactor Stories**:
  - Extract shared single-job execution logic so polling and request-driven runtimes reuse the same processing rules instead of forking behavior.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Cloud Tasks delivery integration | Cloud Run autoscaling requires request-driven work delivery to scale worker instances from zero | Keeping only the polling worker cannot autoscale from queued DB rows alone |
