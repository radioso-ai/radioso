# Implementation Plan: Quality Resolution and Eval Learning Loop

**Branch**: `954-quality-eval-loop` | **Date**: 2026-07-30 | **Spec**: [spec.md](./spec.md)
**Input**: Approved feature specification from `/specs/954-quality-eval-loop/spec.md`

## Summary

Add structured, concurrency-safe Quality closure and connect each assistant
message to at most one Eval case. PostgreSQL stores the mutable triage read
model, immutable transition history, and explicit message/case association.
Quality consumes a narrow Eval-owned batch projection for page enrichment.
Code-first OpenAPI drives generated SDK/MCP types, while the dashboard reuses a
shared close-review dialog and replaces the client-side Eval scan with one
idempotent server operation.

## Technical Context

**Language/Version**: TypeScript 5.7 on Node.js 24; React 19 / Next.js 16  
**Primary Dependencies**: Express, Zod, Kysely, PostgreSQL `pgvector`, Radix UI, Lucide  
**Storage**: PostgreSQL 16; migration `133` adds triage resolution/history and Eval association  
**Testing**: Vitest, Supertest, real-Postgres integration tests, Playwright  
**Target Platform**: Self-hosted Linux backend and modern desktop/mobile browsers  
**Project Type**: pnpm web monorepo with backend, dashboard, SDK, MCP server, and docs portal  
**Performance Goals**: One bounded Eval-verification query per Quality page; 100-row page under the existing 2-second local fixture; no per-case client scan  
**Constraints**: Workspace isolation; 500-character note; no note content in logs/audit/telemetry; explicit integer concurrency version; one linked case per message  
**Scale/Scope**: Five approved stories spanning Quality, Eval, dashboard, generated contracts, and product/API docs

## Constitution Check

*GATE: passed before research and re-checked after design.*

- **PASS — spec gate**: `spec.md` is explicitly approved and its checklist is complete.
- **PASS — TDD**: backend unit/contract/integration tests are written and observed failing before each production slice.
- **PASS — frontend tests**: Playwright owns visible dialog, conflict, focus, announcement, Eval, filter, and breakdown flows. Unit tests cover only URL/API transforms.
- **PASS — stack**: Node.js, React, PostgreSQL, and existing dependencies remain unchanged. No LLM integration is added.
- **PASS — secrets**: no configuration or secrets are introduced.
- **PASS — data protection**: notes are bounded, workspace-scoped, omitted from transition audit metadata and operational evidence, and protected by existing Quality permissions.
- **PASS — modularity**: Quality owns resolution/transition rules; Eval owns association and verification interpretation; HTTP only validates/translates; composition wires the narrow port.
- **PASS — file size**: new focused domain/persistence/presentation files prevent `quality-view.tsx`, `quality/service.ts`, and `evalRoutes.ts` from absorbing unrelated rules.
- **PASS — composition**: `backend/src/app/composition/builtIn/qualityModule.ts` wires the Eval verification port into Quality. No domain imports composition.
- **PASS — code-first API**: Zod-backed route/OpenAPI schemas and path registrations change first; `backend/openapi.yaml` and `.json` are regenerated.
- **PASS — queue review**: no document worker, AMQP payload, retry, queue test, or queue documentation changes are required; the feature is synchronous dashboard/API state.
- **PASS — documentation**: Quality/Eval operator guidance, API reference, module briefs, and changed dashboard screenshot are updated.

Post-design re-check: all gates remain satisfied. The approved legacy `reason`
input remains accepted without being mapped to a structured code. New clients
use `resolution`; historical/compatibility records appear as `unspecified`.

## Project Structure

### Documentation (this feature)

```text
specs/954-quality-eval-loop/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/http-api.md
└── tasks.md
```

### Source Code

```text
backend/
├── src/
│   ├── app/composition/builtIn/qualityModule.ts
│   ├── app/http/openapi/{schemas,paths}/
│   ├── db/migrations/133_quality_eval_learning_loop.sql
│   ├── modules/quality/{contracts,domain,service,routes}.ts
│   └── modules/eval/{domain,routes,services}/
├── openapi.{yaml,json}
└── tests/{unit,integration,contract}/

frontend/
├── components/dashboard/{quality,quality-view,needs-attention-view}.tsx
├── lib/{api-quality,api-eval,dashboard-routes}.ts
└── tests/{unit,e2e}/

typescript-sdk/{openapi,src/generated}/
packages/radioso-mcp-server/src/generated/
docs/
docs-portal/content/guides/
```

**Structure Decision**: Extend the existing web monorepo. Quality domain
validation and transition persistence stay within the Quality module; Eval
association creation and batch projection stay within Eval. Application
composition supplies only the narrow port. Shared dashboard components own
closure and verification presentation.

## Module Ownership & Seams

- **Transport Layer**: Quality/Eval routes parse Zod schemas, authorize, map typed conflicts/not-found outcomes, and select HTTP status codes. OpenAPI path files mirror them.
- **Orchestration Layer**: `QualityTurnsService` coordinates list/stats/transition behavior; a focused Eval message-case service prepares and atomically finds/creates linked cases.
- **Domain Layer**: `quality/domain/resolution.ts` owns state/reason/note validation and labels; Eval status projection is interpreted in Eval, not Quality. Breakdown click-through uses a distinct terminal-transition window rather than the existing message-creation `from`/`to`.
- **Persistence/Integration Layer**: Quality transition writes and transition-history insertion share one transaction. `EvalRepository` owns association/case/snapshot transactions and one batched latest-run query.
- **Application Composition**: the built-in Quality module receives an Eval verification adapter from existing Eval dependencies. Composition contains no state/reason rules.
- **Files Kept Small**: `quality-view.tsx`, `needs-attention-view.tsx`, `quality/service.ts`, and `evalRoutes.ts` receive only wiring; new focused components/services own new behavior.
- **Planned Extractions**: resolution schemas/helpers, close-review dialog, verification action/presentation, Eval message-case service, Eval verification port, and transition result/conflict types.
- **Required Refactor Stories**: no broad cleanup. The focused extractions above are foundational tasks completed before their consuming stories.

The backend already accepts agent/channel scope, although the current Quality UI
does not expose controls for it. This feature preserves that API/stat parity and
the route state can carry the scope; it does not add a separate agent/channel
filter redesign beyond the approved reason controls.

## Complexity Tracking

No constitution violations.
