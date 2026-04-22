# Research: Password Reset Email Recovery

## Decision: Use one-time hashed reset tokens in a dedicated `password_reset_tokens` table

**Rationale**: The feature needs deterministic invalidation, expiry checks, replay protection, and auditability without storing bearer secrets in plaintext. A dedicated table keeps password reset state isolated from invitations and existing sessions while allowing newer requests to supersede older ones safely.

**Alternatives considered**:
- Reuse account invitation tokens: rejected because recovery is a different security workflow with different lifecycle rules.
- Signed stateless tokens only: rejected because revocation, single-use enforcement, and stale-link invalidation are harder to enforce centrally.

## Decision: Revoke all existing sessions by user ID during successful reset confirmation

**Rationale**: The spec requires immediate invalidation of all prior sessions. Extending the session repository with a `revokeAllForUser` operation keeps the rule in persistence and makes old cookies fail on the next protected request.

**Alternatives considered**:
- Rotate only the current account session: rejected because users can have multiple active sessions and accounts.
- Embed a password version into session validation: rejected because the current session model already supports revocation timestamps and a direct revoke operation is simpler.

## Decision: Introduce a provider-agnostic email module with typed messages and pluggable drivers

**Rationale**: The user explicitly wants a reusable module. A module-level email service with `noop/log` and `smtp` drivers creates a stable seam now without binding auth to a specific provider. Future invitation or notification flows can reuse the same message contract.

**Alternatives considered**:
- Put SMTP calls into auth services: rejected because it violates module ownership and prevents reuse.
- Build only a password-reset-specific sender: rejected because it would force future duplication.

## Decision: Keep request abuse controls at the route layer and make the service response uniform

**Rationale**: Existing auth flows already use route-level abuse control middleware. Reusing that pattern preserves transport ownership, while the password reset service can always return the same outward response even when the email is unknown or delivery fails.

**Alternatives considered**:
- Put rate limiting inside the service: rejected because abuse control is already standardized as HTTP middleware.
- Return different statuses for delivery failure or unknown email: rejected because it leaks account existence and provider health.

## Decision: Implement frontend recovery as a dedicated reset route plus a request form linked from the existing login screen

**Rationale**: The app already centralizes signed-out auth UI under `frontend/components/auth/`. Adding a request form reachable from login and a dedicated reset-link route keeps the flow discoverable and minimizes auth-surface sprawl.

**Alternatives considered**:
- Hide reset behind an API-only flow: rejected because FR-014 and FR-015 require explicit user-facing flows.
- Add reset UI into the login form only: rejected because request and confirm states need independent routing and link handling.
