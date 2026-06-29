# Data Model: Operator Console

All new tables are **EE-owned** (`ee_*` prefix), defined in
`ee/packages/backend-module/src/db/eeSchema.ts` and created by a new
`staffConsoleMigrator` (mirroring `usageLimitMigrator`). OSS tables are read
through the EE Kysely as a read-only subset. Operators are **platform-global** —
no workspace/account scoping on staff identities.

## New EE tables

### `ee_staff_users`

A Radioso operator identity, separate from customer `accounts`/`users`.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `email` | text | login identifier; `UNIQUE` (lower-cased) |
| `name` | text | display name |
| `password_hash` | text | bcryptjs, cost 12 (EE-local `staffCrypto`) |
| `role` | text | `support_read` \| `billing_write` \| `owner` (ranked) |
| `status` | text | `active` \| `disabled` |
| `created_at` | timestamptz | default `now()` |
| `updated_at` | timestamptz | default `now()` |
| `last_login_at` | timestamptz null | |

- **No `workspace_id` / `account_id`** — staff are global to the platform.
- One role per user in v1 (Decision C). Rank: `owner` > `billing_write` > `support_read`.
- First `owner` is created only via bootstrap (FR-015). `disabled` users cannot sign in.

### `ee_staff_sessions`

Operator session, minted by the console's own issuer — distinct from customer `sessions`.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `staff_id` | uuid | FK → `ee_staff_users.id`; indexed |
| `session_token_hash` | text | sha256 of the token; `UNIQUE` (plaintext never stored) |
| `created_at` | timestamptz | default `now()` |
| `expires_at` | timestamptz | TTL from `STAFF_SESSION_TTL_HOURS` (fallback to a sane default) |
| `last_seen_at` | timestamptz | default `now()` |
| `revoked_at` | timestamptz null | null = active |

- Carried by a **separate cookie** (`STAFF_SESSION_COOKIE_NAME`), never the customer `SESSION_COOKIE_NAME`.
- `authenticateStaffSession` looks up by `session_token_hash`, rejects expired/revoked.

## Existing tables (reused)

### `ee_usage_limit_profiles` *(unchanged)* — usage tier

`key`, `display_name`, `monthly_answer_limit`, `stored_document_limit`,
`stored_indexed_byte_limit`, `monthly_indexed_byte_limit`, timestamps. Created
and mutated via the existing `EnterpriseUsageLimitService` (`listProfiles`,
`upsertProfile`). Byte limits stored as bytes only (FR-010).

### `ee_usage_limit_account_assignments` *(unchanged)* — org → tier

`account_id` → `profile_key` (one tier per org). Mutated via `assignProfile`
(null clears). The unit of "change tier per org" (US2).

### `accounts` *(read-only; add to EE Kysely subset)* — organization

`id`, `name`, `email` (contact-only, **not** authoritative owner), timestamps.
The org the console lists and assigns tiers to.

### `account_memberships` *(read-only; add to EE Kysely subset)* — ownership

`account_id`, `user_id`, `role` (`owner` is authoritative ownership), `status`.
Joined to `users` for the directory's owner email. An account may have multiple
`owner` memberships; the directory shows the **primary** = earliest active
`owner` (FR-004).

### `users` *(read-only; add to EE Kysely subset)* — owner email source

`id`, `email`. Source of org owner email via membership join. Distinct from
`ee_staff_users` (operators are not customer users).

### `audit_events` *(reused via OSS `auditService` — already on the EE port)*

`account_id` (the target org when applicable), `workspace_id` null, `event_type`
(`staff.*`), `event_status`, `metadata_json` (sanitized; staff actor +
before/after), `created_at`. One audit store for staff mutations; no EE audit
table. `auditService.record(...)` is injected via the existing EE
`RouteDependencies` (`radiosoModuleTypes.ts:187`).

## Derived / computed (not stored)

- **Organization owner**: derived per directory row from
  `account_memberships(role='owner', status active)` → `users.email`, ordered by
  membership `created_at`. "no owner" when none.
- **Headline usage** (directory list): monthly answers used/limit only — cheap
  (SC-007). Full 4-resource breakdown (`AccountUsageSummary`) loaded per-org on
  detail via existing `getAccountUsage`.
- **Byte-limit display**: stored bytes → normalized human unit at render
  (FR-010); no display-unit metadata stored.

## Entity relationships

```text
ee_staff_users 1──* ee_staff_sessions          (operator login)

accounts (org) 1──* account_memberships *──1 users   (owner email, derived)
accounts (org) 1──0..1 ee_usage_limit_account_assignments ──1 ee_usage_limit_profiles (tier)
accounts (org) ──> AccountUsageSummary (computed by EnterpriseUsageLimitService)

staff mutation ──> audit_events (event_type "staff.*", actor in metadata)
```

## Migration notes

- New migrator id e.g. `ee-staff-console`; `CREATE TABLE IF NOT EXISTS` for both
  `ee_staff_*` tables + indexes (`ee_staff_sessions(staff_id)`,
  unique on `ee_staff_users(lower(email))`, unique on `ee_staff_sessions(session_token_hash)`).
- Registered via `context.registerDatabaseMigrator(staffConsoleMigrator)` in the
  new module's `applicationModule.ts`. OSS migrations run first; EE migrator only
  touches `ee_staff_*`.
- BIGINT-style columns are not needed here (counts/limits live in existing tier
  tables); all new columns are uuid/text/timestamptz.
