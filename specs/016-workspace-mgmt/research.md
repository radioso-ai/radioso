# Research: Workspace Management (Rename & Delete)

**Feature**: 016-workspace-mgmt | **Date**: 2026-03-18

## Findings

### 1. Existing Delete Infrastructure

- **Decision**: Reuse existing `workspaceRepository.deleteById(workspaceId)` method.
- **Rationale**: The method already exists and performs `DELETE FROM workspaces WHERE id = $1 RETURNING id`. All child tables (documents, chunks, conversations, messages, retrieval_settings, workspace_tokens, document_processing_jobs) have `ON DELETE CASCADE` foreign keys, so a single DELETE statement handles full cleanup.
- **Alternatives considered**: Explicit multi-table deletion in a transaction — rejected because CASCADE already handles this at the database level and is more reliable.

### 2. Rename Approach

- **Decision**: Add `updateName(workspaceId, name)` to the repository, executing `UPDATE workspaces SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *`.
- **Rationale**: Simple column update. The `updated_at` timestamp should be refreshed. Returning the full record lets the service return the updated workspace to the caller.
- **Alternatives considered**: PATCH with generic field updates — rejected as over-engineering for a single-field update.

### 3. Last-Workspace Guard

- **Decision**: Check `countByAccountId(accountId)` before deletion. If count ≤ 1, reject with 400 Bad Request.
- **Rationale**: The existing `countByAccountId` method already exists in the repository. Checking at the service layer before calling delete is the simplest guard.
- **Alternatives considered**: Database constraint (CHECK or trigger) — rejected because this is a business rule, not a data integrity rule, and is clearer in application code.

### 4. Audit Events

- **Decision**: Record `workspace.renamed` and `workspace.deleted` audit events via the existing `auditService.record()`.
- **Rationale**: Constitution requires audit trails for customer data operations. The audit service already supports workspace-scoped events with metadata.
- **Alternatives considered**: None — audit logging is constitutionally required.

### 5. Frontend Confirmation Pattern

- **Decision**: Use a dialog that requires typing the workspace name to confirm deletion (matching GitHub's repository deletion UX pattern).
- **Rationale**: Industry-standard pattern for irreversible destructive actions. Prevents accidental clicks.
- **Alternatives considered**: Simple "Are you sure?" dialog — rejected because it doesn't prevent accidental confirmation for high-stakes operations.

### 6. Active Workspace Handling After Deletion

- **Decision**: After deleting the active workspace, automatically switch to the first remaining workspace in the list.
- **Rationale**: The user must always have an active workspace. The workspace context already has `switchWorkspace()` and handles token activation.
- **Alternatives considered**: Redirect to workspace creation — rejected because FR-008 ensures at least one workspace always exists.

### 7. Dependency Injection for Audit

- **Decision**: Pass `auditService` into `WorkspaceService` constructor alongside the repository.
- **Rationale**: The service needs to record audit events. Current constructor only takes the repository. This follows the same DI pattern used by `AuthService`.
- **Alternatives considered**: Audit at the route layer — rejected because audit is a business concern, not a transport concern.
