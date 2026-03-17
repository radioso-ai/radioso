# Data Model: Multi-Workspace Support

**Branch**: `014-multi-workspace` | **Date**: 2026-03-17

## New Entity: Workspace

| Field | Type | Constraints |
|-------|------|-------------|
| id | UUID | PK, default gen_random_uuid() |
| account_id | UUID | FK → accounts(id), NOT NULL |
| name | TEXT | NOT NULL |
| created_at | TIMESTAMPTZ | NOT NULL, default now() |
| updated_at | TIMESTAMPTZ | NOT NULL, default now() |

**Indexes**: `idx_workspaces_account_id` on `account_id`

**Validation**: Name must be non-empty, max 100 characters. At least one workspace must exist per account (enforced at service layer, not DB).

## Renamed Entity: workspace_tokens (was account_tokens)

| Field | Type | Constraints |
|-------|------|-------------|
| id | UUID | PK, default gen_random_uuid() |
| workspace_id | UUID | FK → workspaces(id), UNIQUE |
| account_id | UUID | FK → accounts(id), NOT NULL |
| token_prefix | TEXT | NOT NULL |
| token_hash | TEXT | NOT NULL, UNIQUE |
| encrypted_token | TEXT | NOT NULL |
| created_at | TIMESTAMPTZ | NOT NULL, default now() |
| last_used_at | TIMESTAMPTZ | NULL |

**Indexes**: `idx_workspace_tokens_workspace_id` (unique), `idx_workspace_tokens_token_hash` (unique), `idx_workspace_tokens_account_id`

**Notes**: One token per workspace (enforced by UNIQUE on workspace_id). `account_id` kept for "list all tokens for account" queries. The `findByTokenHash` query now returns `workspace_id` instead of just `account_id`.

## Modified Tables: workspace_id replaces account_id

### documents
- **Remove**: `account_id` column
- **Add**: `workspace_id UUID NOT NULL FK → workspaces(id)`
- **Migration**: Backfill `workspace_id` from default workspace for each account

### chunks
- **Remove**: `account_id` column
- **Add**: `workspace_id UUID NOT NULL FK → workspaces(id)`
- **Migration**: Backfill from document's workspace
- **Note**: `workspace_id` is denormalized here (could derive from document), kept for query performance in vector/lexical search

### conversations
- **Remove**: `account_id` column
- **Add**: `workspace_id UUID NOT NULL FK → workspaces(id)`

### messages
- **Remove**: `account_id` column
- **Add**: `workspace_id UUID NOT NULL FK → workspaces(id)`

### retrieval_settings
- **Remove**: `account_id` PK
- **Add**: `workspace_id UUID PK FK → workspaces(id)`
- **Note**: Remains one-to-one, but keyed by workspace

### document_processing_jobs
- **Remove**: `account_id` column
- **Add**: `workspace_id UUID NOT NULL FK → workspaces(id)`

### audit_events
- **Keep**: `account_id` (nullable, for account-level events like login)
- **Add**: `workspace_id UUID NULL FK → workspaces(id)`
- **Note**: Both columns present. Account-level events (auth) have account_id only. Workspace-level events (document ops, chat) have both.

## Unchanged Tables

### accounts
No changes. Accounts remain the identity/auth entity.

### sessions
No changes. Sessions are account-level (authenticate the person, not the workspace).

## Entity Relationships

```
accounts 1──* workspaces
accounts 1──* sessions (unchanged)

workspaces 1──1 workspace_tokens
workspaces 1──1 retrieval_settings
workspaces 1──* documents
workspaces 1──* chunks (denormalized)
workspaces 1──* conversations
workspaces 1──* messages (denormalized)
workspaces 1──* document_processing_jobs
workspaces 1──* audit_events (optional FK)
```
