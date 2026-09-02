# Data Model: Personal API Tokens and Workspace Service Accounts

## Relationship Overview

```text
users ── account_memberships (continuous tenure)
  │                 │
  └── personal api_credentials

workspaces ── workspace_service_accounts ── service api_credentials
     │
     ├── agents ── agent_access_grants (MCP or REST chat audience)
     │
     └── legacy_workspace_credential_tombstones (non-authenticating evidence)
```

`api_credentials` contains secret-verifier lifecycle data. It binds to exactly one stable principal: a user plus membership tenure for `personal`, or a service account for `service`.

## Workspace Service Account

### Purpose

A durable, non-human workspace principal. It owns authorization state and may have several replaceable credentials.

### Fields

| Field | Type | Rules |
|---|---|---|
| `id` | UUID | Primary key |
| `account_id` | UUID | Required; account boundary |
| `workspace_id` | UUID | Required; references workspace; delete cascades |
| `display_name` | text | NFC-normalized, trimmed, 1–80 Unicode characters, no control characters; duplicates allowed |
| `role` | text | `member` or `admin`; never `owner` |
| `status` | text | `enabled`, `disabled`, or `archived` |
| `created_by_user_id` | UUID | Immutable actor attribution; retained as an identifier if the user later leaves |
| `last_used_at` | timestamptz nullable | Best-effort aggregate use time |
| `revision` | integer | Positive optimistic revision for concurrent lifecycle changes |
| `created_at` | timestamptz | Required |
| `updated_at` | timestamptz | Required |
| `disabled_at` | timestamptz nullable | Set only while disabled |
| `archived_at` | timestamptz nullable | Set permanently on archive |

### State transitions

```text
enabled <──────> disabled ──────> archived
   └────────────────────────────> archived
```

- `enabled → disabled`: all credentials suspend on their next request.
- `disabled → enabled`: unexpired, unrevoked credentials become usable again.
- `enabled|disabled → archived`: all credentials become permanently invalid; no transition leaves `archived`.
- Rename and role changes preserve state and increment `revision`.
- Creator membership changes have no effect.
- Workspace deletion cascades to the service account and credentials.

### Indexes

- `(workspace_id, created_at DESC, id DESC)` for inventory.
- `(workspace_id, status)` for quota and warning scans.
- No uniqueness constraint on display name.

## API Credential

### Purpose

A one-time-displayed opaque bearer credential. Common lifecycle fields are shared by personal and service credentials.

### Fields

| Field | Type | Rules |
|---|---|---|
| `id` | UUID | Primary key; safe inventory/audit ID |
| `account_id` | UUID | Required; account boundary |
| `workspace_id` | UUID | Required; references workspace; delete cascades |
| `kind` | text | `personal` or `service` |
| `label` | text | NFC-normalized, trimmed, 1–80 Unicode characters, no control characters; duplicates allowed |
| `token_prefix` | text | Safe identifying prefix only; not authorization input |
| `token_hash` | text | Required, unique SHA-256 verifier; never returned |
| `owner_user_id` | UUID nullable | Required only for `personal`; retained as stable attribution |
| `access_tenure_membership_id` | UUID nullable | Required only for `personal`; exact issuing membership ID |
| `role_ceiling` | text nullable | `member` or `admin` only for `personal` |
| `service_account_id` | UUID nullable | Required only for `service`; references service account; delete cascades |
| `created_by_user_id` | UUID | Immutable issuing actor attribution |
| `expires_at` | timestamptz | Required; personal ≤90 days, service ≤365 days from issuance |
| `last_used_at` | timestamptz nullable | Best-effort, at most one write per five minutes |
| `revoked_at` | timestamptz nullable | Set for explicit revoke, rotation, tenure end, or archive invalidation |
| `revoked_by_user_id` | UUID nullable | Session actor for explicit lifecycle action |
| `revocation_reason` | text nullable | Bounded domain enum, not arbitrary metadata |
| `revision` | integer | Positive optimistic lifecycle revision |
| `rotated_from_credential_id` | UUID nullable | Optional predecessor link |
| `created_at` | timestamptz | Required |
| `updated_at` | timestamptz | Required |

### Binding invariant

The database check accepts exactly one shape:

```text
personal:
  owner_user_id IS NOT NULL
  access_tenure_membership_id IS NOT NULL
  role_ceiling IN (member, admin)
  service_account_id IS NULL

service:
  service_account_id IS NOT NULL
  owner_user_id IS NULL
  access_tenure_membership_id IS NULL
  role_ceiling IS NULL
```

The retained user and membership identifiers intentionally do not cascade away when membership or user records are deleted. Authentication performs a live lookup of the exact membership tenure; a missing row invalidates the credential and allows inventory/audit history to remain attributable.

### Derived state

- `active`: verifier matches, `revoked_at` is null, `expires_at` is in the future, workspace exists, and bound principal is active.
- `expired`: absolute expiry is not in the future.
- `revoked`: `revoked_at` is set, including a rotated predecessor.
- `suspended`: service credential is otherwise active but the service account is disabled.
- `invalid`: personal tenure ended; service account archived/missing; workspace missing; malformed/unknown verifier.

Expired or revoked credentials never reactivate. Re-enabling a service account only affects credentials that are otherwise active.

### Indexes

- Unique `(token_hash)` lookup index, filtered to rows whose `revoked_at` is null when supported by the lookup plan.
- `(workspace_id, kind, created_at DESC, id DESC)` for inventory.
- `(owner_user_id, workspace_id, revoked_at)` for personal quota/inventory.
- `(service_account_id, revoked_at)` for service credential quota/inventory.
- `(expires_at)` is scanned by the bounded daily warning lifecycle; claims are deduplicated separately.
- `(access_tenure_membership_id, revoked_at)` for tenure invalidation.

## API Credential Expiry Warning Claim

### Purpose

Durably deduplicates each 30-, 7-, and 1-day warning without putting notification state on the credential row.

### Fields

| Field | Type | Rules |
|---|---|---|
| `credential_id` | UUID | References API credential; delete cascades |
| `threshold_days` | integer | Exactly `30`, `7`, or `1` |
| `claimed_at` | timestamptz | Claim timestamp |

The composite primary key `(credential_id, threshold_days)` permits one event per threshold. An audit-write failure releases the claim so a later scan can retry.

## Agent Channel Access Grant

### Purpose

A role-free credential bound to one agent and one external chat transport. It is not a user, service account, account membership, or ordinary workspace API principal.

The existing `agent_access_grants` aggregate remains shared with public launch grants, but channel grants use a distinct invariant:

| Field | Channel-credential rule |
|---|---|
| `id` | Stable lifecycle/audit identifier |
| `workspace_id`, `agent_id` | Required immutable binding; agent must belong to workspace |
| `label` | Required normalized display label, never authorization input |
| `principal_kind` | `agent-api` |
| `role` | `agent`; transport vocabulary only, not a workspace role |
| `channel` | `mcp-converse` or `agent-api`; immutable credential audience |
| `token_prefix` | Safe identifying prefix |
| `token_hash` | Unique non-reversible verifier |
| `encrypted_token` | Null for all newly issued channel credentials; retained only where legacy public-launch migration still requires it |
| `origin_mode`, `origin_allowlist` | `allow-all`/empty for server-to-server channel credentials |
| `enabled`, `expires_at`, `last_used_at`, `revoked_at`, `created_at` | Lifecycle metadata; expiry required for new channel credentials |

Audience is stored state. MCP and REST issue independently generated secrets and resolve only the exact expected `channel`; token prefixes do not route authentication. Rotation replaces the verifier in place, clears last use, and changes the grant version so derived MCP sessions fail their next validation. Revocation is permanent.

### Agent chat principal

| Field | Meaning |
|---|---|
| `type` | `agent_chat_credential` or derived `public_chat_session` transport identity |
| `grantId`, `grantVersion` | Exact channel credential and rotation version |
| `workspaceId`, `agentId` | Immutable chat boundary |
| `audience` | `mcp` or `rest` |
| `conversationId` | Existing or newly created conversation binding |

This principal has no `role`, user ID, service-account ID, account membership, or workspace permission set. Only the dedicated agent-chat transport consumes it.

## Legacy Workspace Credential Tombstone

### Purpose

Non-authenticating evidence that the recoverable shared credential was destroyed during the forward-only migration.

### Fields

| Field | Type | Rules |
|---|---|---|
| `legacy_token_id` | UUID | Primary key and idempotence key |
| `account_id` | UUID | Safe historical account identifier; no secret relationship |
| `workspace_id` | UUID | Required, unique under legacy one-token-per-workspace model |
| `token_prefix` | text | Safe prefix copied from legacy row |
| `final_status` | text | Fixed `destroyed` value |
| `system_reason` | text | Fixed bounded migration reason |
| `migrated_at` | timestamptz | Required |

The table has no verifier, ciphertext, authorization value, or foreign key that could make later workspace cleanup erase required migration evidence.

## Authenticated Principal

### Session user

Existing session principal; unchanged.

### Personal API credential principal

| Field | Meaning |
|---|---|
| `type` | `personal_api_credential` |
| `userId` | Stable human principal |
| `credentialId` | Exact bearer credential |
| `accessTenureMembershipId` | Bound continuous tenure |
| `accountId`, `workspaceId` | Tenant boundary |
| `role` | `min(roleCeiling, liveEffectiveRole)` |

### Service-account credential principal

| Field | Meaning |
|---|---|
| `type` | `service_account_credential` |
| `serviceAccountId` | Stable non-human principal |
| `credentialId` | Exact bearer credential |
| `accountId`, `workspaceId` | Tenant boundary |
| `role` | Live service-account role |

Both machine principal variants are rejected for owner authority and for HTTP operations whose route policy is session-only. Both are rejected by MCP and REST agent-chat authentication; those transports consume only their matching agent chat principal.

## Lifecycle Transactions

### Personal issue

1. Lock the issuing membership/workspace capacity boundary.
2. Re-resolve live effective role and requested ceiling.
3. Count active personal credentials; reject at 10.
4. Generate secret and verifier only after capacity is established.
5. Insert credential and safe audit event.
6. Return metadata plus plaintext once.

### Service-account create with first credential

1. Lock the workspace capacity boundary and reject at 50 non-archived accounts.
2. Validate assigned role against session actor.
3. Insert the service account.
4. Generate and insert its first credential after validating the 5-active limit.
5. Persist safe audit events.
6. Return account, credential metadata, and plaintext once.

### Immediate rotation

1. Lock the target active credential and compare the supplied revision.
2. Reject expired, revoked, invalid-principal, or stale-revision requests.
3. Revoke predecessor with bounded reason and increment its revision.
4. Insert one successor with the same principal binding and absolute expiry.
5. Link rotation lineage and audit the result.
6. Return successor plaintext once. Concurrent requests against the old revision return conflict and no secret.

### Service-account archive

1. Lock the active service account and compare current state/revision.
2. Set status and `archived_at` permanently.
3. Revoke every unrevoked child credential with bounded archive reason.
4. Persist one principal event and credential counts, without raw labels or secrets.

### Best-effort use tracking

After successful principal resolution, schedule a conditional credential update only when `last_used_at` is older than five minutes. For service credentials, conditionally update service-account aggregate use in the same best-effort operation. Failures emit a safe operational signal and never change the request's authorization result.

### Agent channel issue and rotation

1. Require an interactive session and centralized agent-management permission.
2. Resolve the path agent inside the actor's workspace.
3. Generate one secret after validation; persist its hash, safe prefix, audience, binding, and expiry without ciphertext.
4. Return plaintext once and write a safe lifecycle audit event.
5. On rotation, require the exact bound grant, replace its verifier atomically, clear last use, and return one replacement secret. Existing derived MCP sessions fail because their grant version no longer matches.

## Retention and deletion

- Workspace deletion cascades active service accounts and credentials because the tenant no longer exists.
- Explicit credential revocation and service-account archive retain safe lifecycle records for audit/inventory.
- Revoked agent channel grants retain only safe lifecycle metadata and a non-usable verifier record; raw channel secrets are never retained.
- Personal user or membership deletion invalidates authentication immediately while retained identifiers preserve attribution.
- Legacy tombstones remain independent of workspace deletion and contain no authenticating material.
