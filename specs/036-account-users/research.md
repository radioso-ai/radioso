# Research: Account Multi-User Access

## Decision: Keep `accounts` as the shared container and add a separate `users` identity table

**Rationale**: The existing schema already scopes workspaces and workspace tokens to `accounts`. Adding `users` plus `account_memberships` creates real multi-user support without forcing a risky rename of every existing account-scoped relation.

**Alternatives considered**:
- Rename `accounts` to `users` and introduce a new account container table. Rejected because it would force a far broader migration across every account-scoped table and repository.
- Continue storing login credentials on `accounts` and fake multiple users through invitation-only aliases. Rejected because it would preserve the single-identity design flaw and block future role support.

## Decision: Sessions carry both `userId` and active `accountId`

**Rationale**: A signed-in person may belong to more than one account after invitations. Session state must identify the user while also carrying the currently selected account context for dashboard bootstrap and workspace access.

**Alternatives considered**:
- Keep sessions keyed only by account. Rejected because it cannot distinguish two different users on the same account.
- Keep sessions keyed only by user and infer account from every request. Rejected because the dashboard route and preferred workspace bootstrap already assume an active account context.

## Decision: Introduce a dedicated account-access service rather than embedding membership checks in workspace or auth routes

**Rationale**: The approved spec explicitly requires a future seam for roles and workspace access. A focused service centralizes account membership checks today and becomes the extension point for future per-workspace permissions.

**Alternatives considered**:
- Add membership queries directly to `workspaceService`. Rejected because it would continue to blend account access rules with workspace CRUD.
- Validate access directly inside each route. Rejected because it would duplicate logic and violate the modularity guardrail.

## Decision: Support invitation acceptance through a shareable token-based join flow

**Rationale**: The spec requires invitation acceptance, but there is no existing outbound email delivery infrastructure in scope. Returning a shareable invitation link from the invite flow lets the feature ship now while still centering invitations on an email address.

**Alternatives considered**:
- Require email delivery as part of this feature. Rejected because it introduces unrelated infrastructure scope.
- Allow accepting invitations by email alone with no tokenized join step. Rejected because it would weaken access control and make invitation lifecycle harder to audit.

## Decision: Preserve equal effective permissions while storing future-facing role fields

**Rationale**: The initial release must keep all active users at the same effective access level, but the spec also requires future role support. Membership records will therefore carry role metadata without changing authorization behavior yet.

**Alternatives considered**:
- Omit role metadata entirely until later. Rejected because it would force another identity/access migration.
- Enforce differentiated roles now. Rejected as out of approved scope.
