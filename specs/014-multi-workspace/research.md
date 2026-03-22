# Research: Multi-Workspace Support

**Branch**: `014-multi-workspace` | **Date**: 2026-03-17

## R1: Token-per-workspace vs token-per-account

**Decision**: Token per workspace. Each workspace gets its own API token. The token implicitly identifies the workspace — no extra header/parameter needed.

**Rationale**: Matches the existing mental model (one token → one data scope). The `requireApiToken` middleware already resolves a token to a scope; we change that scope from `accountId` to `workspaceId`. External integrations (API consumers) bind to a specific workspace naturally.

**Alternatives considered**:
- Token per account + workspace header: More flexible, but requires every API call to pass a workspace ID. Adds complexity to middleware and client code. Rejected.

## R2: Migration strategy for existing data

**Decision**: Single migration that creates `workspaces` table, creates a default workspace per existing account, adds `workspace_id` to all scoped tables, backfills from account ownership, then drops redundant `account_id` columns from workspace-scoped tables.

**Rationale**: The codebase has no production traffic at scale — a single migration is simpler and safer than a multi-step rollout. All existing data moves to a default workspace per account.

**Alternatives considered**:
- Multi-step migration with nullable columns and gradual cutover: Overkill for current scale. Rejected.

## R3: Token table restructuring

**Decision**: Rename `account_tokens` to `workspace_tokens`. Change PK from `account_id` to `(id UUID)`. Add `workspace_id` FK. Keep `account_id` for audit/ownership queries.

**Rationale**: The current table enforces one token per account via PK. Workspaces need independent tokens. Adding a proper `id` PK allows multiple tokens (one per workspace per account). Keeping `account_id` enables "list all tokens for my account" queries.

**Alternatives considered**:
- Adding `workspace_id` to existing table without renaming: Confusing naming. Rejected.

## R4: Frontend workspace context

**Decision**: Add a `WorkspaceProvider` context that holds the active workspace. The workspace switcher sets this context. The auth bootstrap flow fetches available workspaces and selects the last-used one (or default). The API token is stored per workspace in localStorage.

**Rationale**: Clean separation — `AuthProvider` handles account identity, `WorkspaceProvider` handles workspace selection. The API token storage key changes from `radioso.apiToken` to `radioso.apiToken.{workspaceId}` so switching workspaces swaps the active token.

**Alternatives considered**:
- Single provider handling both auth and workspace: Violates single-responsibility and couples auth state to workspace state. Rejected.

## R5: URL structure

**Decision**: Keep the current URL structure (`/account/[accountId]/[section]`). The workspace is selected via the switcher component and stored in context/localStorage — it does not appear in the URL.

**Rationale**: The workspace is an internal organizational concept, not a shareable resource. Adding it to the URL doubles routing complexity (new catch-all segments) for no user benefit. The switcher and context provide adequate navigation. Deep links still work — they land on the active workspace.

**Alternatives considered**:
- `/account/[accountId]/workspace/[workspaceId]/[section]`: Adds URL complexity, breaks existing bookmarks, requires full routing rework. Only valuable if workspaces are shareable/linkable, which they are not in the current spec. Rejected.

## R6: Session-based token fetching for frontend

**Decision**: The `GET /account/token` endpoint changes to `GET /account/workspaces/:workspaceId/token`. The frontend calls this after selecting a workspace to get/create the workspace-specific API token.

**Rationale**: The session authenticates the account. The workspace ID in the path selects which workspace to issue/retrieve a token for. The backend validates that the account owns the workspace before issuing a token.

**Alternatives considered**:
- Query parameter `?workspaceId=...`: Less RESTful. Rejected.
