# Tasks: Email Verification Gate

## Phase 1: Setup

- [x] T001 Refresh backend/frontend auth feature artifacts in `specs/046-email-verification/plan.md`, `specs/046-email-verification/tasks.md`, and supporting design docs

## Phase 2: Foundational

- [x] T002 Add failing backend unit/integration/contract tests for verification state, token lifecycle, blocked login, and resend in `backend/tests/unit/auth-service.test.ts`, `backend/tests/unit/email-verification-service.test.ts`, `backend/tests/integration/auth.integration.test.ts`, and `backend/tests/contract/auth.contract.test.ts`
- [x] T003 [P] Add failing frontend auth flow tests for verification-pending registration, blocked login, resend, and verify screen in `frontend/tests/unit/email-verification-flow.test.tsx`
- [x] T004 Add verification persistence seams in `backend/src/db/migrations/018_email_verification_tokens.sql`, `backend/src/db/repositories/userRepository.ts`, and `backend/src/db/repositories/emailVerificationTokenRepository.ts`

## Phase 3: User Story 1 - Register and verify before first login

Independent test: register returns verification-pending without session, blocked login returns verification-required, verification completes, and login succeeds afterward.

- [x] T005 [US1] Implement verification domain/service orchestration in `backend/src/modules/auth/domain/emailVerification.ts` and `backend/src/modules/auth/services/emailVerificationService.ts`
- [x] T006 [US1] Update auth orchestration and transport for register/login/verify in `backend/src/modules/auth/services/authService.ts` and `backend/src/app/http/routes/authRoutes.ts`
- [x] T007 [US1] Update backend dependency wiring and OpenAPI source of truth in `backend/src/app/server/dependencies.ts`, `backend/src/app/server/types.ts`, and `backend/src/app/http/openapi/document.ts`
- [x] T008 [US1] Regenerate generated API artifacts in `backend/openapi.yaml` and `backend/openapi.json`
- [x] T009 [US1] Update frontend registration and verification-complete flow in `frontend/components/auth/register-form.tsx`, `frontend/app/verify-email/page.tsx`, and `frontend/components/auth/verify-email-screen.tsx`

## Phase 4: User Story 2 - Explicit resend verification email

Independent test: resend accepts for an unverified user, issues a fresh email, and stale tokens are rejected.

- [x] T010 [US2] Add resend orchestration and email support in `backend/src/modules/auth/services/emailVerificationService.ts` and `backend/src/modules/email/services/emailService.ts`
- [x] T011 [US2] Add resend route handling and login error mapping in `backend/src/app/http/routes/authRoutes.ts` and `frontend/lib/api.ts`
- [x] T012 [US2] Update login UI with verification-required and resend behavior in `frontend/components/auth/login-form.tsx` and `frontend/lib/auth-context.tsx`

## Phase 5: User Story 3 - Shared identity seam for future auth methods

Independent test: verification state persists on `users` and is consumed through auth orchestration rather than password-reset internals.

- [x] T013 [US3] Keep shared identity seams aligned in `backend/tests/support/fakes.ts`, `backend/tests/support/testApp.ts`, and `backend/src/modules/email/services/emailService.ts`

## Final Phase: Polish & Validation

- [x] T014 Update operator/user docs in `backend/.env.example` and `readme.md`
- [x] T015 Run targeted backend/frontend validation and capture results in feature notes
- [x] T016 Mark completed tasks and prepare review-ready summary in `specs/046-email-verification/tasks.md`

## Validation

- [x] Backend: `npm test -- --run tests/unit/auth-service.test.ts tests/contract/auth.contract.test.ts tests/integration/auth.integration.test.ts tests/integration/password-reset.integration.test.ts`
- [x] Backend: `npm run build`
- [x] Frontend: `npm test -- --run tests/unit/password-reset-flow.test.tsx tests/unit/email-verification-flow.test.tsx`
- [x] Frontend: `npm run build`
