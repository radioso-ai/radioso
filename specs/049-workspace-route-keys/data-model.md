# Data Model: Workspace-First Dashboard URLs

## Workspace

- **Purpose**: Existing isolated data container inside an organization/account.
- **Existing Identity**:
  - `id` (internal UUID, remains the persistence identifier)
  - `accountId`
  - `name`
- **New Attribute**:
  - `publicRouteKey`: immutable, globally unique, readable identifier used in canonical dashboard URLs
- **Validation Rules**:
  - Must be non-empty.
  - Must be globally unique across workspaces.
  - Must be generated automatically for new workspaces.
  - Must remain stable across workspace renames.
- **Relationships**:
  - Belongs to one account.
  - Continues to own documents, conversations, settings, tokens, and other workspace-scoped records through `id`, not `publicRouteKey`.

## Workspace Route Resolution

- **Purpose**: Resolve a canonical workspace URL to the correct authenticated access context.
- **Attributes**:
  - `publicRouteKey`
  - `workspaceId`
  - `accountId`
  - `workspaceName`
  - `organizationName`
  - `accessStatus` (`accessible`, `not_found_or_forbidden`, `requires_authentication`)
- **Validation Rules**:
  - Only an authenticated user with access to the target organization can receive an `accessible` result.
  - Unauthorized callers must not learn more than the existing authorization surface allows.
  - Resolution must return enough information to restore the correct account session and active workspace.

## Canonical Dashboard Location

- **Purpose**: Describe the user-facing authenticated dashboard destination under the new workspace-first route format.
- **Attributes**:
  - `workspacePublicRouteKey`
  - `section`
  - optional section-specific state such as `documentId`, `page`, `filter`, `itemId`, `tab`, `anchor`, or `connector`
- **Validation Rules**:
  - Must serialize to one canonical workspace-first route.
  - Must preserve supported deep-link state during redirects from legacy account routes.
  - Must drop incompatible or stale section-specific state the same way the current dashboard route contract does.

## Legacy Dashboard Location

- **Purpose**: Represent previously shared account-scoped dashboard links that still need to resolve safely.
- **Attributes**:
  - `accountId`
  - existing route segments and query state
  - optional `workspaceId`
- **State Transition**:
  - On successful resolution, legacy location redirects to a canonical dashboard location.
  - On stale or inaccessible workspace state, legacy location falls back to a safe accessible canonical destination.
