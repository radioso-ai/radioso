# Data Model: EE Organization Creation Rate Limit

## Organization Creation Counter

Tracks successful additional-organization creations by user and UTC calendar month.

| Field | Type | Rules |
|-------|------|-------|
| `user_id` | UUID | References `users(id)` with cascade delete |
| `period_start` | DATE | First day of UTC calendar month |
| `used_count` | INTEGER | `>= 0`, monotonic within the month |
| `updated_at` | TIMESTAMPTZ | Updated whenever the counter changes |

Primary key: `(user_id, period_start)`.

State transitions:

- Reservation increments `used_count` atomically if `used_count < effective_limit`.
- Commit is a no-op because reserve already consumed the count.
- Release decrements `used_count` only for a failed create-organization provisioning path.
- Organization deletion never changes the counter.

## Organization Creation Override

Stores an optional per-user override for the monthly cap.

| Field | Type | Rules |
|-------|------|-------|
| `user_id` | UUID | Primary key, references `users(id)` with cascade delete |
| `monthly_limit` | INTEGER NULL | `NULL` means unlimited; non-null must be `>= 0` |
| `updated_at` | TIMESTAMPTZ | Updated on write |

Semantics:

- Missing row: use `EE_MAX_ORGS_PER_USER_PER_MONTH` or built-in default `10`.
- Present row with integer: use that integer as the effective limit.
- Present row with `NULL`: unlimited, no counter increment is required.

## Organization Creation Reservation

Runtime object returned by `OrganizationCreationGuard.reserve`.

Fields held internally by the EE implementation:

- `userId`
- `periodStart`
- `limit`
- `usedAfterReservation`
- `released` / `committed` state for idempotent lifecycle methods

Lifecycle:

1. `reserve({ userId })`
2. `commit()` after successful account/workspace/membership/session creation
3. `release()` only from the rollback catch path
