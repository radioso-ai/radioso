# Implementation Plan: Email Verification Gate

**Branch**: `borohhov/email-verification` | **Date**: 2026-04-22 | **Spec**: [spec.md](./spec.md)

## Summary

Add initial email verification to the shared login identity. Registration creates an unverified user and account, issues a one-time verification email through the shared email module, and returns a verification-pending response without starting a session. Login is blocked for unverified users. The flow adds explicit resend and verify actions while preserving a user-level verification seam that future Google/GitHub auth methods can reuse.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24 backend, TypeScript 5.7 / React 19 / Next.js 16 frontend
**Primary Dependencies**: Express, Zod, pg, Pino, Vitest, Supertest, shared `EmailService`
**Storage**: PostgreSQL 16 with additive user and verification-token columns/tables
**Testing**: Vitest unit/integration/contract tests on backend, Vitest frontend unit tests
**Target Surface**: `backend/src/modules/auth`, `backend/src/modules/email`, `backend/src/app/http/routes/authRoutes.ts`, `backend/src/app/http/openapi/document.ts`, `frontend/components/auth`, `frontend/app`

## Constitution Check

- Spec-first delivery: satisfied by approved `spec.md`.
- Backend TDD: backend verification changes will land through failing unit/integration/contract tests first.
- Stack discipline: Node/React/Postgres remain unchanged.
- Secrets/config hygiene: any new env keys must update `backend/.env.example`.
- UI consistency: auth screens will reuse the existing shared dark-theme auth presentation.
- Modularity: `authRoutes.ts` remains transport-only; auth orchestration owns registration/login gate/verify/resend; persistence owns user verification state and tokens; email module owns composition/delivery.
- API contract parity: backend HTTP changes update `backend/src/app/http/openapi/document.ts` and regenerate `backend/openapi.yaml` and `backend/openapi.json`.
- Documentation parity: README and quickstart updated for the new auth behavior.

## Architecture

### Backend seams

- `AuthService`
  - create users in unverified state on registration
  - issue verification credentials through a dedicated verification service
  - block login when `emailVerifiedAt` is null
- `EmailVerificationService`
  - issue one-time verification tokens
  - confirm tokens
  - resend tokens explicitly for unverified identities
- `UserRepository`
  - persist `emailVerifiedAt`
  - mark a user verified
- `EmailVerificationTokenRepository`
  - create/find/invalidate one-time tokens separate from password reset tokens
- `EmailService`
  - add typed verification email support

### Frontend seams

- `RegisterForm`
  - submit registration and transition to a verification-pending state instead of logging in
- `LoginForm`
  - surface verification-required failure and explicit resend action
- `app/verify-email/page.tsx`
  - handle verification token completion
- `lib/api.ts`
  - add verify/resend requests and updated register contract types

## Data Changes

- Add `users.email_verified_at TIMESTAMPTZ NULL`
- Add `email_verification_tokens` with `user_id`, `token_hash`, `expires_at`, `used_at`, `created_at`, request metadata

## API Changes

- `POST /api/v1/auth/register`
  - returns verification-pending payload, no session cookie
- `POST /api/v1/auth/login`
  - returns `403` verification-required error for unverified users
- `POST /api/v1/auth/email-verification/verify`
- `POST /api/v1/auth/email-verification/resend`

## Risks / Mitigations

- Existing tests assume registration auto-authenticates: update contract/integration coverage first so drift is explicit.
- Password reset work is already present on this branch: share the email module and auth seams without changing reset scope.
- Future auth methods: keep verification state on `users`, not sessions or password-only modules.

## Validation Plan

- Backend unit: auth service, verification service, email service
- Backend integration/contract: register/login/verify/resend flows and OpenAPI alignment
- Frontend unit: register pending state, login resend state, verify-email screen
- Build validation: `backend npm run build`, `frontend npm run build`
