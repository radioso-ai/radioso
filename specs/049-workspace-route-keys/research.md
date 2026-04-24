# Research: Workspace-First Dashboard URLs

## Decision: Keep internal workspace UUIDs and add an immutable public route key

**Rationale**: The user problem is URL readability, not relational storage complexity. An additive public route key keeps foreign keys, workspace tokens, and existing backend logic on UUIDs while providing short readable canonical URLs. Making the key immutable also avoids rename-driven link churn.

**Alternatives considered**:

- Replace workspace primary keys with numeric IDs. Rejected because it broadens schema and repository churn, makes identifiers enumerable, and does not improve internal modularity.
- Reuse workspace UUIDs in the new route shape. Rejected because it keeps links long and does not solve the readability complaint.
- Regenerate route keys whenever workspace names change. Rejected because it would break existing shared links or require redirect-history persistence.

## Decision: Resolve canonical workspace URLs through a dedicated authenticated backend endpoint

**Rationale**: A signed-in user can belong to multiple organizations, and the current frontend route layer does not know how to derive account context from a workspace alone. A focused authenticated resolution endpoint lets the backend enforce access rules and return the correct account/workspace pair without leaking that logic into page components.

**Alternatives considered**:

- Fetch every accessible account and workspace client-side, then match locally. Rejected because the current API does not expose all workspaces across organizations and would spread account-resolution logic into the frontend.
- Encode the account again in the canonical URL. Rejected because it defeats the goal of workspace-first addressing.

## Decision: Use `/w/[workspaceKey]/...` as the canonical authenticated dashboard route

**Rationale**: A short top-level namespace keeps links compact and clearly signals that workspace identity, not account identity, is the primary locator. It also leaves room for legacy `/account/...` routes to continue existing as redirect-only transport seams.

**Alternatives considered**:

- Use `/workspace/[workspaceKey]/...`. Rejected because it is more verbose without adding meaning.
- Reuse `/account/...` and only move workspace identity from query params into path segments. Rejected because it preserves the confusing account-first mental model.

## Decision: Keep legacy account-scoped routes as redirect-only compatibility surfaces

**Rationale**: Existing shared links, docs, and browser history already point at `/account/[accountId]/...`. Redirect-only legacy handling keeps those links working while allowing the canonical route builder to move entirely to workspace-first URLs.

**Alternatives considered**:

- Support both route shapes as equal canonicals. Rejected because it prolongs ambiguity and doubles routing/test burden.
- Drop the old route immediately. Rejected because it would break bookmarks and previously shared links.

## Decision: Generate readable route keys from normalized workspace names plus a short deterministic uniqueness suffix

**Rationale**: Name-derived keys are more readable than random opaque strings. Adding a short suffix guarantees global uniqueness even when many workspaces share names like "Default" without requiring users to understand uniqueness constraints.

**Alternatives considered**:

- Use a fully random short token. Rejected because it is shorter but less readable.
- Require globally unique workspace names. Rejected because the product already allows duplicate workspace names and changing that would expand scope.
