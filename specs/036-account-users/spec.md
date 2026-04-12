# Feature Specification: Account Multi-User Access

**Feature Branch**: `036-account-users`
**Created**: 2026-04-09
**Status**: Implemented
**Input**: User description: "Add multi-user account access with email invites, equal permissions for now, future role and workspace-access scaffolding, and a Users page under the bottom-left user menu." Follow-up scope: "allow the account owner to remove user access" and "support switching between accounts for users who belong to many accounts."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Invite and Manage Account Users (Priority: P1)

An existing account user opens the new Users page from the bottom-left user menu, sees who already has access, and invites another teammate by email. The invite appears immediately in the pending list so the inviter can confirm it is active.

**Why this priority**: Without invite creation and visibility, the account cannot add more users and the feature does not deliver core value.

**Independent Test**: Can be fully tested by opening the Users page, creating an invite for a new email address, and verifying the invited email appears in the pending invitations list.

**Acceptance Scenarios**:

1. **Given** a signed-in account user opens the Users page, **When** the page loads, **Then** they see all active account users and all pending invitations for that account.
2. **Given** a signed-in account user enters an email address and sends an invite, **When** the invite is accepted by the system, **Then** a pending invitation for that email is created and shown in the Users page.
3. **Given** a pending invitation already exists for an email address on the account, **When** another user attempts to invite the same email again, **Then** the system prevents a duplicate pending invitation and explains the existing state.

---

### User Story 2 - Join an Existing Account Through an Invitation (Priority: P1)

An invited teammate uses their invitation to join the account with their own login identity. Once they complete the join flow, they can open the same product areas and the same workspaces as the original user.

**Why this priority**: Multi-user access is incomplete unless an invited person can actually become an active user of the account.

**Independent Test**: Can be fully tested by creating an invitation, completing the invitation flow as the invited email address, signing in, and verifying the invited user can access the account's workspace list and main dashboard areas.

**Acceptance Scenarios**:

1. **Given** a pending invitation exists for an email address, **When** that person completes the invitation flow with that same email address, **Then** they become an active user on the account.
2. **Given** an invited user completes the join flow, **When** they sign in, **Then** they land in one of the account's existing workspaces without needing a separate account owner handoff.
3. **Given** a person attempts to accept an invitation with a different email address than the invited one, **When** the system validates the invitation, **Then** access is refused and the original invitation remains pending.

---

### User Story 3 - Shared Access Across All Workspaces (Priority: P1)

After joining the account, each active user can switch among the account's workspaces and use them the same way as every other active user. The product behaves as though all accepted users currently share the same permission level.

**Why this priority**: The approved scope keeps permissions uniform for now, so workspace access must be consistent for every active account user.

**Independent Test**: Can be fully tested by signing in as two different active users on the same account and verifying both see the same workspace list and can enter the same workspace-specific screens.

**Acceptance Scenarios**:

1. **Given** two active users belong to the same account, **When** each opens the workspace switcher, **Then** both see the same set of workspaces for that account.
2. **Given** an invited user selects a workspace, **When** they navigate through documents, chat, history, evals, and settings, **Then** the workspace loads successfully without ownership errors.
3. **Given** a new workspace is created on an account, **When** any active user next refreshes or reopens the workspace list, **Then** that workspace is available to every active user on the account.

---

### User Story 4 - Users Page in the Existing Navigation Pattern (Priority: P2)

An account user opens the bottom-left user menu and finds a Users entry alongside existing account actions. Selecting it opens a dedicated page that fits the current admin dashboard style and makes user access management discoverable.

**Why this priority**: The invite capability needs a predictable place in the product, and the request explicitly called for a Users page under the user menu.

**Independent Test**: Can be fully tested by opening the bottom-left user menu, selecting Users, and verifying the dashboard route changes to a dedicated Users view.

**Acceptance Scenarios**:

1. **Given** a signed-in user opens the bottom-left user menu, **When** the menu is rendered, **Then** it includes a Users action.
2. **Given** a user selects the Users action, **When** navigation completes, **Then** the account dashboard shows the Users page in the established dashboard shell and theme.

---

### User Story 5 - Switch Between Accessible Accounts (Priority: P2)

A signed-in user who belongs to more than one account can switch to another accessible account from the existing dashboard chrome without signing out and back in.

**Why this priority**: Multi-account membership is incomplete if users must terminate their session just to move between accounts they already belong to.

**Independent Test**: Can be fully tested by signing in as a user with access to two accounts, opening the user menu, switching accounts, and verifying the dashboard and workspace context now belong to the selected account.

**Acceptance Scenarios**:

1. **Given** a signed-in user has active memberships on multiple accounts, **When** they open the bottom-left user menu, **Then** they see each accessible account as a switch target.
2. **Given** a signed-in user selects another accessible account, **When** the switch completes, **Then** the system issues a session for that account and loads a workspace from the selected account context.
3. **Given** a signed-in user attempts to switch to an account they do not belong to, **When** the backend validates the request, **Then** the switch is rejected and the current session remains unchanged.

---

### User Story 6 - Remove Member Access (Priority: P2)

An account owner can remove a member's access from the Users page when that person should no longer have access to the account.

**Why this priority**: Account sharing needs a revocation path, and removal must be restricted so ordinary members cannot arbitrarily remove other users.

**Independent Test**: Can be fully tested by inviting a member, accepting the invitation, removing that membership as the owner, and verifying the removed user immediately loses access to the account's workspace routes.

**Acceptance Scenarios**:

1. **Given** the current user is an account owner, **When** they open the Users page, **Then** they can remove a member's access from the active users list.
2. **Given** the current user is not an account owner, **When** they open the Users page, **Then** they cannot remove other users.
3. **Given** an owner removes a member's access, **When** the removed member next accesses an account-scoped route with that session, **Then** the request is rejected because the membership is no longer active.
4. **Given** an owner attempts to remove themselves or another owner, **When** the system validates the request, **Then** the removal is rejected so the account cannot be left ownerless.

---

### Edge Cases

- What happens when the invited email already belongs to an active user on the same account? The system prevents creating a redundant invitation and explains that the person already has access.
- What happens when an invitation is accepted after it has been revoked, expired, or otherwise invalidated? The acceptance fails safely and the person does not gain access.
- What happens when a user who belongs to more than one account signs in? The system should preserve a deterministic way to enter the invited account rather than silently redirecting them to an unrelated account context.
- What happens when a signed-in user switches accounts? The system must only allow switching to accounts where the user already has an active membership, and the resulting workspace context must be resolved from that account.
- What happens when a workspace is deleted or renamed while multiple account users are active? The existing shared workspace rules still apply consistently for every active user on the account.
- What happens when the original inviter leaves the session or another active user manages invitations? Invitation management remains tied to account membership, not to a single owner session.
- What happens when a removed member still has a previously issued session cookie? The next session-authenticated account request must fail because active membership is revalidated on each request.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Transport must own request validation and response shaping for account-user and invitation routes. Orchestration must own invitation lifecycle, account membership resolution, and workspace-access resolution. Persistence must own account-user, invitation, and future access-policy storage. Frontend dashboard components must remain presentation-focused and consume typed client APIs and context state.
- **Encapsulation Rule**: `authService.ts` must remain focused on authentication, session issuance, and login orchestration rather than becoming the home for invitation or access-policy rules. `workspaceService.ts` must stop relying on direct workspace ownership-by-account assumptions and instead validate account membership plus workspace access through a dedicated seam. `app-sidebar.tsx` must remain navigation UI only, with no membership business logic embedded in menu components.
- **New Seams Required**: A focused account-membership service, an invitation service, persistence for active memberships and pending invitations, and an authorization seam that can answer both "is this user in this account?" and "can this user access this workspace?" even while all accepted users share the same effective permissions.
- **Anti-Goals**: Do not spread invitation acceptance rules across route handlers. Do not keep using a single account record as both login identity and account membership without an explicit membership model. Do not hard-code future role or workspace rules into UI conditionals that bypass backend authorization. Do not require workspace-specific permission assignment in this feature.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST support multiple active users belonging to the same account.
- **FR-002**: System MUST allow an active account user to invite another person to the same account by email address.
- **FR-003**: System MUST show active account users and pending invitations together on a dedicated Users page.
- **FR-004**: System MUST prevent duplicate pending invitations for the same email address on the same account.
- **FR-005**: System MUST allow an invited person to join the account using their own login identity.
- **FR-006**: System MUST require the accepted invitation to match the invited email address before granting account access.
- **FR-007**: System MUST give every active user on an account the same effective product access in this initial release.
- **FR-008**: System MUST let every active user access every workspace on the account in this initial release.
- **FR-009**: System MUST preserve an authorization model that can later differentiate account-level roles without requiring a second identity migration.
- **FR-010**: System MUST preserve an authorization model that can later differentiate workspace-specific access without requiring a second workspace-membership redesign.
- **FR-011**: System MUST validate account membership before returning workspace lists, workspace tokens, or workspace-scoped data to a signed-in user.
- **FR-012**: System MUST record auditable events for invitation creation, invitation acceptance, and invitation rejection or failure.
- **FR-013**: System MUST allow active account users to view whether an invitation is pending, accepted, revoked, expired, or otherwise no longer usable.
- **FR-014**: System MUST expose the Users page from the bottom-left user menu in the dashboard shell.
- **FR-015**: System MUST preserve existing single-user accounts by treating the current user as the first active member of that account after migration.
- **FR-016**: System MUST keep account workspaces shared across all active members without changing the underlying workspace data boundaries.
- **FR-017**: System MUST allow a signed-in user with more than one active account membership to list and switch to their other accessible accounts without re-entering credentials.
- **FR-018**: System MUST validate active membership on the target account before issuing a switched session or returning switched account bootstrap data.
- **FR-019**: System MUST allow an account owner to remove member access from the account.
- **FR-020**: System MUST prevent non-owners from removing account memberships.
- **FR-021**: System MUST prevent removing the acting owner or any owner membership in this release.
- **FR-022**: System MUST cause previously issued session cookies to stop authorizing account-scoped requests once the underlying membership is removed.

### UI Tasks

- Add a `Users` entry to the bottom-left user menu.
- Add a dedicated Users page within the existing dashboard shell and route system.
- Show an active users list with each person's email and current access state.
- Show a pending invitations list with invitation status and lifecycle feedback.
- Add an invite form that lets an active user enter an email address and send an invitation.
- Add owner-only affordances to remove member access from the active users list.
- Add accessible-account switching actions to the bottom-left user menu for users who belong to multiple accounts.
- Provide clear empty states when an account has one active user and no pending invitations.
- Preserve the existing dark-theme design tokens and navigation patterns so the Users page feels native to the current admin UI.

### Key Entities

- **Account User**: A login identity that belongs to an account. Carries the person's email address, membership state, and future account-level role fields.
- **Account Membership**: The relationship that grants a user access to an account. It is the source of truth for whether a signed-in person belongs to that account and what future account-level role they hold.
- **Account Invitation**: A pending invitation addressed to an email for a specific account. Tracks invitation lifecycle state, inviter, and acceptance outcome.
- **Workspace Access Policy**: The future-facing access record or rule set that will eventually allow per-workspace permissions, while defaulting to full shared access for all active users in this feature.

## Assumptions

- Invitation is initiated by entering an email address from within the product.
- The invited person joins with the same email address that received the invitation.
- All active users on an account can invite other users in this release because permissions are uniform for now.
- Only account owners can remove users in this release.
- The first existing user on each account becomes the initial active member after migration.
- The feature only lays the groundwork for future roles and workspace restrictions; it does not expose controls to assign differentiated permissions yet.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An active account user can create an invitation from the Users page in under 20 seconds.
- **SC-002**: An invited person can join the account and reach the shared dashboard in under 2 minutes.
- **SC-003**: Two different active users on the same account see the same workspace list and can enter the same workspace areas with zero authorization mismatches during acceptance testing.
- **SC-004**: Existing single-user accounts continue working after migration without manual support intervention.
- **SC-005**: The Users page is reachable from the bottom-left user menu in one interaction and clearly shows both active users and pending invitations.
