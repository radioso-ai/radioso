# Data Model: Account Multi-User Access

## Account

- **Purpose**: Existing shared container for workspaces and account-scoped data.
- **Primary Key**: `id`
- **Relevant Fields**: `id`, legacy owner bootstrap fields (`email`, `password_hash`), `created_at`, `updated_at`
- **Relationships**:
  - Has many `workspaces`
  - Has many `account_memberships`
  - Has many `account_invitations`

## User

- **Purpose**: Login identity for a human who can belong to one or more accounts.
- **Primary Key**: `id`
- **Fields**:
  - `email` (normalized, unique)
  - `password_hash`
  - `created_at`
  - `updated_at`
- **Validation Rules**:
  - Email must be unique and normalized
  - Password hash must always be present for local-auth users
- **Relationships**:
  - Has many `account_memberships`
  - Has many accepted invitations
  - Has many `sessions`

## Account Membership

- **Purpose**: Grants a user active access to an account and carries future-facing role data.
- **Primary Key**: `id`
- **Fields**:
  - `account_id`
  - `user_id`
  - `role` (`owner` or `member` for now; both behave the same today)
  - `status` (`active` only in this first cut, but explicit for future deactivation)
  - `created_at`
  - `updated_at`
- **Validation Rules**:
  - Unique on (`account_id`, `user_id`)
  - Only active memberships are considered during authorization
- **Relationships**:
  - Belongs to `account`
  - Belongs to `user`
  - Can create many `account_invitations`

## Account Invitation

- **Purpose**: Pending or completed invitation to join an account by email.
- **Primary Key**: `id`
- **Fields**:
  - `account_id`
  - `email`
  - `invited_by_membership_id`
  - `token_hash`
  - `status` (`pending`, `accepted`, `revoked`, `expired`)
  - `expires_at`
  - `accepted_at`
  - `accepted_by_user_id`
  - `created_at`
  - `updated_at`
- **Validation Rules**:
  - Only one pending invitation per (`account_id`, normalized `email`)
  - Token hash is unique
  - Accepted invitation must record `accepted_at` and `accepted_by_user_id`
- **Relationships**:
  - Belongs to `account`
  - Belongs to inviter membership
  - Optionally belongs to accepted user

## Session

- **Purpose**: Authenticated browser session scoped to both a user and their active account context.
- **Primary Key**: `id`
- **Updated Fields**:
  - `user_id`
  - `account_id`
  - `session_token_hash`
  - `expires_at`
  - `last_seen_at`
  - `revoked_at`
- **Validation Rules**:
  - Session token hash remains unique
  - Session is valid only while unrevoked and unexpired
- **Relationships**:
  - Belongs to `user`
  - Belongs to active `account`

## Workspace Access Resolution (future-facing seam)

- **Purpose**: Authorization seam that currently derives access from active account membership plus `workspace.account_id`, while reserving a future extension point for per-workspace rules.
- **Current Behavior**:
  - User must have an active membership on the session/account context
  - Workspace must belong to that account
- **Future Extension Point**:
  - Per-workspace access policies can be layered into the access service without changing auth/session identity again
