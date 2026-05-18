# Implementation Plan: Token Authorization Phase 1

**Branch**: `062-multiple-role-tokens` | **Date**: 2026-05-17 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/062-multiple-role-tokens/spec.md`

## Summary

Remove the broad bearer-token permission bypass by modeling workspace API tokens as explicit authenticated principals and routing bearer authorization through declared workspace permissions. Existing workspace API tokens remain compatible as admin token principals. Public chat and website embed launch credentials remain valid only on public session-exchange endpoints and are rejected by normal bearer API authentication.

## Technical Context

**Language/Version**: TypeScript on Node.js 24
**Primary Dependencies**: Express, Zod, Pino, existing auth/account modules
**Storage**: PostgreSQL with existing `workspace_tokens` records
**Testing**: Vitest, Supertest
**Target Platform**: Backend API and MCP routes
**Project Type**: Web application backend
**Performance Goals**: No new network or database round trips beyond existing token lookup and membership checks for protected routes
**Constraints**: Preserve existing single-token automation; do not introduce Phase 2 token-management UI or multi-token lifecycle
**Scale/Scope**: Existing workspace API, SDK, crawler, and MCP clients

## Constitution Check

- Spec exists and is approved for Phase 1; implementation is scoped to this spec.
- Backend work follows TDD with focused failing tests added before implementation.
- No frontend behavior is changed in Phase 1.
- Stack remains Node.js for backend and React for frontend.
- Database remains PostgreSQL with `pgvector`; no schema migration is required for Phase 1.
- LLM provider behavior is unchanged.
- No new secrets or `.env` values are introduced.
- Customer data protection improves by removing blanket bearer authorization.
- Module boundaries are explicit: middleware attaches principals, account access decides permissions, routes declare required permissions.
- `backend/src/app/composition/` does not need updates because no replaceable runtime infrastructure is added.
- OpenAPI route shapes are unchanged; generated artifacts were refreshed by backend build.
- Message-queue impact review: no document worker dispatch, AMQP payload, retry semantics, queue tests, or queue docs are affected.
- Docs updated: MCP setup, TypeScript SDK getting started/basic usage, website crawler.

## Project Structure

```text
backend/src/
├── app/http/middleware/
│   ├── requireApiToken.ts
│   ├── requirePermission.ts
│   └── requireWorkspaceSession.ts
├── app/http/routes/
│   ├── agentRoutes.ts
│   ├── assistantRoutes.ts
│   ├── documentRoutes.ts
│   ├── historyRoutes.ts
│   ├── retrievalRoutes.ts
│   ├── settingsRoutes.ts
│   ├── skillRoutes.ts
│   └── workspaceRoutes.ts
├── modules/account/services/accountAccessService.ts
├── modules/auth/services/authService.ts
└── modules/websiteCrawler/routes.ts

backend/tests/
├── contract/token-authorization.contract.test.ts
└── unit/require-permission-middleware.test.ts
```

**Structure Decision**: Keep principal attachment in existing auth middleware, permission decisions in `AccountAccessService`, and route permission declarations beside existing route authentication middleware.

## Module Ownership & Seams

- **Transport Layer**: Route files declare required permissions and continue to translate request/response details only.
- **Orchestration Layer**: Existing services remain unchanged; no workflow expansion is needed.
- **Domain Layer**: `AccountAccessService` owns principal-to-permission decisions.
- **Persistence/Integration Layer**: Existing token repository lookup remains unchanged.
- **Application Composition**: N/A.
- **Files Kept Small**: `requirePermission.ts` must not regain bearer bypass logic; route handlers must not embed role matrices.
- **Planned Extractions**: Phase 2 may extract a dedicated token-management service, but Phase 1 only needs explicit principal types.
- **Required Refactor Stories**: None for Phase 1.

## Complexity Tracking

No constitution violations.
