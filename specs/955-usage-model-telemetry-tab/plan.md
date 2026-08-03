# Implementation Plan: Model and Embedding Usage Visibility

**Branch**: `usage-model-telemetry-tab` | **Date**: 2026-08-03 | **Spec**: [spec.md](./spec.md)
**Input**: Approved feature specification from `specs/955-usage-model-telemetry-tab/spec.md`

## Summary

Expose the existing model/embedding usage ledger through a new **AI usage** tab
in Usage. The tab has a per-end-user-message view and an internal-attempt view.
Backend work adds provider reasoning-token persistence, durable event-kind
classification, directive-coherence attribution, two session reporting
resources, and a focused reporting read adapter. The dashboard consumes the
typed account API and presents the views with bounded date/workspace filters
and keyset pagination.

## Technical Context

**Language/Version**: TypeScript 5.7; Node.js 24 backend; React 19 / Next.js 16 frontend
**Primary Dependencies**: Express, Zod, Kysely, OpenAI provider adapter, Radix UI/shadcn primitives
**Storage**: PostgreSQL 16; `usage_events` immutable ledger and derived daily rollups
**Testing**: Vitest, Supertest, real-Postgres integration tests, Playwright
**Target Platform**: Self-hosted Docker deployment and authenticated browser dashboard
**Project Type**: Web application (Express API plus Next.js dashboard)
**Performance Goals**: Bounded 90-day, newest-first detail views with pages of 50 by default/100 maximum; inspect account-scoped query plans after migration
**Constraints**: Session-authenticated/account-scoped; no customer/model content or provider/error identifiers; historical reasoning stays unavailable; unknown history is not guessed; no queue or batch grouping changes
**Scale/Scope**: Two account endpoints, one dashboard tab with two subviews, one ledger migration, no new persistence store

## Constitution Check

| Gate | Result | Evidence |
|---|---|---|
| Approved specification | Pass | `spec.md` was independently reviewed and amended before this plan. |
| Backend TDD | Pass | Contract, integration, and focused unit tests are listed before implementation tasks. |
| Frontend coverage | Pass | API/helper Vitest and visible Playwright flow are planned. |
| Stack/persistence | Pass | Existing Node/React/Postgres/Kysely paths are retained. |
| Customer data/auditability | Pass | Ledger remains source of truth; response uses an explicit safe-field allowlist. |
| Module boundaries | Pass | Reporting read port/repository, service, route/OpenAPI, and dashboard components remain separate. |
| Composition review | Pass | `usageReportingModule.ts` wires the reporting repository/service; directive gateway stays an application adapter. |
| HTTP/OpenAPI artifacts | Pass | Registry, generated backend docs, SDK snapshot/types, and MCP generated types are updated together. |
| Queue contract review | Pass | No worker payload, AMQP dispatch, retry, or queue documentation changes. |
| Documentation | Pass | API portal, taxonomy, and readme updates are planned. |

The post-design check remains a pass: no new global replacement adapter,
provider, worker contract, or storage system is introduced.

## Project Structure

```text
backend/
├── src/
│   ├── app/
│   │   ├── composition/builtIn/usageReportingModule.ts
│   │   ├── http/openapi/{openApiRegistry.ts,paths/accountPaths.ts,schemas/usageDetailsSchemas.ts}
│   │   └── server/dependencies.ts
│   ├── db/
│   │   ├── migrations/134_usage_event_detail_dimensions.sql
│   │   └── repositories/usageDetailsReportingRepository.ts
│   ├── modules/reporting/
│   │   ├── contracts/index.ts
│   │   ├── service.ts
│   │   ├── routes.ts
│   │   ├── usageDetailsCursor.ts
│   │   ├── usageDetailsLabels.ts
│   │   └── usageDetailsQuery.ts
│   └── shared/infra/{llm/modelInferencePipeline.ts,usage/durableUsageEventRecorder.ts}
├── tests/{unit,integration,contract}/
└── openapi.{json,yaml}

frontend/
├── components/dashboard/{usage-view.tsx,usage-details-view.tsx}
├── lib/{api-account.ts,api-types.ts,usage-details.ts}
└── tests/{unit,e2e}/

packages/usage-contract/usageEvent.d.ts
packages/conversation-contract/index.d.ts
packages/conversation-defaults/src/directiveCoherence.ts
```

**Structure Decision**: The reporting domain owns definitions, classification
rules, cursor encoding, labels, validation semantics, and orchestration. A
Postgres reporting repository owns Kysely reads and maps only an allowlisted
row shape. Existing route code only validates/forwards requests. The dashboard
page composes tabs while `usage-details-view.tsx` owns filters, fetch state,
tables, and paging. Ledger persistence stays in the existing recorder and
provider-normalization pipeline.

## Module Ownership & Seams

- **Transport Layer**: `modules/reporting/routes.ts` validates the shared query
  and invokes a narrow detailed-reporting port. OpenAPI schema/path modules
  describe the same response only; no SQL or classification lives here.
- **Orchestration Layer**: `UsageDetailsService` checks active account
  membership, validates workspace ownership, normalizes dates/cursors, invokes
  its read port, and returns response models.
- **Domain Layer**: `usageDetailsCursor.ts` owns opaque cursor parsing;
  `usageDetailsLabels.ts` maps known structured surface/operation pairs to
  friendly labels and safely humanizes unknown pairs; typed contracts express
  kind-specific token semantics. It does not know SQL or React.
- **Persistence/Integration Layer**: `UsageDetailsReportingRepository` selects
  the allowlisted event/message/conversation fields with Kysely, applies the
  exact classification predicate, aggregates messages before keyset paging,
  and maps BIGINT strings to numbers. `DurableUsageEventRecorder` remains the
  only writer of new `event_kind` and `reasoning_tokens` values.
- **Application Composition**: `usageReportingModule.ts` creates the repository
  and `UsageDetailsService` alongside the existing trends service. The existing
  server-side conversation-model gateway receives opaque coherence invocation
  metadata and maps it into the existing inference-pipeline context.
- **Files Kept Small**: `usage-view.tsx` remains a page-level tab composer;
  `usageTrendsQuery.ts` retains trend-only bucketing; provider adapters retain
  provider-specific token extraction; routes do not absorb response mapping.
- **Planned Extractions**: New reporting repository/port, detail query helpers,
  label formatter, cursor codec, OpenAPI schema module, and dashboard detail
  view prevent changes from accumulating in existing trend/page files.
- **Required Refactor Stories**: None. The new details read path is deliberately
  separate from legacy `UsageTrendsService`, which currently owns its own
  direct aggregate queries.

## Data and Contract Design

See [data-model.md](./data-model.md) and
[contracts/usage-details.md](./contracts/usage-details.md).

### Ledger write path

1. `ProviderUsage.reasoningTokens` already normalizes provider data.
2. `ModelInferencePipeline` forwards it as nullable `reasoningTokens` to
   `ModelUsageEvent`.
3. `DurableUsageEventRecorder.recordModelCall` writes `event_kind = model` and
   nullable `reasoning_tokens`; `recordEmbedding` writes `event_kind = embedding`.
4. Migration 134 adds both columns, classifies only evidenced history, and
   creates the internal pagination index. Daily rollups remain unchanged because
   detail reporting reads the immutable ledger and trends do not expose
   reasoning/kind dimensions.

### Directive coherence attribution

`AuthoredDirectiveService` already receives the real `workspaceId` and agent.
It passes that invocation context through the directive-coherence check input;
the default checker merges it into opaque model metadata; the concrete
`createConversationModelGateway` safely extracts it to build an `agents /
directive_coherence` inference operation. That operation has a real workspace
foreign key and an internal-use label. Generic conversation contracts continue
to treat the metadata as opaque.

### Detail reporting

- Message predicate: joined `messages.role = user`, joined conversation source
  not operator-test/replay, and `usage_events.surface <> eval`.
- Internal predicate: logical complement inside the requested account/date
  scope, including deleted or missing message/conversation lineage.
- Message response preserves independent model, embedding, and unknown totals.
  Model reasoning coverage derives only from model rows.
- Responses never select or return content, idempotency/request/error fields.
- Cursors are base64url shape-validated keysets, not offset pages.

### User interface

`UsageView` gets top-level **Overview** and **AI usage** tabs. Overview retains
all existing meters/trends. AI usage lazily mounts `UsageDetailsView`, which
shares its date/workspace query state across **Messages** and **Internal
operations**, renders accessible tables/badges, supports Load more, preserves
query state in URL search parameters, and distinguishes a reported zero from
an unavailable value.

## Test Strategy

1. Write the following tests first and observe their failures:
   - model pipeline forwards separate reasoning usage;
   - migration/recorder persists kind/reasoning and keeps ambiguous history
     unknown;
   - directive coherence reaches a real workspace/agent operation;
   - detailed contract validates auth/query/response shape;
   - detailed integration verifies classification, per-kind aggregation,
     partial reasoning, pagination, cross-account rejection, and allowlisting.
2. Implement the database/write/read path until focused backend tests pass.
3. Add frontend API/helper tests for query/cursor-independent formatting and
   Playwright coverage for the visible tab, filters, states, and pagination.
4. Regenerate schema/OpenAPI outputs, sync downstream contract artifacts, and
   run focused plus broad checks in [quickstart.md](./quickstart.md).

## Complexity Tracking

No constitution violations require justification.
