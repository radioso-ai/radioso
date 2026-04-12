# Contract Notes: Account Multi-User Access

## Session-authenticated account routes

### `GET /api/v1/account/users`

- Returns the active account context, active users, and invitation list for the signed-in user
- Requires session cookie

### `GET /api/v1/account/accounts`

- Returns the current account id plus every other accessible account for the signed-in user
- Output per account: `accountId`, `role`, resolved bootstrap `workspaceId`, `workspaceName`
- Requires session cookie

### `POST /api/v1/account/invitations`

- Creates a pending invitation for the active account
- Input: invited email
- Output: invitation summary plus shareable acceptance URL
- Requires session cookie

### `POST /api/v1/account/switch`

- Switches the current session to another accessible account
- Input: `accountId`, optional `preferredWorkspaceId`
- Behavior:
  - Requires the current user to already have an active membership on the target account
  - Resolves the target workspace within the target account
  - Issues a fresh session cookie bound to the target account
- Output: same bootstrap shape as login/register with active `accountId`, `userId`, and selected workspace
- Requires session cookie

### `DELETE /api/v1/account/users/:membershipId`

- Removes an active account membership
- Behavior:
  - Requires session cookie
  - Restricted to account owners
  - Rejects self-removal
  - Rejects removal of owner memberships
- Output: `204 No Content`

## Public invitation routes

### `GET /api/v1/auth/invitations/:invitationToken`

- Returns invitation context needed to render the join flow
- Does not reveal unrelated account data

### `POST /api/v1/auth/invitations/:invitationToken/accept`

- Accepts a pending invitation
- Input: invited email, password, optional confirmation data handled by frontend validation
- Behavior:
  - If a user with the invited email already exists, authenticate with the supplied password and attach active membership
  - Otherwise create the user and attach active membership
- Output: same bootstrap shape as login/register with active `accountId`, `userId`, and selected workspace
- Sets a session cookie for the joined account context

## Updated auth bootstrap contract

### `POST /api/v1/auth/register`

- Returns `userId`, `accountId`, `workspaceId`, `workspaceName`
- Creates a new account, initial user, initial active membership, default workspace, and session cookie

### `POST /api/v1/auth/login`

- Accepts existing `preferredWorkspaceId`
- Adds optional `preferredAccountId`
- Returns `userId`, `accountId`, `workspaceId`, `workspaceName`

## Authorization expectations

- Workspace list, workspace token reveal, and workspace-scoped session routes must validate active membership on the session account before returning data
- Account-switch routes must validate active membership on the requested target account before issuing the new session
- Membership removal is owner-only and must be enforced on the backend, not just hidden in the UI
- Previously issued session cookies must stop authorizing account-scoped routes once the underlying membership is removed
- Bearer-token routes remain workspace-scoped and do not change their external contract
