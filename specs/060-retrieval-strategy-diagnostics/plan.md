# Implementation Plan: Retrieval Strategy Diagnostics

**Branch**: `060-retrieval-strategy-diagnostics` | **Date**: 2026-05-07 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/060-retrieval-strategy-diagnostics/spec.md`

## Summary

Add retrieval strategy selection for `retrieval.answer` and expose the result through the existing retrieval trace graph, skill diagnostic vocabulary, persisted audit-backed debug metadata, telemetry, OpenAPI, SDK types, and docs. The implementation reuses existing retrieval trace and audit surfaces; it does not add generic skill execution or a new trace store.

## Technical Context

**Language/Version**: TypeScript on Node.js 22
**Primary Dependencies**: Express, Zod, OpenAPI registry, existing retrieval services
**Storage**: Existing PostgreSQL audit metadata only; no new schema
**Testing**: Vitest, Supertest, backend contract/integration tests
**Target Platform**: Backend API and generated TypeScript SDK
**Project Type**: Backend + SDK docs/contracts
**Performance Goals**: Strategy mapping must add negligible latency compared with retrieval/model calls
**Constraints**: Do not emit raw prompts or document contents in telemetry; preserve existing retrieval search and assistant routing behavior
**Scale/Scope**: One strategy-aware skill, `retrieval.answer`, using existing trace surfaces and structured query interpretation metadata

## Constitution Check

- Spec exists and is approved; no implementation without spec.
- Backend work includes TDD with failing tests written before implementation.
- Frontend work is limited to generated/shared types; no new user-visible UI components are required.
- Stack remains Node.js for backend and React for frontend.
- Database remains PostgreSQL with `pgvector`; no new storage is introduced.
- LLM provider behavior is unchanged.
- No new secrets or configuration are introduced.
- Customer data handling is addressed by redacted telemetry and reuse of existing audit debug paths.
- Module boundaries are explicit: retrieval owns strategy/domain logic, telemetry emits, audit persists existing debug metadata, transport presents.
- Existing responsibility-limited files: retrieval route handlers, chat orchestration, OpenAPI registry, and frontend graph components must not own strategy rules.
- `backend/src/app/composition/` does not need new wiring because no replaceable app-wide adapter is introduced.
- HTTP response contracts change additively through `backend/src/app/http/openapi/document.ts` and generated OpenAPI artifacts.
- Message-queue impact review: no document worker dispatch, AMQP payload, retry semantics, queue tests, or queue docs are affected.
- Docs requiring updates: `docs/radioso-skills-rfc.md`, SDK/retrieval or MCP docs that describe retrieval diagnostics, and any activity/debug graph reference docs.

## Project Structure

```text
backend/
├── src/modules/retrieval/      # strategy selector, diagnostic mapping, trace summary/stage updates
├── src/modules/skills/         # shared diagnostic schema consumed but not owned by retrieval
├── src/shared/observability/   # existing telemetry service integration
├── src/app/http/openapi/       # additive trace schemas
└── tests/                      # unit, contract, integration coverage

typescript-sdk/
└── src/generated/              # generated SDK types after OpenAPI sync

docs/
└── retrieval and skills docs   # operator-facing trace/diagnostic explanation
```

**Structure Decision**: Keep all strategy behavior inside retrieval services/domain. The public response remains the existing retrieval trace graph, with additive summary fields and one new stage.

## Module Ownership & Seams

- **Transport Layer**: Existing retrieval/chat routes return presented trace data only.
- **Orchestration Layer**: Retrieval pipeline coordinates selector output with trace assembly and telemetry.
- **Domain Layer**: New retrieval strategy selector and diagnostic mapper own query-shape and skill diagnostic decisions.
- **Persistence/Integration Layer**: Existing audit metadata persists traces already attached to chat/search records.
- **Application Composition**: N/A; no new app-wide adapter, sink, registry, or capability policy.
- **Files Kept Small**: Route handlers, `chatService.ts`, and frontend graph components must not receive strategy-selection logic.
- **Planned Extractions**: Add focused retrieval strategy module and focused skill diagnostic mapper.
- **Required Refactor Stories**: None; current retrieval pipeline already has trace and diagnostics seams.

## Complexity Tracking

No constitution violations.
