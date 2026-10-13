# Feature Specification: Auth Funnel Completion

**Feature Branch**: `feat/auth-funnel-routes-1156`

**Created**: 2026-10-13

**Status**: Approved by GitHub issue #1156

**Input**: Complete the first-time authentication funnel with linkable routes, automatic session issuance after email verification, a browser-bound waiting-tab exchange, a development verification link, and registration-side Google sign-in.

## User Scenarios & Testing

### User Story 1 - Link Directly To Authentication Modes (Priority: P1)

A visitor can open `/login` or `/signup` directly, while `/` remains a compatible sign-in entry point. A signed-in visitor reaching either auth route is sent to the dashboard.

**Independent Test**: Open `/signup` with a failed registration-availability probe and confirm the registration form remains usable; sign in and confirm `/login` and `/signup` leave the auth surface.

### User Story 2 - Verify And Arrive Signed In (Priority: P1)

A registrant follows the emailed verification link and receives a normal authenticated session without re-entering credentials.

**Independent Test**: Register, follow a valid link, and reach the signed-in dashboard; replay or expire the link and confirm no session is created.

### User Story 3 - Waiting Registration Tab Completes (Priority: P1)

The browser that registered holds a short-lived httpOnly pending ticket. Its inbox screen polls a protected status exchange and becomes signed in after verification completes in another tab.

**Independent Test**: Register in one tab, verify in another tab, and confirm the registering tab exchanges its own ticket exactly once and reaches the dashboard.

### User Story 4 - Development And Federated Shortcuts (Priority: P2)

Development can expose the verification URL in the registration response and UI under a development-only configuration. When Enterprise Google login reports enabled, registration offers the same provider start flow as login; otherwise it renders nothing.

**Independent Test**: Enable development-link exposure and confirm the inbox screen shows the link; stub Google disabled/enabled and confirm only the enabled response renders the action.

### Edge Cases

- Invalid, expired, stale, or replayed verification tokens never create sessions.
- Missing, expired, invalid, or replayed pending tickets return the same not-ready response and do not reveal account existence.
- Concurrent exchanges of the same verification token or pending ticket produce at most one session.
- Registration availability failures do not make `/signup` disappear.
- Production configuration rejects development verification-link exposure.

## Requirements

### Functional Requirements

- **FR-001**: The web app MUST expose `/login` and `/signup`, preserve `/`, and redirect signed-in users away from auth routes.
- **FR-002**: Successful email verification MUST atomically consume the single-use, expiring, user-bound verification token and create a session using existing cookie security attributes.
- **FR-003**: Registration requiring verification MUST issue a short-lived, single-use pending ticket only in an httpOnly cookie.
- **FR-004**: A rate-limited pending-session endpoint MUST exchange a valid ticket for a session only after its bound user is verified and MUST use a constant response shape for ready and not-ready outcomes.
- **FR-005**: Pending tickets MUST never appear in URLs or response bodies.
- **FR-006**: A development-only setting MAY add the verification URL to the registration response; production configuration MUST reject that setting.
- **FR-007**: The registration card MUST reuse the Enterprise Google availability and start surfaces and render no Google action when disabled or unavailable.
- **FR-008**: Public API changes MUST update OpenAPI, the TypeScript SDK snapshot, and the MCP OpenAPI snapshot.
- **FR-009**: Auth/setup documentation MUST describe the routes, session-on-verify behavior, pending exchange, and development link setting.
- **FR-010**: This operator authentication surface is excluded from Ray tool coverage because pre-authentication navigation and credential/session issuance cannot be safely proposed or executed by an authenticated operator copilot.

### Key Entities

- **Email verification token**: Existing hashed, expiring credential bound to one login user; consumed once.
- **Pending registration ticket**: New hashed, expiring credential bound to one login user and held only by the registering browser cookie.
- **Session**: Existing authenticated browser session created as part of a successful atomic exchange.

## Success Criteria

- **SC-001**: All three entry URLs show the intended auth mode, including `/signup` during an availability-probe failure.
- **SC-002**: Verification and waiting-tab journeys reach the dashboard without password re-entry.
- **SC-003**: Integration tests prove expired/replayed credentials cannot create a session and concurrent claims are single-use.
- **SC-004**: Disabled Google login produces no registration-side provider action.

## Assumptions And Scope

- Existing email verification issuance, resend behavior, user verification state, and `AUTH_AUTO_VERIFY_EMAIL` behavior from `specs/046-email-verification/` remain the base.
- PR #1430 changed onboarding progress and analytics only; it did not modify the auth funnel.
- No OAuth backend changes, new queue payloads, or worker behavior are in scope.
