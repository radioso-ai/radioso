# Feature Specification: Password Reset Email Recovery

**Feature Branch**: `045-password-reset-email`  
**Created**: 2026-04-22  
**Status**: Draft  
**Input**: User description: "Add self-serve password reset/access recovery for user login identities, revoke all existing sessions on successful reset, and introduce a reusable provider-agnostic email module for transactional delivery. Scope is password reset only; account invitation email stays out of scope for this feature."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Request Password Reset (Priority: P1)

A signed-out user who can no longer access their password enters their email address and requests a reset link. The system acknowledges the request safely without revealing whether that email address exists.

**Why this priority**: Without a secure request flow, users who lose access to their password have no self-serve recovery path.

**Independent Test**: Can be fully tested by submitting both a known email address and an unknown email address and verifying the response is safe, consistent, and does not reveal account existence.

**Acceptance Scenarios**:

1. **Given** a user submits an email address tied to an existing login identity, **When** they request password reset, **Then** the system accepts the request, creates a time-limited one-time recovery path, and attempts email delivery without exposing internal details.
2. **Given** a user submits an email address that does not belong to any login identity, **When** they request password reset, **Then** the system returns the same outward response used for valid requests.
3. **Given** repeated reset requests arrive for the same user or client within the protection window, **When** the system evaluates the request, **Then** abuse controls limit the flow without exposing whether the target email exists.

---

### User Story 2 - Reset Password and Restore Access (Priority: P1)

A user follows the reset link from their email, chooses a new password, and regains access to the product without support intervention.

**Why this priority**: Recovery is only valuable if the emailed flow can be completed successfully and result in restored access.

**Independent Test**: Can be fully tested by requesting a reset, opening the one-time link, setting a new password, and confirming the user can sign in with the new credentials.

**Acceptance Scenarios**:

1. **Given** a valid unused reset link, **When** the user submits a compliant new password, **Then** the password is updated and the reset link becomes unusable for any later attempt.
2. **Given** an expired, invalid, or previously used reset link, **When** the user attempts to complete the flow, **Then** the reset is rejected safely and the user is directed to start a new recovery request.
3. **Given** a user completes a successful reset, **When** recovery finishes, **Then** the product restores them to an accessible signed-in account context without requiring manual operator action.

---

### User Story 3 - Revoke Existing Sessions After Reset (Priority: P1)

When a user resets their password, any previously issued sessions for that login identity stop working so access is not silently retained on old devices or stolen sessions.

**Why this priority**: Password reset is a security recovery action, so retaining old sessions would undermine the purpose of the flow.

**Independent Test**: Can be fully tested by keeping an existing authenticated session active, completing a password reset for the same user, and verifying the old session no longer authorizes account-scoped requests.

**Acceptance Scenarios**:

1. **Given** a user has one or more active sessions, **When** they successfully reset their password, **Then** all previously issued sessions for that user are revoked.
2. **Given** an old session cookie is used after the reset completes, **When** the backend validates the session, **Then** the request is rejected because the session is no longer active.

---

### User Story 4 - Reusable Email Delivery Module (Priority: P2)

Operators can rely on one shared transactional email capability for password reset now and other future product workflows later, rather than having delivery logic duplicated across auth and account features.

**Why this priority**: The user explicitly wants a reusable module, and that seam must be established now so future email features do not scatter provider logic throughout the codebase.

**Independent Test**: Can be fully tested by exercising password reset delivery through the shared email capability and verifying the same module can represent provider configuration, message composition, delivery outcomes, and safe local-development behavior.

**Acceptance Scenarios**:

1. **Given** the product needs to send a password reset email, **When** the flow triggers delivery, **Then** the request goes through a shared email capability rather than feature-specific transport code.
2. **Given** the delivery provider configuration changes, **When** operators update the environment settings, **Then** the password reset feature continues to use the shared email capability without auth-specific rewiring.
3. **Given** local development or non-delivery environments are in use, **When** a reset request is made, **Then** the shared email capability fails safely or uses a non-production mode without changing the user-facing recovery contract.

### Edge Cases

- What happens when a reset request is made for an email address that does not exist? The outward response remains the same as a valid request so account existence is not disclosed.
- What happens when multiple reset emails are requested in a short period? Abuse controls throttle the flow, and only a valid unexpired one-time recovery path can be used successfully.
- What happens when a user opens an older reset link after requesting a newer one? The system must define a deterministic validity rule so stale links cannot reset the password unexpectedly.
- What happens when a reset link is replayed after the password was already changed? The replay is rejected and the user is asked to start a new recovery request.
- What happens when email delivery is temporarily unavailable? The request flow fails safely, is auditable, and does not expose internal provider details to the end user.
- What happens when a user belongs to multiple accessible accounts? Recovery restores access to a valid signed-in account context without changing membership or granting new account access.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; runtime conversational copy MUST be generated by the LLM so multilingual behavior remains intact.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Transport owns request validation and response shaping for recovery endpoints and recovery UI submissions. Auth orchestration owns reset request handling, token validation, password rotation, and session revocation. Persistence owns users, recovery-token lifecycle state, and session state. A dedicated email module owns message composition and provider delivery behind a reusable interface.
- **Encapsulation Rule**: `backend/src/app/http/routes/authRoutes.ts` must remain transport-only. `backend/src/modules/auth/services/authService.ts` must remain focused on authentication/session orchestration and must not absorb provider-specific email delivery logic. The new email module must not own auth policy, session revocation, or account-access rules.
- **New Seams Required**: A reusable email module for transactional outbound delivery; a focused password reset service; a repository for one-time password reset tokens; and session-management support for revoking all sessions that belong to a user after a successful reset.
- **Anti-Goals**: Do not place SMTP or provider calls inside route handlers or auth orchestration services. Do not model recovery in terms of account records when user login identity is the source of truth. Do not reuse invitation tokens or invitation state for password reset. Do not make password reset depend on future invitation-email work.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow a signed-out user to request password reset by submitting the email address of their login identity.
- **FR-002**: System MUST return a consistent outward response for password reset requests regardless of whether the email address exists.
- **FR-003**: System MUST create a one-time, time-limited recovery credential for valid password reset requests.
- **FR-004**: System MUST deliver password reset messages through a shared transactional email capability rather than feature-specific delivery code.
- **FR-005**: System MUST support provider-agnostic email configuration so operators can change delivery backends without rewriting auth behavior.
- **FR-006**: System MUST allow a user with a valid unused recovery credential to set a new password.
- **FR-007**: System MUST reject expired, invalid, or previously used recovery credentials.
- **FR-008**: System MUST invalidate recovery credentials after successful password reset.
- **FR-009**: System MUST revoke all previously issued sessions for the user immediately after a successful password reset.
- **FR-010**: System MUST prevent revoked pre-reset sessions from authorizing later account-scoped requests.
- **FR-011**: System MUST preserve the user's existing account memberships and restore access only within accounts they could already access before the reset.
- **FR-012**: System MUST record auditable events for password reset request attempts, successful resets, rejected resets, and session revocation outcomes.
- **FR-013**: System MUST apply abuse controls to password reset request and completion flows.
- **FR-014**: System MUST provide a user-facing way to start password reset from the existing sign-in experience.
- **FR-015**: System MUST provide a dedicated user-facing flow to set a new password from the emailed recovery link.
- **FR-016**: System MUST keep password reset email delivery scoped to the shared email capability so future product features can reuse the same module.
- **FR-017**: System MUST keep account invitation email delivery out of scope for this feature.

### UI Tasks

- Add a `Forgot password?` entry point from the existing sign-in experience.
- Add a password reset request screen where a user can submit their email address.
- Add a password reset completion screen reached from the emailed recovery link.
- Show safe success messaging after reset request without revealing whether the email exists.
- Show clear invalid-link and expired-link states that direct the user to request a new recovery email.
- Preserve the existing dark-theme auth presentation and design tokens across the new recovery screens.

### Key Entities

- **Login User**: The person-level login identity identified by a unique email address and password. This is the subject of password recovery.
- **Password Reset Credential**: A one-time, time-limited recovery artifact tied to a login user and used to authorize password replacement.
- **User Session**: An authenticated session tied to a login user and a currently active account context. Existing sessions must be revocable after recovery.
- **Transactional Email Message**: A reusable outbound message object handled by the shared email module and used for password reset now and other product workflows later.

## Assumptions

- Password reset applies to the existing user login identity, not to account deletion or account restoration.
- Successful password reset should leave account memberships unchanged and should not create, remove, or transfer account access.
- Restored access may land the user in a default or previously preferred accessible account context as long as it does not expand access scope.
- The first implementation only needs to support password reset email delivery, but the shared email module must be reusable by future features.
- Local and test environments may use a non-production delivery mode while preserving the same auth and audit behavior.

## Out of Scope

- Sending account invitation emails.
- Undeleting accounts, workspaces, users, or documents.
- Adding role changes, membership changes, or new account-selection behavior beyond what is required to restore an existing user to an accessible signed-in context.
- Building a generic notification center or non-email notification channels.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user who knows their account email can request password recovery from the sign-in experience in under 30 seconds.
- **SC-002**: A user with a valid reset email can complete password reset and restore access in under 3 minutes without support involvement.
- **SC-003**: Reset request responses do not reveal account existence during acceptance testing for known and unknown email addresses.
- **SC-004**: Previously issued sessions for the same user fail authorization on the next protected request after a successful password reset.
- **SC-005**: The shared email capability is the only delivery path used by password reset, with no provider-specific email logic duplicated across auth transport or orchestration code.
