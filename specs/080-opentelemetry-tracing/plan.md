# Implementation Plan: OpenTelemetry Tracing

**Branch**: `opentelemetry-implementation` | **Date**: 2026-06-05 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/080-opentelemetry-tracing/spec.md`

## Summary

Add optional backend OpenTelemetry tracing for Radioso API and worker runtimes using a shared observability substrate. The implementation will initialize OpenTelemetry early, use async-hooks context propagation for in-process span parenting, expose narrow span helpers to domain modules, emit privacy-safe spans for HTTP/chat/retrieval/document/connector/provider boundaries, add debug-only turn-trace correlation, and document local and production operation without replacing existing logs, metrics, audit events, analytics, or errors.

## Technical Context

**Language/Version**: TypeScript on Node.js 24  
**Primary Dependencies**: Express, Pino, Zod, OpenTelemetry Node SDK, OpenTelemetry async-hooks context manager, OTLP trace exporter  
**Storage**: PostgreSQL remains system of record; no new persistence  
**Testing**: Vitest, Supertest, focused backend unit/integration tests, existing local CI  
**Target Platform**: Node.js backend services and worker runtimes  
**Project Type**: Monorepo web application with backend-focused feature scope  
**Performance Goals**: With tracing enabled and exporting to a healthy local collector, representative chat/retrieval and document-processing flows should stay within 5% median and 10% p95 latency overhead versus tracing disabled  
**Constraints**: Tracing disabled by default; collector/export failures must not break product paths; no raw prompts, completions, chunks, document text, credentials, tokens, cookies, full connection strings, or unrestricted SQL parameters in spans  
**Scale/Scope**: API, document worker, document worker task server, crawler worker, crawler worker task server; API-mounted MCP requests are traced under the API role; standalone MCP package tracing is out of scope

## Constitution Check

- Spec exists and is approved; no implementation without spec. PASS
- Backend work includes TDD with failing tests written before implementation. PASS: tasks require tests before implementation.
- Frontend user-visible behavior is planned for Playwright coverage, and any frontend unit tests are limited to non-visual logic. PASS: no frontend UI or browser tracing in scope.
- Stack remains Node.js for backend and React for frontend. PASS
- Database is PostgreSQL with `pgvector` for embeddings and vector search. PASS: no storage change.
- LLM provider is GPT-5.2 for AI integrations. PASS: provider calls are traced, not changed.
- Secrets and keys are managed via `.env` and `.env.example` is updated. PASS: env example/docs tasks included.
- Customer data handling and auditability are addressed where applicable. PASS: trace attribute policy and redaction tests are foundational.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. PASS
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. PASS
- If backend work adds or replaces app-wide adapters, registries, sinks, lifecycle hooks, capability policies, storage/dispatcher implementations, or cross-module runtime infrastructure, the plan evaluates `backend/src/app/composition/` ownership and keeps domain rules in modules/shared domain files. PASS: composition wires lifecycle only.
- If backend HTTP contracts change, the plan identifies updates required in the code-first OpenAPI registry and treats generated OpenAPI artifacts as generated outputs. PASS: additive debug-only envelope field requires schema/contract updates if exposed.
- If public APIs, SDK contracts, MCP contracts, connector contracts, worker payloads, or other cross-service contracts change, the plan includes a message-queue impact review covering document worker dispatch, AMQP queue payloads, retry semantics, queue tests, and queue docs. PASS: no worker payload change planned; review task included.
- If contracts, workflows, settings behavior, or user-visible functionality change, the plan identifies which docs must be updated in the same feature work. PASS

## Project Structure

### Documentation (this feature)

```text
specs/080-opentelemetry-tracing/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code

```text
backend/
├── package.json
├── src/
│   ├── app/config/env.ts
│   ├── app/composition/
│   ├── app/server/
│   ├── app/http/openapi/schemas/
│   ├── modules/chat/
│   ├── modules/retrieval/
│   ├── modules/documents/
│   ├── modules/connectors/
│   └── shared/observability/
│       ├── telemetry/
│       └── tracing/
└── tests/
    ├── unit/
    └── integration/

docs/
└── oss-saas-observability.md
```

**Structure Decision**: Backend tracing lives under `backend/src/shared/observability/tracing/`. Runtime entrypoints and application composition wire lifecycle and role metadata. Domain modules call shared span helpers and never import exporter-specific code.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/server/createApp.ts`, worker task app files, and HTTP routes create request boundaries only. They do not own chat, retrieval, document, connector, or provider span semantics.
- **Orchestration Layer**: `backend/src/runtime/*` owns startup/shutdown sequencing; `backend/src/app/server/dependencyBuilders.ts` and `backend/src/app/composition/` own default wiring and lifecycle hooks.
- **Domain Layer**: Chat, retrieval, documents, crawler, and connector modules decide where product-relevant spans begin/end and provide bounded attributes.
- **Persistence/Integration Layer**: Provider clients, connector clients, queue adapters, and selected database adapters may add transport/detail spans, but must redact sensitive values.
- **Application Composition**: Must wire the tracing lifecycle, service metadata, runtime role, exporter setup, and shutdown without owning product rules.
- **Files Kept Small**: `createApp.ts`, runtime startup files, `defaultComposition.ts`, chat presenters, retrieval pipeline services, and document worker services must not absorb exporter setup or redaction policy. New shared modules own those concerns.
- **Planned Extractions**: `shared/observability/tracing` lifecycle, no-op tracer, span helper, attribute policy, current trace correlation helper, runtime-role metadata, and test exporter utilities.
- **Required Refactor Stories**: None before implementation, provided manual spans use the shared helper and async context instead of broad parent-context parameter threading.

## Contract And Queue Impact

- **HTTP/OpenAPI**: Additive debug-only `OpenTelemetryTraceCorrelation` field on the versioned turn trace envelope if that envelope is exposed through existing debug schemas. Update code-first schemas and generated OpenAPI through the existing generator; do not hand-edit generated artifacts.
- **SDK**: If the generated SDK types include the debug envelope, regenerate or update through the existing SDK sync flow.
- **MCP**: API-mounted MCP requests may receive API-role spans. Standalone MCP package tracing is out of scope. No MCP protocol change is planned.
- **Connector Contracts**: No connector contract shape change planned.
- **Worker/Queue Payloads**: No durable document worker payload change planned for the first implementation. Trace context should be propagated via existing in-process context or optional non-authoritative metadata only if the message-queue impact review approves it.
- **Message-Queue Review**: AMQP payload shape, retry semantics, queue docs, and queue tests should remain unchanged unless implementation discovery proves trace context cannot be linked without payload metadata.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| None | N/A | N/A |
