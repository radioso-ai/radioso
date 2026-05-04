# Implementation Plan: Message Queue Support

**Branch**: `055-message-queue-support` | **Date**: 2026-05-03 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/055-message-queue-support/spec.md`

## Summary

Add AMQP 0-9-1 / RabbitMQ-compatible worker dispatch for document processing jobs. The implementation keeps PostgreSQL as the durable job source of truth, adds a broker publisher and consumer behind focused document infrastructure adapters, and wires defaults through backend composition/runtime so local polling and Cloud Tasks deployments keep their current behavior. AMQP mode intentionally remains an eventing plus polling hybrid: broker messages wake workers, while polling preserves recovery and scheduled retry handling through PostgreSQL `available_at`.

## Technical Context

**Language/Version**: TypeScript 5.9 on Node.js 22
**Primary Dependencies**: Express, Zod, Pino, PostgreSQL job repository, `amqplib` for AMQP 0-9-1 broker integration
**Storage**: PostgreSQL remains the durable system of record for jobs; RabbitMQ-compatible queue messages are wake-up notifications
**Testing**: Vitest unit tests with backend TDD; focused build validation
**Target Platform**: Linux/Node backend workers in self-hosted, Docker Compose, and cloud worker deployments
**Project Type**: Backend-only feature in existing web application repository
**Performance Goals**: Broker dispatch adds no database write to existing job creation and publishes one message per durable job dispatch attempt; consumer handles one message per delivery with configurable prefetch
**Constraints**: Existing no-op and Cloud Tasks behavior must remain unchanged; broker credentials stay in environment variables; scheduled retry eligibility remains enforced by PostgreSQL `available_at`
**Scale/Scope**: Document processing worker dispatch only; no generic event bus or product event streaming in this feature

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. **PASS**: `spec.md` is approved by delegated CEO scope review.
- Backend work includes TDD with failing tests written before implementation. **PASS**: Tasks require unit tests before adapter/runtime implementation.
- Frontend user-visible behavior is planned for Playwright coverage, and any frontend unit tests are limited to non-visual logic. **PASS**: No frontend or user-visible UI scope.
- Stack remains Node.js for backend and React for frontend. **PASS**: Backend remains Node.js/TypeScript.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. **PASS**: PostgreSQL job table remains authoritative.
- LLM provider is GPT-5.2 for AI integrations. **PASS**: No LLM integration changes.
- Secrets and keys are managed via `.env` and `.env.example` is updated. **PASS**: Broker URL is environment-only and `.env.example` must be updated.
- Customer data handling and auditability are addressed where applicable. **PASS**: Queue payload carries job identifiers only, not document content.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. **PASS**: Broker adapter stays in document infra; worker keeps job claim/process decisions.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. **PASS**: See Module Ownership & Seams.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. **PASS**: Existing dispatcher seam is sufficient; no broad refactor required.
- If backend work adds or replaces app-wide adapters, registries, sinks, lifecycle hooks, capability policies, storage/dispatcher implementations, or cross-module runtime infrastructure, the plan evaluates `backend/src/app/composition/` ownership and keeps domain rules in modules/shared domain files. **PASS**: Default dispatcher and consumer wiring belongs in composition/runtime.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. **PASS**: No HTTP API contract changes.
- If contracts, workflows, settings behavior, or user-visible functionality change, the plan identifies which docs must be updated in the same feature work. **PASS**: Update `.env.example`, `readme.md`, and worker/extension docs.

## Project Structure

### Documentation (this feature)

```text
specs/055-message-queue-support/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── document-job-message.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── package.json
├── package-lock.json
├── .env.example
├── src/
│   ├── app/
│   │   ├── config/env.ts
│   │   ├── composition/defaultComposition.ts
│   │   └── server/dependencies.ts
│   ├── modules/documents/
│   │   ├── infra/amqpDocumentJobQueue.ts
│   │   └── services/
│   │       ├── documentJobConsumer.ts
│   │       ├── documentJobDispatcher.ts
│   │       └── documentJobMessage.ts
│   └── runtime/
│       ├── startWorkerRuntime.ts
│       └── startWorkerTaskRuntime.ts
└── tests/unit/
    ├── amqp-document-job-queue.test.ts
    ├── default-composition.test.ts
    └── runtime-config.test.ts

docs/
└── architecture-extension-points.md

readme.md
```

**Structure Decision**: Implement a backend-only adapter addition. The documents module owns queue payload validation and broker adapters; application composition owns default adapter selection; runtime entrypoints own lifecycle start/stop of the optional consumer.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/modules/documents/infra/amqpDocumentJobQueue.ts` receives AMQP deliveries and translates payloads into calls on `DocumentProcessingWorker.runJobById`.
- **Orchestration Layer**: `DocumentProcessingWorker` remains responsible for claim, retry, skip, fail, and telemetry behavior.
- **Domain Layer**: `backend/src/modules/documents/services/documentJobMessage.ts` owns the stable queue payload shape and validation.
- **Persistence/Integration Layer**: `DocumentProcessingJobRepository` remains the job state authority; AMQP adapter owns broker connection/channel/publish/consume details.
- **Application Composition**: `backend/src/app/composition/defaultComposition.ts` selects no-op, Cloud Tasks, or AMQP dispatch and constructs the AMQP consumer for worker runtimes when configured.
- **Files Kept Small**: Do not add broker-specific code to `DocumentIngestionService`, `DocumentImportService`, `WorkspaceIngestionReprocessService`, `DocumentProcessingWorker`, or HTTP routes beyond stable port calls.
- **Planned Extractions**: Add `DocumentJobConsumerPort`; keep dispatcher and consumer interfaces separate so publish and consume lifecycle concerns stay explicit.
- **Required Refactor Stories**: None. Existing dispatcher port and composition seam are sufficient.

## Complexity Tracking

No constitution violations.

## Phase 0: Research

See [research.md](./research.md).

## Phase 1: Design & Contracts

- [data-model.md](./data-model.md) documents queue payload and configuration entities.
- [contracts/document-job-message.md](./contracts/document-job-message.md) documents the broker message contract.
- [quickstart.md](./quickstart.md) documents validation scenarios.
- No backend HTTP API contract changes are planned; generated OpenAPI outputs should not change.
- No backend runtime LLM prompt assets are planned.

## Post-Design Constitution Check

- Backend TDD remains explicit in `tasks.md`.
- Queue credentials are environment-only and documented in `.env.example`.
- Adapter selection and consumer lifecycle are assigned to composition/runtime, not product services.
- PostgreSQL remains authoritative; AMQP messages carry identifiers only and do not contain customer document content.
- Documentation updates are planned for setup and architecture extension points.
