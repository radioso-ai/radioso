# Feature Specification: EE Organization Creation Rate Limit

**Feature Branch**: `083-ee-org-creation-rate-limit`  
**Created**: 2026-06-09  
**Status**: Approved  
**Input**: User description: "We need EE functionality to limit organization creation for lowest tiers so that we don't allow indefinite org creation. Rate limit it — say 10 per user per month, with a possibility to override. I want users to create orgs, but limit malicious uncontrollable growth."

**Scope Note**: This feature adds a per-user, anti-abuse velocity cap on creating *additional* organizations. It is deliberately NOT a per-account usage-limit profile dimension: org creation is a per-user action that spans accounts, so it cannot be expressed by the existing per-account `ee_usage_limit_profiles`. Signup (a user's first organization) is never rate-limited.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Cap Runaway Organization Creation (Priority: P1)

As a Radioso operator, I want each user limited to a bounded number of new organizations per calendar month so that a single account cannot mint organizations indefinitely and drive uncontrolled tenant, storage, and provider-cost growth.

**Why this priority**: Unbounded org creation is an open abuse vector today — `createOrganization` has no quota, and every new org auto-receives a fresh free usage profile, so one user can self-provision unlimited free quota.

**Independent Test**: Create organizations as one user up to the configured monthly cap, then attempt one more; verify the cap-reaching attempt is rejected and no organization, workspace, membership, or session is created.

**Acceptance Scenarios**:

1. **Given** a user has created fewer than the monthly limit of organizations this calendar month, **When** they create another organization, **Then** the organization is created and the user's monthly creation count increases by one.
2. **Given** a user has reached the monthly organization-creation limit, **When** they attempt to create another organization, **Then** the request is rejected with HTTP 429 and a message stating the limit and the reset time, and no account/workspace/membership/session is created.
3. **Given** a user reached the limit in the prior calendar month, **When** the new calendar month (UTC) begins, **Then** their available creations reset and they may create organizations again.

---

### User Story 2 - Legitimate Users Still Create Organizations Freely (Priority: P1)

As a normal user, I want to keep creating organizations for real needs without friction below the cap, and when I do hit the cap I want a clear, honest explanation rather than a generic failure.

**Why this priority**: The goal is to stop abuse, not to block product usage. A confusing or silent failure would damage trust and support load.

**Independent Test**: With enforcement enabled, create several organizations below the cap and confirm each succeeds; trigger the cap and confirm the error message names the limit and the reset date.

**Acceptance Scenarios**:

1. **Given** enforcement is enabled and a user is below the cap, **When** they create an organization, **Then** it succeeds exactly as before this feature (same response shape, workspace, membership, session).
2. **Given** a user hits the cap, **When** the rejection is returned, **Then** the error identifies it as a rate limit, states the limit value, and states when creation becomes available again.
3. **Given** a user's first-ever organization is created at signup, **When** they register, **Then** registration is never blocked by this cap.

---

### User Story 3 - Operator Override Per User (Priority: P2)

As a Radioso operator, I want to raise or remove the organization-creation cap for a specific user (e.g. a partner who legitimately provisions many tenants) without changing the global default.

**Why this priority**: A single global number cannot serve both abuse prevention and legitimate high-volume users; overrides keep the default safe while allowing exceptions.

**Independent Test**: Set a per-user override above the default, then create more organizations than the default allows for that user; confirm success. Set an "unlimited" override and confirm no cap applies. Remove the override and confirm the default applies again.

**Acceptance Scenarios**:

1. **Given** a per-user override of N is set for a user, **When** that user creates organizations, **Then** the effective monthly limit for that user is N, not the global default.
2. **Given** a per-user override marks a user as unlimited, **When** that user creates organizations, **Then** no monthly cap is enforced for that user.
3. **Given** an override is removed, **When** the user next creates an organization, **Then** the global default limit applies.

### Edge Cases

- Organization creation succeeds the reservation but the account/workspace/membership transaction then fails — the reserved creation MUST be released so the failed attempt does not consume the user's monthly budget.
- A user deletes organizations after creating them — deletions MUST NOT refund the monthly creation count (otherwise create/delete churn evades the cap). The count is a monotonic velocity meter within the month.
- Two organization-creation requests from the same user race at the boundary of the cap — only requests within the cap may succeed; the counter increment MUST be atomic.
- Enforcement runs in an OSS (non-EE) deployment — the cap MUST be a no-op (all creations allowed) so OSS behavior is unchanged.
- The admin override API is called without the configured admin token — the request MUST be rejected, consistent with the existing EE usage-limit admin API.
- The global default env var is unset — a safe built-in default (10) applies.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved (Spec-First, NON-NEGOTIABLE).
- Backend development MUST follow TDD: failing tests authored before implementation (Backend TDD, NON-NEGOTIABLE).
- Backend MUST be Node.js/TypeScript; database MUST be PostgreSQL.
- Enforcement, counters, and overrides MUST preserve modular boundaries: auth orchestration reserves through a narrow port and MUST NOT contain EE counting logic, SQL, or env policy.
- New replaceable runtime wiring (the OSS no-op default and the EE enforcing implementation of the guard port) MUST be assembled in `backend/src/app/composition/` and the EE module, not inside domain services.
- New configuration (global default env var, admin token reuse) MUST update `.env.example`.
- Public contract changes (the 429 error shape on `POST /account/accounts`, and any admin override endpoints) MUST update the code-first OpenAPI registry and regenerate `backend/openapi.yaml` / `backend/openapi.json`, with a message-queue impact review (expected: none — no worker/queue payloads change).
- Operator-facing documentation for the new env var, the cap behavior, and the override API MUST be updated in the same change (EE operator docs).
- No user-facing conversational/assistant copy is introduced; the 429 message is an operator/API error string, not assistant output.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: The per-user creation cap is anti-abuse velocity policy and is distinct from per-account usage-limit quota. It MUST be a separate, narrow port (e.g. `OrganizationCreationGuard`) — NOT a new method on `UsageLimitPolicy` and NOT a new column on `ee_usage_limit_profiles`. The consumer is auth (`AuthService.createOrganization`); the subject is the user.
- **Encapsulation Rule**: `AuthService` MUST only reserve/commit/release through the guard port. It MUST NOT know about counters, calendar periods, override tables, env defaults, or SQL. All counting and limit-resolution logic lives in the EE implementation.
- **Default-Off Rule**: OSS ships a no-op guard that always allows creation. The EE backend module registers the enforcing implementation, mirroring how `NoopUsageLimitPolicy` is replaced by `EnterpriseUsageLimitService`.
- **Reservation Rule**: The guard exposes a reservation lifecycle (reserve → commit/release) consistent with the existing `UsageLimitReservation` shape. Reserve happens before account creation; commit on success; release only when the creation transaction fails. Release MUST NOT be wired to later organization deletion.
- **Hook-Point Rule**: Only `AuthService.createOrganization` (additional orgs, `POST /account/accounts`) is metered. `AuthService.register` (signup, first org) is NOT metered.
- **Counting Rule**: The cap is a per-user, per-calendar-month (UTC) velocity meter — count of *creations*, not count of currently-owned organizations. Deleting orgs does not lower the meter within the month.
- **Anti-Goals**: Do not refund the meter on org deletion. Do not block signup. Do not encode the limit as a per-account profile field. Do not put env-reading or SQL in `AuthService`. Do not record raw credentials, session material, or PII in logs/audit metadata beyond user/account identifiers already used by existing auth audit events.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Creating an additional organization (`AuthService.createOrganization`) MUST reserve one unit of the actor user's monthly organization-creation budget before any account/workspace/membership/session is created.
- **FR-002**: When the reservation would exceed the user's effective monthly limit, organization creation MUST be rejected with HTTP 429 and MUST NOT create any account, workspace, membership, or session.
- **FR-003**: The 429 rejection MUST convey that it is a rate limit, the effective limit value, and the reset time (start of the next UTC calendar month).
- **FR-004**: On successful organization creation, the user's monthly creation count MUST increase by exactly one (atomic with respect to concurrent creation attempts).
- **FR-005**: If account/workspace/membership/session creation fails after the reservation succeeds, the reservation MUST be released so the failed attempt does not consume the user's budget.
- **FR-006**: Deleting an organization MUST NOT decrement any user's monthly creation count.
- **FR-007**: Signup (`AuthService.register`) MUST NOT be subject to the cap.
- **FR-008**: The effective monthly limit for a user MUST resolve as: per-user override when present, otherwise the global default. An override MAY express "unlimited".
- **FR-009**: The global default limit MUST be configurable via an environment variable (`EE_MAX_ORGS_PER_USER_PER_MONTH`) and MUST default to 10 when unset.
- **FR-010**: Operators MUST be able to set, change, and remove a per-user override (including "unlimited") via an authenticated admin interface guarded by the existing `EE_USAGE_ADMIN_TOKEN`.
- **FR-011**: In a deployment without the EE module, the cap MUST be a no-op: all organization creations are allowed and no counters are written.
- **FR-012**: The monthly counter MUST reset at the start of each UTC calendar month, consistent with the existing EE monthly answer-counter period semantics.
- **FR-013**: Concurrent organization-creation attempts by the same user at the cap boundary MUST NOT allow the count to exceed the effective limit.
- **FR-014**: A rate-limit rejection MUST emit an observability signal (structured log and/or an `account.create` failure audit event with reason `rate_limited`) without recording credentials, session material, or content.
- **FR-015**: Existing successful organization-creation behavior and response shape MUST be unchanged below the cap.

### Key Entities *(include if feature involves data)*

- **Organization Creation Counter**: A per-user, per-UTC-month monotonic count of successful (reserved-and-committed) organization creations. Equivalent shape: `(user_id, period_start DATE, used_count INTEGER)`, primary key `(user_id, period_start)`.
- **Organization Creation Override**: An optional per-user effective-limit override, including an "unlimited" representation. Equivalent shape: `(user_id UUID PRIMARY KEY, monthly_limit INTEGER NULL)` where `NULL` may represent unlimited (exact null/sentinel semantics decided at plan time).
- **Organization Creation Reservation**: The in-flight reservation lifecycle (reserve → commit/release) used by `AuthService.createOrganization`, mirroring the existing `UsageLimitReservation` contract.

## Data Model Direction

The EE usage-limits migrator (or a sibling EE migrator) SHOULD add tables equivalent to:

```sql
ee_org_creation_counters (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, period_start)
)

ee_org_creation_overrides (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  monthly_limit INTEGER,            -- semantics for NULL = unlimited decided at plan time
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

Enforcement SHOULD reuse the atomic increment pattern already used by `EnterpriseUsageLimitService.reserveAnswer` (`UPDATE ... WHERE used_count < limit RETURNING`) so the boundary check and increment are a single atomic statement. Exact table/column names may change during implementation, but the per-user monthly monotonic-counter, release-on-failure-only, and override-resolution semantics MUST remain intact.

## API Direction

- `POST /account/accounts` gains a documented `429` response with an error shape consistent with the existing error envelope (`{ error: { code, message, details } }`), where `details` SHOULD carry the effective `limit`, `used`, `periodStart`, and `resetAt`.
- A new EE admin surface (mounted under the existing EE usage-limit admin router, guarded by `EE_USAGE_ADMIN_TOKEN`) SHOULD allow reading and writing a user's override, e.g. `GET`/`PUT`/`DELETE` on `/api/v1/ee/org-creation/users/:userId`. Exact path finalized at plan time.

## Observability

- A rate-limit rejection SHOULD produce a structured warning log and/or an `account.create` audit event with `eventStatus: "failure"` and reason `rate_limited`, carrying only user/account identifiers and counter context (limit, used, periodStart) — never credentials, session tokens, or content.
- No new metrics with high cardinality. A low-cardinality counter of rate-limit rejections is acceptable if the deployment exposes one.

## Assumptions

- The existing EE backend module is the correct home for the enforcing guard, counters, overrides, and admin API.
- `users.id` is the correct subject identifier for the per-user cap (the actor in `createOrganization`).
- Calendar-month (UTC) periods match the existing EE monthly-counter semantics and are acceptable to operators.
- The override "unlimited" representation can be modeled with the override table; exact null/sentinel choice is a plan-time detail.
- No message-queue or worker payloads are affected.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With EE enabled and the default limit, a single user can create up to the configured number of organizations in a calendar month and is rejected with HTTP 429 on the next attempt, with no partial account/workspace/membership/session left behind.
- **SC-002**: A failed account/workspace creation after a successful reservation leaves the user's monthly count unchanged (release verified).
- **SC-003**: Deleting organizations does not increase a user's remaining monthly creations (no refund).
- **SC-004**: Signup is never blocked by the cap, regardless of the user's monthly creation count.
- **SC-005**: A per-user override (raised value and "unlimited") changes that user's effective limit without affecting other users or the global default.
- **SC-006**: Concurrent creation attempts at the cap boundary never exceed the effective limit (verified by a concurrency test).
- **SC-007**: In an OSS deployment, organization creation is unlimited and no org-creation counters are written.
- **SC-008**: A rate-limit rejection produces the documented observability signal without leaking credentials, session material, or content.
