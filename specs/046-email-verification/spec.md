# Feature Specification: Email Verification Gate

**Feature Branch**: `046-email-verification`  
**Created**: 2026-04-22  
**Status**: Draft  
**Input**: User description: "Add initial email verification for login users. After registration, the system sends a one-time verification link through the shared email module. Until that link is used, the user cannot sign in. Verification applies only to the initially registered email address, resend is explicit rather than automatic, and the design must leave room for future auth methods such as Google or GitHub without coupling verification to password-based login only."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Register And Verify Email Before First Login (Priority: P1)

A new user registers with an email address and receives a one-time verification link. They must use that link before they can sign in to the product.

**Why this priority**: This is the core trust boundary. Without initial email verification, the system cannot prove control of the identity used for account creation.

**Independent Test**: Can be fully tested by registering a new user, confirming a verification email is issued, attempting sign-in before verification, then verifying the email and confirming sign-in succeeds.

**Acceptance Scenarios**:

1. **Given** a new user registers with a valid email address, **When** registration completes, **Then** the system creates the user in an unverified state and issues a one-time email verification link.
2. **Given** a user has not verified their email address yet, **When** they attempt to sign in with valid credentials, **Then** the system refuses sign-in and explains that verification is required.
3. **Given** a user follows a valid unused verification link, **When** the system processes the request, **Then** the login identity becomes verified and can sign in successfully afterward.

---

### User Story 2 - Resend Verification Email Explicitly (Priority: P1)

An unverified user who did not receive the first message or whose link is no longer usable can explicitly request a fresh verification email.

**Why this priority**: Blocking sign-in without a recovery path would create unnecessary support burden and strand legitimate users.

**Independent Test**: Can be fully tested by registering a new user, requesting resend, and confirming a new verification link is issued while prior links are handled according to the feature’s validity rules.

**Acceptance Scenarios**:

1. **Given** a user remains unverified, **When** they explicitly request a resend, **Then** the system accepts the request and issues a fresh verification email through the shared email module.
2. **Given** a user is already verified, **When** they request a resend, **Then** the system does not reopen verification or change their verified state.
3. **Given** repeated resend attempts arrive within the protection window, **When** the system evaluates them, **Then** abuse controls limit the flow without creating a user enumeration leak.

---

### User Story 3 - Preserve A Shared Identity Model For Future Auth Methods (Priority: P2)

The system can later add Google, GitHub, or other login methods without rethinking what it means for a user identity to be email-verified.

**Why this priority**: The user explicitly expects additional auth methods later, so this feature must establish the right ownership boundary now.

**Independent Test**: Can be fully tested by reviewing the resulting auth model and contracts to confirm email verification state belongs to the login identity and is not inseparably tied to password reset or password-only login rules.

**Acceptance Scenarios**:

1. **Given** the product later adds another auth method, **When** that method needs to reason about whether a user identity is verified, **Then** the verification state already exists on the shared login identity rather than inside the password sign-in flow.
2. **Given** email verification is implemented for password registration first, **When** future auth methods are introduced, **Then** they can reuse or bypass email-verification rules intentionally rather than inheriting password-specific token behavior by accident.
3. **Given** a verification email is sent, **When** delivery occurs, **Then** the request goes through the shared email capability instead of auth-provider-specific transport code.

### Edge Cases

- What happens when a user attempts to sign in before verifying their email? Sign-in is blocked even if the password is correct.
- What happens when a verification link is expired, invalid, or already used? The system rejects it safely and directs the user to request a resend.
- What happens when a user requests multiple verification emails? The system must define deterministic validity so stale links do not unexpectedly verify the account later.
- What happens when the verification email cannot be delivered immediately? The registration outcome and resend flow must fail safely and remain auditable.
- What happens when a user is already verified? Resend should not regress the user into an unverified state.
- What happens when future Google or GitHub login is added? Email verification state must remain part of the shared login identity model rather than a password-only branch.

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

- **Boundary Rule**: Transport owns request validation and response shaping for registration, verification, resend, and blocked-login responses. Auth orchestration owns registration-time verification issuance, verification confirmation, resend rules, and sign-in gating. Persistence owns user verification state and one-time verification credentials. The shared email module owns message composition and delivery only.
- **Encapsulation Rule**: `backend/src/app/http/routes/authRoutes.ts` must remain transport-only. `backend/src/modules/auth/services/authService.ts` may enforce sign-in gating but must not absorb provider-specific email logic. Email verification state must belong to the shared login identity rather than a password-reset module or password-only auth branch so future Google/GitHub flows can reason about it cleanly.
- **New Seams Required**: A dedicated verification-token seam; persistence for login-identity verification state; auth orchestration for verify/resend/sign-in gating; and shared email message support for verification delivery alongside password reset.
- **Anti-Goals**: Do not reuse password reset tokens for email verification. Do not make verification an account-level concept when the login identity is user-level. Do not silently auto-resend on every sign-in attempt. Do not hard-code future Google/GitHub behavior into this first release.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST create new login users in an unverified email state after initial registration.
- **FR-002**: System MUST send a one-time email verification message through the shared email capability after initial registration.
- **FR-003**: System MUST allow an unverified login user to confirm ownership of their email address by following a valid unused verification link.
- **FR-004**: System MUST reject expired, invalid, or previously used verification credentials.
- **FR-005**: System MUST block sign-in for unverified login users even when their password is correct.
- **FR-006**: System MUST permit sign-in for verified login users using the existing credentials flow.
- **FR-007**: System MUST provide an explicit resend-verification action for unverified login users.
- **FR-008**: System MUST keep resend-verification explicit rather than automatic on login attempts.
- **FR-009**: System MUST avoid leaking whether a verification resend request targets a usable or unusable identity beyond what the current session or registration context already knows.
- **FR-010**: System MUST record auditable events for verification issuance, resend requests, successful verification, invalid verification attempts, expired verification attempts, and blocked sign-in attempts caused by missing verification.
- **FR-011**: System MUST apply abuse controls to verification resend and verification confirmation flows.
- **FR-012**: System MUST keep email verification state on the shared login identity so future auth methods such as Google or GitHub can reason about that state without reworking account membership.
- **FR-013**: System MUST keep initial email verification scoped to the original registered email address only for this feature.
- **FR-014**: System MUST keep email-change verification out of scope for this release.
- **FR-015**: System MUST deliver verification email through the reusable shared email module rather than auth-specific transport code.

### UI Tasks

- Show a post-registration state that tells the new user they must verify their email before signing in.
- Add a verification-complete screen reached from the emailed link.
- Add a blocked sign-in state that explains verification is required before login can proceed.
- Add an explicit resend-verification action for unverified users.
- Show clear invalid-link and expired-link states that direct the user to request a new verification email.
- Preserve the existing dark-theme auth presentation and design tokens across the verification screens and states.

### Key Entities

- **Login User**: The person-level login identity identified by a unique email address. Email verification state belongs here so all auth methods can reference the same source of truth later.
- **Email Verification Credential**: A one-time, time-limited verification artifact tied to a login user and used to confirm ownership of the registered email address.
- **Verification State**: The persisted status that indicates whether the login identity has proven control of the registered email address.
- **Transactional Email Message**: A reusable outbound message handled by the shared email module and used for verification now and other auth workflows later.

## Assumptions

- Registration still creates the login identity before verification is completed.
- The user cannot sign in until verification succeeds, but the system may still show limited post-registration guidance outside the normal signed-in experience.
- Verification in this feature applies only to the initial registered email address.
- Future Google or GitHub auth may satisfy or bypass email-verification requirements differently, so this feature should establish shared verification state rather than embed assumptions inside password-only logic.
- Resend is user-initiated rather than automatic.

## Out of Scope

- Verifying changed email addresses.
- Invitation email verification.
- Magic-link login.
- Automatic resend on login attempts.
- Defining how future Google or GitHub auth providers satisfy verification beyond preserving the correct shared identity seam.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A newly registered user receives clear guidance that email verification is required before first login.
- **SC-002**: A user with a valid verification email can complete verification and successfully sign in in under 3 minutes without support help.
- **SC-003**: Unverified users are consistently blocked from sign-in during acceptance testing even when credentials are otherwise valid.
- **SC-004**: Verified users can sign in through the existing credentials flow without regression to registration, invitation, or account switching flows.
- **SC-005**: Verification email delivery uses the shared email capability with no provider-specific delivery logic duplicated across auth transport or orchestration code.
