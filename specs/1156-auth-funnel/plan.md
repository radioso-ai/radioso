# Implementation Plan: Auth Funnel Completion

**Branch**: `feat/auth-funnel-routes-1156` | **Date**: 2026-10-13 | **Spec**: [spec.md](./spec.md)

## Summary

Finish the auth funnel by adding route-addressable auth pages and by introducing one transaction-owned Postgres exchange boundary for verification tokens and pending registration tickets. HTTP retains cookie and rate-limit concerns; the auth-funnel service generates opaque credentials and delegates atomic claims; frontend pages poll only with browser cookies and navigate through a full session bootstrap.

## Technical Context

**Language/Version**: TypeScript on Node.js 24; TypeScript 5.7, React 19, Next.js 16

**Dependencies**: Express, Zod, Kysely/PostgreSQL, Vitest/Supertest, Playwright

**Storage**: PostgreSQL migration `217_auth_pending_registration_tickets.sql`

**Public contract**: register response gains an optional development URL; verify response creates a session cookie; new pending-session exchange endpoint

## Constitution Check

- Spec-first: satisfied by the approved issue captured in `spec.md`.
- Backend TDD: integration/contract tests are written and observed failing before implementation.
- Stack/secrets/UI: existing stack and auth design tokens remain; the new config is non-secret and production-rejected.
- Boundaries: HTTP owns request/cookie presentation and rate limits; `AuthFunnelService` owns opaque credential orchestration; `AuthFunnelRepository` owns the transaction; existing `AuthService` and mail delivery do not absorb ticket persistence.
- Ports: the service exposes issue, verify-and-session, and exchange-pending operations to auth routes. The repository exposes only atomic persistence operations to the service.
- Dependency direction: route → service port → repository port; the Kysely adapter implements the port; server builders wire it.
- Composition: no new app-wide replaceable adapter is introduced, so existing server dependency builders are the correct wiring owner.
- Observability: reuse success/failure audit events for verification and add bounded success events for pending issuance/exchange; unsuccessful polls stay unaudited to avoid noise. No token, link, email, or cookie values are logged. No metric/span is needed for this short synchronous database path.
- Message queues: no document-worker dispatch, AMQP payload, retry policy, queue test, or queue documentation changes.
- Copilot: explicit coverage-map exclusion because these are unauthenticated credential/session operations.
- Docs/contracts: update readme/auth docs and regenerate OpenAPI, SDK, and MCP snapshots.

## Structure And Ownership

- `backend/src/modules/auth/services/authFunnelService.ts`: token generation, cookie-ready exchange results, no SQL.
- `backend/src/db/repositories/authFunnelRepository.ts`: atomic `FOR UPDATE` claims and session inserts, no HTTP.
- `backend/src/app/http/routes/authRoutes.ts`: validation, rate limiting, Set-Cookie headers, constant response presentation.
- `frontend/components/auth/`: route mode, provider action, pending polling, session navigation.
- `frontend/app/login`, `frontend/app/signup`: linkable entry pages.

## Security Decisions

- Verification token lifetime stays `EMAIL_VERIFICATION_TOKEN_TTL_MINUTES`; pending tickets default to 15 minutes.
- Raw tokens exist only transiently in services; persistence stores SHA-256 hashes.
- The transaction locks and consumes the credential before inserting one session, preventing replay and concurrent double issuance.
- Pending cookies use the existing secure/httpOnly/SameSite/path policy and are cleared after exchange.
- The pending endpoint always returns `{ ready: boolean }` with HTTP 200 after a syntactically valid request; absent/invalid/expired/used tickets are indistinguishable.

## Validation

- Backend integration/contract/unit tests for atomic verification, ticket exchange, rate limiting, config gating, and OpenAPI.
- Playwright for `/signup`, cross-tab verification/polling, verification landing, and register-side Google visibility.
- Required typecheck, lint, scoped ESLint, and dead-code gates.
