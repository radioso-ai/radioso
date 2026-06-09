# Implementation Plan: Usage Trends Reporting

**Branch**: `084-usage-trends-reporting` | **Date**: 2026-06-09 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/084-usage-trends-reporting/spec.md`

## Summary

Add an OSS, member-accessible account usage trends report over existing read-only data. The backend exposes `GET /api/v1/account/usage-trends` with UTC day/week/month buckets, optional workspace and agent filters, continuous zero-filled output, and a bounded bucket count. A dedicated `backend/src/modules/reporting/` module owns query construction, bucketing math, filter validation, response mapping, and the thin account route. The frontend adds a Usage trends surface under the existing Account > Usage dashboard page and keeps the current EE quota summary separate.

## Technical Context

**Language/Version**: TypeScript on Node.js 24 for backend; TypeScript 5.7, React 19, Next.js 16 App Router for frontend  
**Primary Dependencies**: Express, Zod, PostgreSQL `pg`, Radix/shadcn UI primitives, Lucide icons, Vitest, Supertest, Playwright  
**Storage**: Existing PostgreSQL tables only: `conversations`, `messages`, `usage_events`, `workspaces`, `agents`  
**Testing**: Backend Vitest unit + contract tests first; integration tests gated on `INTEGRATION_DATABASE_URL`; frontend Vitest for data/adapters and Playwright for user-visible journey  
**Target Platform**: Self-hosted Radioso web app and backend API  
**Project Type**: Web application with backend, frontend, docs, generated OpenAPI artifacts  
**Performance Goals**: Keep trend requests bounded to a maximum of 366 buckets; each aggregation must run on a timestamp-aligned index verified by `EXPLAIN ANALYZE` (no sequential scan over a bounded range). Messages and tokens reuse existing timestamp-leading indexes; the conversation `created_at` aggregation requires a new index (the existing conversation indexes lead with `updated_at`). No new rollup or worker path in this feature  
**Constraints**: UTC bucketing only; succeeded usage events only; no message content/prompts/completions/chunks in output; no EE dependency; no new instrumentation or enforcement  
**Scale/Scope**: Per-account trend report with workspace/agent filters and daily/weekly/monthly buckets for dashboard use

## Constitution Check

*GATE: Must pass before implementation. Re-check after design.*

- Spec exists and is approved; no implementation without spec. **Pass**: `spec.md` status is Approved.
- Backend work includes TDD with failing tests written before implementation. **Pass**: tasks require unit and contract tests before service/route implementation.
- Frontend user-visible behavior is planned for Playwright coverage, and frontend unit tests are limited to non-visual logic. **Pass**: Playwright covers the trends controls; unit tests cover API/period helpers only.
- Stack remains Node.js for backend and React for frontend. **Pass**.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. **Pass**: no storage change.
- LLM provider is GPT-5.2 for AI integrations. **N/A**: no AI integration or runtime prompt change.
- Secrets and keys are managed via `.env` and `.env.example` is updated. **Pass**: no new configuration or secrets.
- Customer data handling and auditability are addressed where applicable. **Pass**: output is aggregate counts only; no raw content; access requires active membership.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. **Pass**: route is orchestration-only; reporting module owns queries and mapping.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. **Pass**: `accountUserRoutes.ts`, OpenAPI path files, and `usage-view.tsx` are kept thin; new helpers/components own feature logic.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work. **Pass**: no prerequisite refactor needed; add a new module and small frontend helpers.
- If backend work adds or replaces app-wide adapters, registries, sinks, lifecycle hooks, capability policies, storage/dispatcher implementations, or cross-module runtime infrastructure, the plan evaluates `backend/src/app/composition/` ownership. **Pass**: add a built-in OSS reporting application module to mount the route; no replaceable infrastructure or product rules in composition.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/openApiDocument.ts` and path/schema registry files and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs. **Pass**. The spec names `document.ts`; this worktree uses `openApiDocument.ts`, `openApiPaths.ts`, and `openApiRegistry.ts`.
- If public APIs, SDK contracts, MCP contracts, connector contracts, worker payloads, or other cross-service contracts change, the plan includes a message-queue impact review. **Pass**: no document worker dispatch, AMQP payload, retry semantics, queue tests, or queue docs are affected.
- If contracts, workflows, settings behavior, or user-visible functionality change, the plan identifies which docs must be updated. **Pass**: update API/product docs for account usage trends and document agent-filtered token attribution.

## Project Structure

### Documentation (this feature)

```text
specs/084-usage-trends-reporting/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── usage-trends.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/composition/builtIn/usageReportingModule.ts
│   ├── app/http/openapi/
│   │   ├── openApiPaths.ts
│   │   ├── openApiRegistry.ts
│   │   ├── paths/accountPaths.ts
│   │   └── schemas/usageTrendSchemas.ts
│   └── modules/reporting/
│       ├── composition.ts
│       ├── contracts/index.ts
│       ├── routes.ts
│       ├── service.ts
│       └── usageTrendsQuery.ts
├── openapi.yaml
├── openapi.json
└── tests/
    ├── unit/usage-trends*.test.ts
    ├── contract/usage-trends.contract.test.ts
    └── integration/usage-trends.integration.test.ts

frontend/
├── components/dashboard/
│   ├── usage-trends-view.tsx
│   └── usage-view.tsx
├── lib/
│   ├── api-account.ts
│   ├── api-types.ts
│   └── usage-trends.ts
└── tests/
    ├── unit/usage-trends.test.ts
    └── e2e/usage-trends.spec.ts

docs/
└── api.md or the existing account/dashboard API doc that owns account endpoints
```

**Structure Decision**: Use a new OSS reporting module under `backend/src/modules/reporting/`, mounted by a built-in application module. This follows the quality module pattern while keeping usage trends out of EE usage limits. Frontend work extends the existing Account > Usage surface with a separate trends component and shared non-visual helpers.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/modules/reporting/routes.ts` validates query params, reads `res.locals.accountId/userId`, calls the service, and returns JSON. It does not contain SQL or bucket math.
- **Orchestration Layer**: `UsageTrendsService` checks active membership through the existing account access service, validates workspace/agent filters against the account, calls query helpers, and maps rows to the response.
- **Domain Layer**: `usageTrendsQuery.ts` owns granularity/date validation, UTC bucket generation, zero fill, response merging, and SQL query text/params.
- **Persistence/Integration Layer**: SQL is read-only over existing tables. Messages and tokens reuse existing timestamp-leading indexes. EXPLAIN ANALYZE verification (100k conversations / 5 workspaces, 90-day window) showed the conversation `created_at` aggregation sequential-scanned because no conversation index leads with `created_at`; migration `083_usage_trends_conversation_created_at_index.sql` adds `idx_conversations_workspace_created_at (workspace_id, created_at)`, turning the workspace-filtered scan into an index-only scan (~4.6ms → ~1.1ms) and the account-wide scan into a bitmap index scan (~18.3ms → ~8.9ms). No writes, rollups, or queues.
- **Application Composition**: Add `createUsageReportingApplicationModule()` in `backend/src/app/composition/builtIn/` to mount `/api/v1/account/usage-trends`. Composition constructs the service with `connectorDb` and account-access dependency only.
- **Files Kept Small**: `backend/src/app/http/routes/index.ts` only receives the registered app route; account route files remain focused on account management. OpenAPI files only register schema/path metadata. `frontend/components/dashboard/usage-view.tsx` delegates trend-specific UI to `usage-trends-view.tsx`.
- **Planned Extractions**: `usageTrendsQuery.ts` for pure period math and query construction; `frontend/lib/usage-trends.ts` for frontend date presets, query serialization, and response totals.
- **Required Refactor Stories**: None.

## API Contract Decision

Endpoint: `GET /api/v1/account/usage-trends`

Query params:

- `from`: required `YYYY-MM-DD`, inclusive UTC date.
- `to`: required `YYYY-MM-DD`, inclusive UTC date.
- `granularity`: required `day | week | month`.
- `workspaceId`: optional UUID.
- `agentId`: optional UUID.

Behavior:

- Reject invalid ranges and requests that produce more than 366 buckets with `400`.
- Validate workspace/agent filters belong to the session account before aggregating.
- Count conversations by `conversations.created_at`.
- Count messages by `messages.created_at`, split into `user`, `assistant`, and `total`.
- Sum `usage_events.input_tokens`, `output_tokens`, and `total_tokens` for `status = 'succeeded'`.
- Agent-filtered token totals require a joinable conversation whose `agent_id` matches; usage events without a conversation are excluded only under an agent filter.

## SDK Decision

Do not add TypeScript SDK methods in this feature. The endpoint is a dashboard/session account API that depends on browser session authentication, unlike the public API-key SDK surfaces. It is documented through OpenAPI and product docs.

## Message-Queue Impact Review

No impact. This feature adds a read-only HTTP report and dashboard view. It does not change document worker dispatch, AMQP payloads, retry semantics, worker queues, queue contract tests, connector contracts, MCP contracts, or SDK contracts.

## Observability Review

No new logs, metrics, telemetry events, audit events, or spans are needed. The endpoint is a bounded read-model over existing data with no provider call, worker handoff, retry path, fallback, or state mutation. Existing request logging/error handling covers operational failures. The response intentionally avoids raw prompts, completions, document content, chunks, credentials, cookies, and connection strings.

## Complexity Tracking

No constitution violations or added complexity require justification.
