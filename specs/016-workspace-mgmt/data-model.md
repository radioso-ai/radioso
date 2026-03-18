# Data Model: Workspace Management (Rename & Delete)

**Feature**: 016-workspace-mgmt | **Date**: 2026-03-18

## Entities

### Workspace (existing — no schema changes)

| Field        | Type         | Constraints                          |
| ------------ | ------------ | ------------------------------------ |
| id           | UUID         | PK, auto-generated                   |
| account_id   | UUID         | FK → accounts(id), NOT NULL          |
| name         | TEXT         | NOT NULL, 1-100 chars after trim     |
| created_at   | TIMESTAMPTZ  | NOT NULL, default NOW()              |
| updated_at   | TIMESTAMPTZ  | NOT NULL, default NOW()              |

**Rename behavior**: `UPDATE workspaces SET name = $1, updated_at = NOW() WHERE id = $2`

**Delete behavior**: `DELETE FROM workspaces WHERE id = $1` — cascades to all child tables via existing FK constraints.

### Cascade Relationships (existing — no changes)

All of the following tables have `workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE`:

| Child Table                | Relationship | Notes                          |
| -------------------------- | ------------ | ------------------------------ |
| documents                  | 1:N          | All workspace documents        |
| chunks                     | 1:N          | Denormalized for performance   |
| conversations              | 1:N          | Chat conversations             |
| messages                   | 1:N          | Denormalized for performance   |
| retrieval_settings         | 1:1          | workspace_id is PK             |
| workspace_tokens           | 1:1          | UNIQUE on workspace_id         |
| document_processing_jobs   | 1:N          | Async processing jobs          |
| audit_events               | 1:N          | Optional workspace_id FK       |

## Validation Rules

| Rule                           | Layer      | Implementation                                    |
| ------------------------------ | ---------- | ------------------------------------------------- |
| Name non-empty after trim      | Service    | `name.trim().length >= 1`                         |
| Name max 100 chars             | Service    | `name.trim().length <= 100`                       |
| Ownership verified             | Service    | `findByIdAndAccountId(workspaceId, accountId)`    |
| Last workspace not deletable   | Service    | `countByAccountId(accountId) > 1`                 |

## Database Migration

**No migration required.** The existing schema fully supports rename (UPDATE) and delete (DELETE with CASCADE). No new columns, tables, or constraints needed.
