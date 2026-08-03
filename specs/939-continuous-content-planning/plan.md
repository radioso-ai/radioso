# Implementation Plan: Audience Pulse v1

**Branch**: `find-next-good-issue-v1` | **Date**: 2026-08-03 | **Spec**: [spec.md](./spec.md)
**Input**: Approved Audience Pulse feature specification.

## Summary

Build an operator-only Audience Pulse dashboard that saves one validated report per
workspace. A browser-session operator explicitly refreshes a fixed 30-day report; a new
Audience Pulse module obtains deterministic visitor aggregates and bounded evidence from
a narrow Chat-owned history port, asks the workspace's configured chat model for a
structured grouping, validates/enriches that grouping server-side, then atomically saves
it. Reads never call a model and invalidate a full snapshot when any prompt-evidence
source can no longer be reauthorized.

Topics remain ephemeral. PostgreSQL stores only one report JSON snapshot, its revision,
and opaque references for the full prompt-evidence set. The feature adds no worker,
queue message, public MCP tool, content write, topic table, or background analysis.

## Technical Context

**Language/Version**: TypeScript 5.7 on Node.js 24; React 19 / Next.js 16.
**Primary Dependencies**: Express, Zod, Kysely/PostgreSQL, workspace LLM capability
resolver and `ModelInferencePipeline`, Radix/shadcn/Lucide.
**Storage**: PostgreSQL 16; one workspace-unique `audience_pulse_snapshots` row.
**Testing**: Vitest + Supertest, Postgres integration tests, and Playwright.
**Target Platform**: Existing Docker Compose local stack and Node backend service.
**Project Type**: Web application.
**Performance Goals**: Saved reads make zero provider calls; refresh makes one bounded
structured call, sampling at most 80 questions / 60 conversations / 32,000 excerpt
characters; no traffic calls no provider.
**Constraints**: Browser-session only; fixed 30 UTC days; one cross-replica refresh per
workspace; default 3 refreshes per 15 minutes per account/workspace; no raw source or
provider text in storage/observability; no partial snapshot response.
**Scale/Scope**: One dashboard destination, two saved-report session endpoints plus one
bounded body-only evidence-read helper, one migration, and
small reusable session-auth/inference seams.

## Constitution Check

*Gate before research: passed. Re-checked after design: passed.*

- [x] The replacement specification is approved and backend tasks begin with failing
  focused tests.
- [x] User-visible frontend behavior has Playwright coverage; frontend unit tests are
  limited to state/data helpers.
- [x] The stack remains Node.js, React, and PostgreSQL; no storage or provider is added.
- [x] Existing workspace chat capability/provider cache is reused with a typed Audience
  Pulse model-call usage context.
- [x] Customer-data, full-source reauthorization, content-free audit/telemetry, and
  operator-relevant errors are covered.
- [x] Transport, domain, persistence, inference, and composition ownership are explicit;
  Quality remains a separate module.
- [x] Snapshot adapter, durable run lease, and inference factory are wired in
  application composition, not hidden in routes/services.
- [x] HTTP contracts are Zod/code-first OpenAPI. Generated OpenAPI files are regenerated,
  never manually edited; API-contract checks decide SDK output updates.
- [x] Queue impact reviewed: no worker dispatch, AMQP payload, retry, queue test, or
  queue documentation change because refresh is request-bound.
- [x] Documentation change is limited to README rate-limit settings if new environment
  variables are introduced; no public MCP or SDK guide changes are required.

## Project Structure

```text
backend/
├── prompts/audience-pulse.md
├── src/
│   ├── app/
│   │   ├── composition/builtIn/audiencePulseModule.ts
│   │   └── http/
│   │       ├── middleware/{requireDashboardWorkspaceSession,audiencePulseRefreshRateLimiter}.ts
│   │       └── openapi/{schemas/audiencePulseSchemas.ts,paths/audiencePulsePaths.ts}
│   ├── db/{migrations/134_audience_pulse_snapshots.sql,repositories/audiencePulseSnapshotRepository.ts}
│   ├── modules/{audiencePulse,chat/audiencePulseHistorySource.ts}
│   └── shared/infra/llm/contextualGateways.ts
└── tests/{unit,contract,integration}/audiencePulse/

frontend/
├── components/dashboard/audience-pulse-view.tsx
├── components/dashboard/{dashboard-shell,documents-view}.tsx
├── lib/{api-audience-pulse,dashboard-routes}.ts
└── tests/e2e/audience-pulse.spec.ts
```

**Structure Decision**: `modules/audiencePulse` owns product policy and exposes a narrow
read/refresh port. A Chat adapter owns history querying/pairing; the Audience Pulse
module never imports chat repositories. Postgres snapshot/run-gate adapters own SQL and
locking. Routes validate, authorize, rate limit, and present typed outcomes only.
Application composition assembles dependencies. The frontend owns presentation and an
account/workspace-bound `sessionStorage` handoff to Documents, not document persistence.

## Module Ownership & Seams

- **Transport**: `createAudiencePulseRoutes` mounts at `/api/v1/quality/audience-pulse`.
  It applies cookie-only auth; saved-report read/refresh require `workspace.quality.read`
  and only refresh has the dedicated rate limiter. The body-only evidence-anchor helper
  requires `workspace.history.read`, reauthorizes one exact source, and returns at most
  that source plus its next assistant reply. Routes map service results to HTTP/OpenAPI
  and perform no sampling or provider call themselves.
- **Orchestration**: `AudiencePulseService` captures the interval, handles no traffic,
  acquires/releases the durable run lease, reserves/commits/releases usage, invokes one
  inference operation, saves only validated reports, and emits safe audit/telemetry.
- **Domain**: Zod contracts, sampling policy, typed `contentGapEligible`, theme and
  recommendation integrity, and report projection are pure named helpers. The model
  supplies neither totals, eligibility, membership resolution, recurrence, duplicate
  display occurrences, or the count of ungrouped sampled questions.
- **History port**: Chat's `AudiencePulseHistorySource` owns eligible population,
  zero-filled UTC-week aggregation, `(created_at,id)` pairing, AI/human distinction,
  typed outcomes, rehydration, and the exact, bounded evidence-anchor source/reply read.
  It never exposes arbitrary history traversal through Audience Pulse.
- **Persistence/integration**: `AudiencePulseSnapshotRepository` owns revisioned atomic
  replace/find/conditional-invalidate. `PostgresAudiencePulseRunGate` uses a pinned
  Kysely connection and session advisory lock keyed by workspace, released in `finally`
  and automatically on connection/process loss. The contextual inference factory resolves
  the workspace chat capability and binds the generic model-call context supplied by its
  caller; Audience Pulse composition supplies its refresh attribution.
- **Composition**: `audiencePulseModule.ts` constructs adapters/service and
  `defaultComposition.ts` registers it. Composition owns no report policy.
- **Files kept small**: `modules/quality/routes.ts`, `QualityTurnsService`, and
  bearer-compatible `requireWorkspaceSession.ts` remain unchanged. New focused files
  prevent `contextualGateways.ts` or a route from owning product logic.

## Complexity Tracking

No constitution exception is needed. The run lease is a bounded database lock around one
provider request, not a worker/job lifecycle or in-memory coordination mechanism.
