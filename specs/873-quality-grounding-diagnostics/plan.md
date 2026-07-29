# Implementation Plan: Quality Grounding Diagnostics

**Branch**: `873-quality-grounding-diagnostics` | **Date**: 2026-07-29 | **Spec**: [spec.md](./spec.md)
**Input**: Approved feature specification in `specs/873-quality-grounding-diagnostics/spec.md`

## Summary

Persist the existing per-answer grounding verdict and four claim/source counts as
an immutable, constrained snapshot on `messages`; safely backfill recoverable
history from the newest `chat.answer` or `chat.suspended` event; expose the
snapshot and composable filters through the Quality API; and render the same
evidence in the existing Quality Outcome cell and URL-backed filter dialog.

The implementation keeps computation in chat presentation, storage at the chat
persistence boundary, query semantics inside Quality, validation in HTTP, and
presentation in the dashboard. Existing signal predicates, health rates, queue
contracts, and turn behavior remain unchanged.

## Technical Context

**Language/Version**: TypeScript 5.7 on Node.js 24; React 19 / Next.js 16
**Primary Dependencies**: Express, Zod, Kysely, PostgreSQL 16, Radix UI/shadcn primitives
**Storage**: PostgreSQL `messages` table plus one idempotent SQL migration
**Testing**: Vitest, Supertest, Playwright, generated OpenAPI contract checks
**Target Platform**: Self-hosted Linux services and modern browsers
**Project Type**: TypeScript web application in a pnpm workspace
**Performance Goals**: Keep Quality pagination/count queries workspace-scoped; add no request-time JSON or audit-event scans
**Constraints**: Complete-object-or-null semantics; atomic new-turn write; no new table, provider call, queue, index, or observability stream
**Scale/Scope**: One existing endpoint, one existing dashboard view, one data migration, generated SDK/MCP contract surfaces

## Constitution Check

### Pre-design gate

- PASS — `spec.md` is approved and every task traces to FR-001–FR-031.
- PASS — backend slices use red/green TDD before production changes.
- PASS — visible UI behavior uses Playwright; unit tests cover only URL and API encoding.
- PASS — the existing Node/React/PostgreSQL stack is unchanged; no AI integration is added.
- PASS — no configuration or secret changes are required.
- PASS — diagnostics contain counts/verdict only and expose no prompt, answer,
  retrieved content, credential, or connection data.
- PASS — ownership is explicit: chat computes/passes, persistence writes, Quality
  reads/maps/filters, HTTP validates/documents, dashboard presents.
- PASS — `chatTurnLifecycle.ts`, `quality/service.ts`, routes, and
  `quality-view.tsx` remain orchestration/presentation. Focused value and predicate
  helpers prevent grounding rules from spreading into them.
- PASS — no replaceable app-wide infrastructure is introduced, so
  `backend/src/app/composition/` needs no change.
- PASS — the actual code-first OpenAPI sources are
  `backend/src/app/http/openapi/schemas/qualitySchemas.ts` and
  `backend/src/app/http/openapi/paths/qualityPaths.ts`, assembled by
  `openApiDocument.ts`. `backend/openapi.{json,yaml}` remain generated outputs.
- PASS — message-queue impact is none: document dispatch, AMQP payloads, retries,
  queue tests, and queue docs are unchanged.
- PASS — `docs/human-takeover.md` receives operator/API guidance after reading
  `docs/document-writer-prompt.md`; generated contract artifacts stay synchronized.

### Post-design gate

PASS. Research and data-model decisions introduce no constitution exception.
The migration is the sole historical JSON reader; runtime Quality reads only
dedicated scalar columns. No architecture-first refactor story is required
because the existing persistence and Quality seams are narrow enough.

## Project Structure

```text
specs/873-quality-grounding-diagnostics/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/quality-turns.md
└── tasks.md

backend/
├── src/db/migrations/132_message_grounding_diagnostics.sql
├── src/db/repositories/messageRepository.ts
├── src/db/schema.sql
├── src/shared/infra/kysely/schema.ts
├── src/shared/domain/groundingDiagnostic.ts
├── src/modules/chat/
│   ├── services/groundingDiagnostic.ts
│   ├── services/chatTurnLifecycle.ts
│   └── infra/postgresAssistantTurnPersistence.ts
├── src/modules/quality/
│   ├── contracts/index.ts
│   ├── groundingDiagnostic.ts
│   ├── service.ts
│   └── routes.ts
├── src/app/http/openapi/
│   ├── schemas/qualitySchemas.ts
│   └── paths/qualityPaths.ts
└── tests/

frontend/
├── lib/api-quality.ts
├── lib/dashboard-routes.ts
├── components/dashboard/quality-view.tsx
└── tests/{unit,e2e}/

typescript-sdk/
packages/radioso-mcp-server/
docs/human-takeover.md
```

## Module Ownership & Seams

- **Transport Layer**: `quality/routes.ts` parses verdict arrays and strict
  booleans and passes typed input; OpenAPI schema/path modules document the same
  contract. Neither owns predicates.
- **Orchestration Layer**: `chatTurnLifecycle.ts` attaches an already-computed
  diagnostic to `MessageCreateInput`; `quality/service.ts` sequences predicate
  assembly, SQL execution, and DTO mapping.
- **Domain Layer**: `shared/domain/groundingDiagnostic.ts` defines the dependency-free
  snapshot and verdict vocabulary. `chat/services/groundingDiagnostic.ts` only
  projects `GroundingSummary` into it. `quality/groundingDiagnostic.ts` maps
  complete database rows and builds scalar SQL predicates without importing chat
  or persistence modules.
- **Persistence Layer**: `PostgresAssistantTurnPersistence` and
  `MessageRepository` atomically write/read the snapshot. Migration 132 adds
  constraints and performs the one-time latest-event backfill.
- **Application Composition**: N/A. Existing objects gain scalar data; no new
  adapter, registry, lifecycle hook, dispatcher, or policy is wired.
- **Files Kept Small**: lifecycle does not validate historical JSON; Quality
  service does not classify verdicts; routes do not write SQL; the dashboard does
  not infer evidence from outcomes.
- **Planned Extractions**: two small value/predicate seams named above.
- **Required Refactor Stories**: none.

## Data Migration

Migration `132_message_grounding_diagnostics.sql`:

1. Adds the five nullable scalar columns.
2. Adds verdict vocabulary, non-negative integer, all-null/all-present, and
   sourced-plus-unsourced-equals-total checks.
3. Selects one candidate event per assistant message with a lateral subquery over
   `chat.answer` and `chat.suspended`, ordered by `created_at DESC, id DESC`.
4. Updates only messages whose five fields are all null and only when the newest
   candidate has a recognized verdict and complete, JSON-number, integer,
   non-negative, internally consistent counts.
5. Does not fall back to an older complete event when the newest is invalid.
6. Adds no index because existing workspace/role/creation indexes bound the
   population before these secondary predicates.

## Contract and Queue Impact

- Runtime and OpenAPI add `LowQualityTurn.grounding` as a complete object or
  `null`, plus `groundingVerdict`, `hasUnsourcedClaims`, and
  `hasInvalidSources` query parameters.
- SDK and MCP OpenAPI types are regenerated from `backend/openapi.json`.
- Document worker dispatch, AMQP payloads, retry semantics, queue contract tests,
  and queue docs are unaffected. The snapshot is written in the existing atomic
  assistant-turn transaction.

## Observability and Privacy

No new logs, metrics, audit events, analytics, or spans are added. This extends
an existing write and read query and creates no new runtime path or failure mode.
The public object contains only a verdict and aggregate counts.

## Complexity Tracking

No constitution violations or justified complexity exceptions.
