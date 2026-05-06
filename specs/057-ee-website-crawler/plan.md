# Implementation Plan: Enterprise Website Crawler Provider

**Branch**: `057-ee-website-crawler` | **Date**: 2026-05-06 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/057-ee-website-crawler/spec.md`

## Summary

Build the first Enterprise-only website crawler provider seam. The implementation will add crawler-specific contracts, a provider-agnostic Enterprise composition hook, generic limit configuration, publication service, and an EE route under `ee/packages/backend-module`. Crawled pages will be written through existing Radioso document ingestion with stable external document IDs and source metadata. OSS composition and domain modules will not gain crawler-specific hooks.

## Technical Context

**Language/Version**: TypeScript on Node.js 22
**Primary Dependencies**: Existing Enterprise backend module, Express, Zod, existing Radioso document ingestion service
**Storage**: Existing PostgreSQL-backed Radioso documents and document processing jobs only; no new crawler tables in this slice
**Testing**: Vitest and Supertest in `ee/packages/backend-module`, plus existing backend composition tests
**Target Platform**: Enterprise backend module running inside the existing Radioso backend runtime
**Project Type**: Web application backend module
**Performance Goals**: First slice is request-driven and bounded by page limit; default limits must avoid unbounded provider calls
**Constraints**: No OSS crawler-specific composition hook; no direct chunk/embedding writes; no provider secret leakage; no queue payload change
**Scale/Scope**: One Enterprise provider port, one provider-agnostic Enterprise module hook, one publication service, one optional EE route surface

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. PASS.
- Backend work includes TDD with failing tests written before implementation. PASS: tasks require EE Vitest/Supertest tests first.
- Frontend user-visible behavior is planned for Playwright coverage, and any frontend unit tests are limited to non-visual logic. PASS: no frontend work.
- Stack remains Node.js for backend and React for frontend. PASS.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. PASS: existing storage only.
- LLM provider is GPT-5.2 for AI integrations. PASS: no LLM integration.
- Secrets and keys are managed via `.env` and `.env.example` is updated. PASS: new EE env vars documented.
- Customer data handling and auditability are addressed where applicable. PASS: route uses existing workspace auth and audit service.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. PASS.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. PASS.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. PASS: structure is clear; no refactor story required.
- If backend work adds or replaces app-wide adapters, registries, sinks, lifecycle hooks, capability policies, storage/dispatcher implementations, or cross-module runtime infrastructure, the plan evaluates `backend/src/app/composition/` ownership and keeps domain rules in modules/shared domain files. PASS: no OSS composition changes; EE route mount uses existing generic extension point.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. PASS: EE internal route is not part of OSS OpenAPI in this slice.
- If public APIs, SDK contracts, MCP contracts, connector contracts, worker payloads, or other cross-service contracts change, the plan includes a message-queue impact review covering document worker dispatch, AMQP queue payloads, retry semantics, queue tests, and queue docs. PASS: no queue contract change.
- If contracts, workflows, settings behavior, or user-visible functionality change, the plan identifies which docs must be updated in the same feature work. PASS: `.env.example` and `ee/readme.md`.

## Project Structure

### Documentation (this feature)

```text
specs/057-ee-website-crawler/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── ee-website-crawler.md
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
ee/packages/backend-module/
├── src/
│   ├── index.ts
│   ├── radiosoModuleTypes.ts
│   └── websiteCrawler/
│       ├── config.ts
│       ├── errors.ts
│       ├── provider.ts
│       ├── routes.ts
│       ├── service.ts
│       ├── config.test.ts
│       ├── routes.test.ts
│       └── service.test.ts
├── package.json
└── tsconfig.json

backend/
└── tests/unit/default-composition.test.ts

.env.example
ee/readme.md
```

**Structure Decision**: Put every crawler-specific contract and implementation under `ee/packages/backend-module/src/websiteCrawler/`. The existing Enterprise `index.ts` only registers the route mount. OSS composition remains unchanged except for tests proving it has no crawler hook.

## Module Ownership & Seams

- **Transport Layer**: `ee/packages/backend-module/src/websiteCrawler/routes.ts` validates request payloads, resolves workspace session through existing dependencies, and delegates to the service.
- **Orchestration Layer**: `ee/packages/backend-module/src/websiteCrawler/service.ts` coordinates provider invocation, page deduplication, document ingestion publication, audit events, and operation result assembly.
- **Domain Layer**: `ee/packages/backend-module/src/websiteCrawler/provider.ts`, `config.ts`, and `errors.ts` define crawler provider types, generic limit rules, stable external identity construction, and safe error behavior.
- **Persistence/Integration Layer**: A caller-supplied `WebsiteCrawlerProvider` performs concrete crawl work; existing Radioso `documentIngestionService` persists documents and jobs.
- **Application Composition**: No `backend/src/app/composition/` changes. EE uses only the existing generic `registerRouteMount` extension point and exposes `createEnterpriseBackendModule({ websiteCrawlerProvider })` as the EE-owned composition hook.
- **Files Kept Small**: `ee/packages/backend-module/src/index.ts` remains a registration file only. `backend/src/app/composition/applicationModule.ts` and `defaultComposition.ts` remain crawler-agnostic. `backend/src/modules/documents/` remains document ingestion/processing only.
- **Planned Extractions**: New Enterprise website crawler folder with provider port, config resolver, route, service, and tests.
- **Required Refactor Stories**: None.

## Complexity Tracking

No constitution violations.

## Phase 0 Research

See [research.md](./research.md).

## Phase 1 Design

See [data-model.md](./data-model.md), [contracts/ee-website-crawler.md](./contracts/ee-website-crawler.md), and [quickstart.md](./quickstart.md).

## Message-Queue Impact Review

No document worker dispatch payload, AMQP queue payload, retry semantic, queue test, or queue documentation change is required. Website crawler publication enters through `documentIngestionService.ingest`, which already creates document processing jobs and uses the configured document job dispatcher.

## OpenAPI Ownership

The first route is Enterprise-internal and mounted by the EE backend module. It is not added to the OSS code-first OpenAPI registry in `backend/src/app/http/openapi/document.ts`, and generated `backend/openapi.yaml` / `backend/openapi.json` are not edited.

## Post-Design Constitution Check

PASS. The design preserves the EE-only crawler boundary, uses existing document ingestion, avoids OSS composition changes, includes backend TDD tasks, documents configuration, and confirms no queue contract changes.
