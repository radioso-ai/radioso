# Feature Specification: Workspace-First Dashboard URLs

**Feature Branch**: `049-workspace-route-keys`  
**Created**: 2026-04-25  
**Status**: Implemented  
**Input**: User description: "Replace account-scoped dashboard URLs with workspace-first URLs, introduce a short public workspace route key so links are readable, keep UUIDs internal, and preserve backward compatibility by redirecting old account URLs to the canonical workspace URL."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Open and share readable workspace links (Priority: P1)

An authenticated admin can copy, bookmark, and revisit a short workspace URL that opens the correct dashboard location without exposing a long internal identifier in the browser address bar.

**Why this priority**: The primary user problem is that current URLs are confusing and overly long. The feature only delivers value if the canonical link is shorter and clearly tied to the workspace the user intended.

**Independent Test**: Open a workspace dashboard, copy the canonical URL, paste it into a fresh browser tab, and verify the same workspace and dashboard location are restored.

**Acceptance Scenarios**:

1. **Given** an authenticated user is viewing a workspace dashboard, **When** they copy the current URL, **Then** the URL uses the workspace-first format and a short public workspace route key instead of an account-scoped path plus internal workspace identifier.
2. **Given** an authenticated user opens a copied canonical workspace URL, **When** the dashboard loads, **Then** the intended workspace becomes active and the target dashboard location is restored.
3. **Given** a user navigates within a supported dashboard section, **When** the URL updates, **Then** the workspace-first route remains canonical and readable throughout navigation.

---

### User Story 2 - Keep old dashboard links working (Priority: P1)

An admin who opens an older account-scoped dashboard link still reaches the intended workspace and destination instead of landing on a broken or stale page.

**Why this priority**: Existing bookmarks, internal docs, and shared links already rely on the current route structure. Breaking them would create churn that outweighs the URL improvement.

**Independent Test**: Open representative legacy account-scoped links for chat, documents, history, settings, and item-detail states, and verify the app redirects to the matching canonical workspace URL.

**Acceptance Scenarios**:

1. **Given** a legacy account-scoped dashboard URL references a workspace the user can access, **When** the user opens it, **Then** the app redirects to the canonical workspace-first URL for the same destination.
2. **Given** a legacy link includes supported deep-link state such as a document, page, filter, tab, or connector selection, **When** the redirect completes, **Then** that destination state is preserved.
3. **Given** a legacy link is malformed, stale, or references a workspace the user can no longer access, **When** the app handles the request, **Then** it falls back to a safe accessible dashboard destination instead of leaving the user in a broken state.

---

### User Story 3 - Resolve the right organization automatically from the workspace link (Priority: P1)

A user who belongs to multiple organizations can open a workspace-first dashboard URL and land in the correct organization context without manually reconstructing the account portion of the route.

**Why this priority**: The current product supports switching organizations as well as switching workspaces. Removing the account segment is only safe if the product can still restore the correct authenticated organization context from the workspace link.

**Independent Test**: Sign in as a user with access to multiple organizations, open a canonical link for a workspace in a non-current organization, and verify the app restores the correct organization and workspace context.

**Acceptance Scenarios**:

1. **Given** a signed-in user belongs to multiple organizations, **When** they open a canonical link for a workspace in another accessible organization, **Then** the app restores the correct organization session context before rendering workspace-scoped content.
2. **Given** a signed-in user opens a canonical link for a workspace in their current organization, **When** the app loads, **Then** no extra account-selection step is required.
3. **Given** a user lacks access to the workspace referenced by a canonical link, **When** they open it, **Then** the app does not reveal private workspace existence and instead falls back safely or requests reauthentication as appropriate.

---

### User Story 4 - Keep workspace identifiers readable without changing internal IDs (Priority: P2)

Operators can rely on short stable public workspace route keys in URLs while the system continues to use internal workspace UUIDs for persistence, relations, and existing API contracts.

**Why this priority**: The request is about URL readability, not a broad change to primary-key strategy. Preserving internal IDs avoids unnecessary churn and lowers migration risk.

**Independent Test**: Create new workspaces, rename workspaces, and verify each workspace has a stable readable public route key that remains valid for canonical links without changing its internal identifier.

**Acceptance Scenarios**:

1. **Given** a workspace exists, **When** the system builds a canonical dashboard URL, **Then** it uses the workspace's public route key rather than its internal UUID.
2. **Given** a workspace is renamed, **When** existing canonical links are revisited, **Then** the public route key remains valid or the app redirects to the updated canonical link without losing access.
3. **Given** a new workspace is created, **When** it becomes available in the dashboard, **Then** it immediately has a unique public route key suitable for canonical links.

### Edge Cases

- A user opens a canonical workspace URL before workspace bootstrap has completed.
- Two workspaces would naturally derive the same readable route key.
- A workspace is renamed after links using its existing public route key have already been shared.
- A user opens a workspace-first URL while signed out and then authenticates.
- A user opens a workspace-first URL that points to a workspace in an organization they no longer belong to.
- A legacy account-scoped URL omits workspace state and depends on local browser storage today.
- A supported deep link references an item that has been deleted even though the workspace itself is still accessible.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; runtime conversational copy MUST be generated by the LLM so multilingual behavior remains intact.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Frontend route parsing and canonical URL building own dashboard location decoding and serialization; authentication and account-session services own organization context restoration; workspace services own public route key resolution and access validation; repositories own public route key persistence and lookup.
- **Encapsulation Rule**: `frontend/lib/dashboard-routes.ts` must remain the canonical dashboard URL seam and must not absorb authentication or storage behavior. `frontend/lib/workspace-context.tsx` must remain focused on workspace bootstrap and switching rather than parsing raw URLs. `backend/src/modules/auth/services/authService.ts` must remain responsible for account identity/session orchestration and must not absorb workspace repository concerns.
- **New Seams Required**: Introduce a focused workspace public-route-key capability that can generate, persist, resolve, and validate canonical workspace identifiers independently of dashboard component code.
- **Anti-Goals**: Do not replace internal workspace UUIDs with numeric primary keys. Do not push workspace-to-account resolution into scattered page components. Do not require operators to manually select an organization before a valid canonical workspace link can open. Do not break existing account-scoped bookmarks without redirect behavior.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST define a canonical authenticated dashboard route structure that is workspace-first rather than account-first.
- **FR-002**: System MUST assign every workspace a globally unique readable public route key suitable for use in browser URLs.
- **FR-003**: System MUST keep the existing internal workspace UUID as the durable persistence identifier for workspace relations, storage, and internal service logic.
- **FR-004**: System MUST build canonical dashboard URLs from the workspace public route key plus supported dashboard deep-link state.
- **FR-005**: System MUST continue to support the existing deep-link destinations for chat, documents, history, settings, users, and supported section-specific state under the new canonical route structure.
- **FR-006**: System MUST redirect legacy account-scoped dashboard URLs to the matching canonical workspace-first URL.
- **FR-007**: System MUST preserve supported deep-link state during legacy-to-canonical redirects, including selected workspace, selected document, pagination, history filters, settings tabs, settings anchors, and connector selection.
- **FR-008**: System MUST resolve the correct organization/account context from a canonical workspace link before rendering workspace-scoped content for authenticated users who can access multiple organizations.
- **FR-009**: System MUST fail safely when a canonical workspace link references a workspace the current user cannot access, without exposing private workspace existence beyond existing authorization behavior.
- **FR-010**: System MUST provide a safe fallback destination when a workspace public route key is stale, malformed, or no longer resolvable.
- **FR-011**: System MUST generate a unique public route key for each newly created workspace.
- **FR-012**: System MUST define deterministic behavior for workspace renames so canonical links remain stable or redirect predictably without breaking previously shared links.
- **FR-013**: System MUST expose the canonical workspace URL shape consistently from frontend navigation, redirects, and post-authentication landings such as login, invitation acceptance, and password reset recovery.
- **FR-014**: System MUST provide automated coverage for canonical URL building, legacy redirect behavior, public route key generation and resolution, and multi-organization workspace link restoration.

### UI Tasks

- Show canonical workspace-first URLs during authenticated dashboard navigation.
- Keep legacy links usable by redirecting them silently to the new canonical format.
- Preserve the existing dashboard information architecture and visual design while changing how locations are addressed.
- Restore the correct workspace and organization context before rendering dashboard content for a shared link.

### Key Entities *(include if feature involves data)*

- **Workspace Public Route Key**: A short stable public identifier used in canonical dashboard URLs to locate a workspace without exposing the internal UUID.
- **Canonical Workspace URL**: The user-facing dashboard link format that identifies a workspace first and carries supported deep-link state for revisitable destinations.
- **Legacy Dashboard URL**: The existing account-scoped dashboard link format that must continue to resolve through redirects for backward compatibility.
- **Workspace Access Context**: The authenticated organization and workspace combination required to authorize and render workspace-scoped dashboard content.

## Assumptions

- Workspace public route keys need to be globally unique because canonical URLs must resolve the workspace without requiring an account segment.
- Existing internal and API-facing workspace UUIDs remain in place unless another future feature explicitly changes public API contracts.
- Canonical workspace URLs only apply to authenticated dashboard routes in this feature; anonymous chat, embed links, and API token flows keep their existing addressing unless later approved.
- Redirecting legacy account-scoped URLs is sufficient backward compatibility; dual canonical formats are not required long term.
- Workspace route keys should be readable and shorter than UUIDs, but exact formatting can be chosen during planning as long as uniqueness and stability requirements are met.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In validation, 100% of tested authenticated dashboard entry flows open using the canonical workspace-first URL format rather than the legacy account-scoped format.
- **SC-002**: At least 95% of representative copied dashboard links reopen the intended workspace and supported deep-link destination without manual user correction.
- **SC-003**: At least 95% of representative legacy account-scoped links redirect successfully to the matching canonical workspace-first URL while preserving supported destination state.
- **SC-004**: Multi-organization users can open representative canonical workspace links for non-current organizations and reach the intended accessible workspace in one navigation flow without manual organization selection.
- **SC-005**: Validation demonstrates that readable public route keys, not internal UUIDs, are shown in canonical authenticated dashboard URLs for all supported workspace navigation flows.
