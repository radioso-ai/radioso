# Implementation Plan: Security Remediation

**Branch**: `031-security-remediation` | **Date**: 2026-03-30 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/031-security-remediation/spec.md`

## Summary

Remediate the confirmed repo security findings as one coordinated release: remove reachable vulnerable production dependencies, harden connector secret storage so it fails closed, replace browser-persisted workspace bearer tokens with session-authenticated workspace context, and add durable abuse controls for auth-sensitive and anonymous entry points. The plan keeps the existing account session cookie as the administrator trust root, shifts workspace selection to explicit session-authenticated context, centralizes rate-limit policy in a shared backend service backed by PostgreSQL, and documents rollout behavior for legacy connector records and active sessions.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24 (backend), TypeScript 5.7 + React 19 + Next.js 16 (frontend)
**Primary Dependencies**: Express, pg, Zod, OpenAI SDK, Next.js App Router, Radix/shadcn UI, existing local parser package under `/packages`  
**Storage**: PostgreSQL 16 with `pgvector`; additive durable abuse-control persistence; existing sessions, workspace tokens, and connector config records  
**Testing**: Vitest unit/integration/contract suites, Supertest for backend HTTP contracts, targeted frontend unit coverage for session/bootstrap changes  
**Target Platform**: Web application deployed as multi-instance backend plus Next.js frontend  
**Project Type**: Web application (backend + frontend + local packages)  
**Performance Goals**: No material regression to authenticated admin flows; abuse-control checks add sub-request overhead only; upload acceptance and chat latency stay within current user expectations  
**Constraints**: No committed secrets; migration must be explicit for legacy plaintext connector secrets; backend HTTP contract changes must be reflected in the code-first OpenAPI registry; browser persistent storage may keep non-sensitive active-workspace metadata only  
**Scale/Scope**: One coordinated security remediation feature touching auth/session flows, connector config handling, anonymous chat enforcement, upload/auth throttling, and production dependency graphs

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Spec exists and is approved**: PASS — approved spec at `specs/031-security-remediation/spec.md`.
- **Backend work includes TDD**: PASS — each backend slice will land with failing-first unit, contract, and integration coverage before implementation.
- **Stack remains Node.js for backend and React for frontend**: PASS — all changes stay inside the existing TypeScript/Express/Next.js stack.
- **Database is PostgreSQL with `pgvector`**: PASS — PostgreSQL remains the only durable store; `pgvector` usage is unchanged.
- **LLM provider remains GPT-5.2**: PASS — no LLM provider changes are planned.
- **Secrets and keys managed via `.env` and `.env.example`**: PASS — connector encryption hardening and any abuse-control config changes will update env parsing and `.env.example`.
- **Customer data handling and auditability addressed**: PASS — the plan hardens credential storage, records security-relevant failures, and prefers fail-closed behavior on unsafe paths.
- **Module boundaries explicit**: PASS — route/middleware transport, auth-abuse orchestration, connector/domain policy, and persistence seams are identified below.
- **Responsibility-limited files identified**: PASS — `dependencies.ts`, route files, and frontend API/bootstrap modules remain thin and do not absorb cross-cutting policy logic.
- **Architecture/refactor stories required first**: PASS — no standalone refactor story is required if the new shared auth-context and abuse-control seams are introduced before feature changes.
- **Backend HTTP contract ownership is explicit**: PASS — any admin API auth/context change will be modeled in `backend/src/app/http/openapi/document.ts`; `backend/openapi.yaml` and `backend/openapi.json` remain generated outputs.

## Project Structure

### Documentation (this feature)

```text
specs/031-security-remediation/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── admin-session-auth-contract.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/
│   │   ├── config/
│   │   │   └── env.ts
│   │   ├── http/
│   │   │   ├── middleware/
│   │   │   │   ├── requireSession.ts
│   │   │   │   ├── requireApiToken.ts
│   │   │   │   ├── requireWorkspaceSession.ts         # NEW
│   │   │   │   └── rateLimit.ts                       # NEW shared transport seam
│   │   │   ├── routes/
│   │   │   │   ├── authRoutes.ts
│   │   │   │   ├── accountRoutes.ts
│   │   │   │   ├── workspaceRoutes.ts
│   │   │   │   ├── documentRoutes.ts
│   │   │   │   ├── settingsRoutes.ts
│   │   │   │   ├── chatRoutes.ts
│   │   │   │   └── publicChatRoutes.ts
│   │   │   └── openapi/
│   │   │       └── document.ts
│   │   └── server/
│   │       ├── createApp.ts
│   │       ├── dependencies.ts
│   │       └── types.ts
│   ├── db/
│   │   ├── migrations/
│   │   │   └── 010_abuse_controls.sql                 # NEW
│   │   └── repositories/
│   │       ├── workspaceRepository.ts
│   │       ├── sessionRepository.ts
│   │       └── abuseControlRepository.ts              # NEW
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── domain/
│   │   │   │   └── authPrimitives.ts
│   │   │   └── services/
│   │   │       ├── authService.ts
│   │   │       └── workspaceSessionService.ts         # NEW
│   │   ├── connectors/
│   │   │   └── services/
│   │   │       ├── connectorRegistry.ts
│   │   │       └── configEncryption.ts
│   │   ├── documents/
│   │   │   └── services/
│   │   │       └── documentImportService.ts
│   │   └── security/
│   │       └── services/
│   │           └── abuseControlService.ts             # NEW
│   └── shared/
│       └── infra/
│           └── database.ts
├── tests/
│   ├── contract/
│   ├── integration/
│   └── unit/
packages/
└── document-parser/
    ├── package.json
    └── parsers/
        └── xlsx.*                                     # REPLACED or rewritten to safe parser path

frontend/
├── app/
├── components/
│   └── dashboard/
├── lib/
│   ├── api.ts
│   ├── auth-context.tsx
│   └── workspace-context.tsx                          # MODIFIED or NEW workspace session seam
└── tests/
```

**Structure Decision**: Keep the feature inside the existing backend/frontend split. Admin authentication trust stays anchored in the existing session-cookie flow. A new backend workspace-session seam resolves the selected workspace from session-authenticated context, while a new backend abuse-control seam centralizes rate-limit decisions and durable persistence. Connector secret hardening remains in the connectors module, and spreadsheet dependency remediation stays isolated to the parser package and import path rather than spreading through document services.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/*` and `backend/src/app/http/middleware/*` translate requests, attach auth/workspace context, and shape responses only.
- **Orchestration Layer**: `authService.ts`, `workspaceSessionService.ts`, `documentImportService.ts`, and `abuseControlService.ts` coordinate workflows and policy enforcement without owning persistence details.
- **Domain Layer**: connector secret safety rules, workspace-selection rules, and rate-limit policy live in focused auth/security/connectors services rather than route files or frontend helpers.
- **Persistence/Integration Layer**: repositories own DB reads/writes for sessions, workspace resolution, abuse-control counters, and existing connector config records; parser-package adapters own spreadsheet extraction behavior.
- **Files Kept Small**: `backend/src/app/server/dependencies.ts`, `backend/src/app/http/routes/*.ts`, `frontend/lib/api.ts`, and `frontend/lib/auth-context.tsx`.
- **Planned Extractions**:
  - `requireWorkspaceSession.ts` for session-authenticated workspace resolution
  - `workspaceSessionService.ts` for workspace-selection semantics
  - `abuseControlService.ts` and `abuseControlRepository.ts` for shared durable throttling
  - dedicated contract notes for the admin API auth/context shift
- **Required Refactor Stories**: None, provided the shared auth and abuse-control seams land before route-by-route remediation.

## Complexity Tracking

No constitution violations to justify.

## Implementation Phases

### Phase 0: Research and design lock-in

1. Confirm the dependency remediation strategy for backend routing, frontend framework versioning, and spreadsheet parsing replacement.
2. Lock the admin auth/context design around session cookie plus explicit workspace selection rather than browser-held bearer tokens.
3. Lock the durable abuse-control design around PostgreSQL-backed counters/leases rather than process-local memory.
4. Define the operator path for legacy plaintext connector secrets and rollout expectations for active browser sessions.

### Phase 1: Foundational seams

1. Add a durable abuse-control persistence model and shared service.
2. Add a session-authenticated workspace resolution seam for admin APIs.
3. Harden connector secret storage policy so invalid or missing encryption config fails closed.
4. Update env parsing and composition wiring for the new required config and service dependencies.

### Phase 2: User Story 1 (P1) protected credentials and sessions

1. Replace browser workspace bearer-token persistence with session-authenticated workspace context across frontend bootstrap and backend admin APIs.
2. Preserve multi-workspace switching without exposing reusable credentials in persistent browser storage.
3. Detect or flag legacy plaintext connector-secret records and force explicit remediation or rotation.

### Phase 3: User Story 2 (P1) durable abuse controls

1. Apply shared throttling policy to registration and login.
2. Apply shared throttling policy to workspace credential/session-sensitive endpoints and authenticated upload acceptance.
3. Move anonymous chat rate limiting from process-local memory to durable shared enforcement.
4. Add audit and operator-observable failure paths for enforced limits and unavailable abuse-control state.

### Phase 4: User Story 3 (P2) dependency remediation

1. Upgrade or replace the affected production dependencies and regenerate lockfiles.
2. Replace the vulnerable spreadsheet parsing path in the local parser package while preserving supported import behavior.
3. Update framework and backend dependency trees until the confirmed audit advisories are cleared or explicitly documented as temporary residual risk.

### Phase 5: User Story 4 (P3) rollout, migration, and validation

1. Update code-first OpenAPI, generated OpenAPI outputs, and operator docs.
2. Add backend unit/contract/integration tests and frontend session/bootstrap tests before implementation per slice.
3. Execute quickstart validation for legacy connector records, active sessions, multi-workspace admin flows, throttling behavior, uploads, and anonymous chat.
