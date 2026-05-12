# Implementation Plan: Password Reset Email Recovery

**Branch**: `borohhov/password-reset-email` | **Date**: 2026-04-22 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/porto/specs/045-password-reset-email/spec.md)
**Input**: Feature specification from `/specs/045-password-reset-email/spec.md`

## Summary

Add a self-serve password reset flow for login users with uniform request responses, one-time hashed reset credentials, and immediate revocation of all existing sessions after a successful reset. Deliver password reset email through a new reusable provider-agnostic email module so auth orchestration stays focused on recovery rules while future workflows can reuse the same transport seam.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend)
**Primary Dependencies**: Express, Zod, `pg`, Pino, Vitest, Supertest, Next.js App Router, shadcn/Radix UI primitives  
**Storage**: PostgreSQL 16 with existing `sessions`, `users`, `account_memberships`, `audit_events`; additive `password_reset_tokens` table  
**Testing**: Vitest, Supertest, frontend unit tests where UI behavior warrants coverage  
**Target Platform**: Dockerized local stack and Node-hosted backend/frontend services  
**Project Type**: Web application with `backend/` and `frontend/`  
**Performance Goals**: Reset request and confirmation stay within normal auth latency envelopes; token lookup/revocation remains O(1) on indexed keys  
**Constraints**: Uniform outward response for existing and unknown emails, provider-agnostic email configuration, complete session revocation on success, no invitation-email scope expansion  
**Scale/Scope**: Existing multi-account auth system with workspace bootstrap; one new recovery flow and one reusable transactional email module

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; implementation traces only to `/specs/045-password-reset-email/spec.md`.
- Backend work will follow TDD with failing tests added before production code in auth, repositories, and routes.
- Stack remains Node.js for backend and React/Next.js for frontend.
- Database remains PostgreSQL with additive schema only.
- No LLM prompt assets are in scope.
- New delivery configuration will live in `.env.example`; no secrets will be committed.
- Auditability and safe failure modes are in scope for recovery attempts, token validation, and delivery failures.
- Module boundaries are explicit:
  - `backend/src/app/http/routes/authRoutes.ts` remains transport-only.
  - `backend/src/modules/auth/services/authService.ts` remains session/login orchestration only.
  - New password reset workflow logic moves to a dedicated recovery service.
  - New outbound email behavior lives under a reusable email module.
- Backend HTTP contracts change, so `backend/src/app/http/openapi/document.ts` must be updated and generated OpenAPI outputs regenerated.
- User-visible auth flow changes and new operator-facing mail settings require `readme.md` and `backend/.env.example` updates.

## Project Structure

### Documentation (this feature)

```text
specs/045-password-reset-email/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── password-reset.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/
│   │   ├── config/env.ts
│   │   ├── http/openapi/document.ts
│   │   ├── http/routes/authRoutes.ts
│   │   └── server/
│   │       ├── dependencies.ts
│   │       └── types.ts
│   ├── db/
│   │   ├── migrations/
│   │   └── repositories/
│   └── modules/
│       ├── auth/
│       │   ├── domain/
│       │   └── services/
│       └── email/
├── scripts/generateOpenApi.ts
└── tests/
    ├── integration/
    ├── support/
    └── unit/
frontend/
├── app/
├── components/auth/
├── lib/api.ts
└── tests/unit/
```

**Structure Decision**: Keep route parsing and response shaping in `backend/src/app/http/routes/authRoutes.ts`; add a focused password reset service under `backend/src/modules/auth/services/`; add provider-agnostic outbound email under `backend/src/modules/email/`; add persistence seams in `backend/src/db/repositories/`; wire dependencies centrally in `backend/src/app/server/dependencies.ts`; keep frontend work inside the existing auth entry points and a dedicated reset page.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/authRoutes.ts`, frontend pages/forms under `frontend/app/` and `frontend/components/auth/`
- **Orchestration Layer**: `backend/src/modules/auth/services/authService.ts` for login/session flows; new `PasswordResetService` for reset request/confirm orchestration
- **Domain Layer**: reset token creation/validation helpers under `backend/src/modules/auth/domain/`; email message typing and template building under `backend/src/modules/email/`
- **Persistence/Integration Layer**: new password reset token repository, session revocation additions, user password update support, SMTP/log email transports
- **Files Kept Small**:
  - `backend/src/app/http/routes/authRoutes.ts` must not own recovery rules or transport code
  - `backend/src/modules/auth/services/authService.ts` must not absorb email-delivery implementation
  - `frontend/components/auth/login-form.tsx` should only own login UI state plus the reset entry point
- **Planned Extractions**:
  - `backend/src/modules/auth/services/passwordResetService.ts`
  - `backend/src/db/repositories/passwordResetTokenRepository.ts`
  - `backend/src/modules/email/services/emailService.ts`
  - provider adapters under `backend/src/modules/email/infra/`
- **Required Refactor Stories**: none beyond the planned extractions; existing structure already supports focused seams.

## Phase 0: Research

See [research.md](/Users/dm/conductor/workspaces/radioso/porto/specs/045-password-reset-email/research.md) for resolved decisions on token lifecycle, revocation strategy, email-driver boundaries, and frontend routing.

## Phase 1: Design & Contracts

- Define the password reset token entity and repository contract in [data-model.md](/Users/dm/conductor/workspaces/radioso/porto/specs/045-password-reset-email/data-model.md).
- Capture the request and confirmation HTTP shapes in [contracts/password-reset.md](/Users/dm/conductor/workspaces/radioso/porto/specs/045-password-reset-email/contracts/password-reset.md), then implement them in `backend/src/app/http/openapi/document.ts`.
- Document end-to-end validation steps in [quickstart.md](/Users/dm/conductor/workspaces/radioso/porto/specs/045-password-reset-email/quickstart.md).

## Post-Design Constitution Check

- No constitution conflicts introduced by the design.
- TDD remains explicit in task ordering.
- OpenAPI and docs update requirements are captured.
- Module boundaries stay intact through dedicated auth recovery and email modules.

## Complexity Tracking

No constitution violations require justification.
