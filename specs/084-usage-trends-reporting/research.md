# Research: Usage Trends Reporting

## Decision: Dedicated OSS Reporting Module

Use `backend/src/modules/reporting/` for contracts, route, service, and query helpers.

**Rationale**: The feature is OSS, account-scoped, and independent from EE usage limits. The quality module provides the closest local pattern: focused SQL aggregation under a module, route mounting through an application module, and thin transport code.

**Alternatives considered**: Extending EE usage-limit code was rejected because trends are not EE-gated and need workspace/agent dimensions that quota summaries do not own. Adding SQL directly to account routes was rejected because the spec requires a focused read-model module.

## Decision: Query Source Tables Directly

Use `conversations`, `messages`, and `usage_events` directly. Do not use `usage_daily_rollups`.

**Rationale**: The rollup table lacks workspace and agent dimensions. Direct queries can honor workspace and agent filters while remaining read-only.

**Alternatives considered**: A new rollup was rejected as out of scope because the spec forbids new instrumentation and only asks for a read-model over existing data.

## Decision: UTC Date Math With a 366-Bucket Limit

Normalize `from` and `to` as inclusive UTC dates and generate bucket starts/ends in code. Reject requests that produce more than 366 buckets.

**Rationale**: The API needs continuous zero-filled series. Generating the expected bucket axis in TypeScript keeps zero-fill and bounds testable without a database.

**Alternatives considered**: Letting SQL `generate_series` produce the axis was rejected for unit-testability and to keep contract behavior independent from a live database.

## Decision: OpenAPI Registry Files in This Worktree

Use `backend/src/app/http/openapi/openApiDocument.ts`, `openApiPaths.ts`, `openApiRegistry.ts`, and path/schema modules.

**Rationale**: The spec names `document.ts`, but the current worktree uses these files as the code-first registry. Generated `backend/openapi.yaml` and `.json` remain generated outputs.

**Alternatives considered**: Creating a new `document.ts` compatibility file was rejected because it would duplicate the established registry.

## Decision: No SDK Surface

Do not add a TypeScript SDK method.

**Rationale**: The endpoint is session-authenticated and account-dashboard oriented. The SDK is intended for external API-key workflows. OpenAPI documents the contract.

**Alternatives considered**: Adding SDK support was rejected to avoid implying API-key support for a member-session dashboard report.

## Decision: Frontend Uses Existing Account Usage Page

Add a trends panel/component to `UsageView`, with non-visual helpers in `frontend/lib/usage-trends.ts`.

**Rationale**: Account > Usage already owns usage visibility. Keeping trends separate from EE quota cards preserves the existing quota summary while making OSS trends visible to all members.

**Alternatives considered**: A separate navigation tab was rejected as unnecessary route churn for this feature.
