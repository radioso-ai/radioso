# Research: EE Organization Creation Rate Limit

## Decision: Separate `OrganizationCreationGuard` port

**Rationale**: Organization creation is a per-user anti-abuse action, not per-account usage. A narrow port lets auth reserve, commit, and release without knowing EE counters, periods, env, or overrides.

**Alternatives considered**:

- Add a method to `UsageLimitPolicy`: rejected because usage limits are per-account resource quotas.
- Add a usage profile dimension: rejected because the subject is the user across accounts.

## Decision: `monthly_limit NULL` means unlimited

**Rationale**: The spec permits a null-or-sentinel choice. `NULL` already represents unlimited in existing usage-limit profile fields, so it is consistent for operators and docs. Missing row means no override; row with `monthly_limit = NULL` means unlimited.

**Alternatives considered**:

- Negative sentinel: rejected because it needs special validation and is less clear in SQL.
- Very large number: rejected because it is not truly unlimited and obscures intent.

## Decision: Atomic reservation uses insert-then-update

**Rationale**: This mirrors `EnterpriseUsageLimitService.reserveAnswer`: create the monthly counter row if absent, then `UPDATE ... WHERE used_count < limit RETURNING used_count`. The increment and boundary check happen in one SQL statement, so concurrent requests cannot exceed the cap.

**Alternatives considered**:

- Read count then update: rejected because concurrent boundary requests can race.
- Serializable transaction only: rejected as heavier than the existing pattern.

## Decision: Admin override routes live under existing EE usage-limit admin router

**Rationale**: Operators already configure usage limits under `/api/v1/ee/usage-limits` with `EE_USAGE_ADMIN_TOKEN`. Adding `/org-creation/users/:userId` keeps the guard consistent and avoids another admin token surface.

**Alternatives considered**:

- Separate `/ee/org-creation` router: rejected because the spec asks to mount under existing EE usage-limit admin router.

## Decision: Frontend surfaces backend message

**Rationale**: The create-organization dialog already displays a single error string. Reusing the API envelope message avoids duplicating reset/limit wording in frontend code and satisfies the clear user explanation requirement.

**Alternatives considered**:

- Hard-code a frontend-specific message: rejected because it can drift from backend details.

## Decision: Message queue impact is none

**Rationale**: This feature changes synchronous auth/account creation and EE admin HTTP APIs only. No document worker dispatch, AMQP queue payload, retry semantics, or worker contract is affected.

**Alternatives considered**: None needed.
