# Feature Specification: Enterprise Multi-Organization Creation

**Feature Branch**: `move-multi-org-to-ee`
**Created**: 2026-07-20
**Status**: Approved
**Input**: User description: "In OSS, one user can create the server's first organization during signup. Every later user joins that organization by invitation and cannot create another organization. Organization members can still create new workspaces. Enterprise Edition retains multi-organization creation. There are no current OSS users requiring migration compatibility."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Bootstrap One OSS Organization (Priority: P1)

As the first user of a new OSS server, I can sign up and create the server's organization and default workspace so the installation is usable without manual database setup.

**Why this priority**: OSS must remain self-hostable and operable on first run while enforcing a single-organization boundary after bootstrap.

**Independent Test**: Start with an empty OSS installation, complete signup, and verify that exactly one organization, one owner membership, and one default workspace are created.

**Acceptance Scenarios**:

1. **Given** an OSS server with no organization, **When** the first user completes signup, **Then** one organization, its owner membership, and its default workspace are created.
2. **Given** two first-signup requests arrive concurrently on an empty OSS server, **When** both are processed, **Then** at most one request creates an organization and the other receives the closed-registration response without partial records.
3. **Given** the first signup fails during provisioning, **When** the failure is rolled back, **Then** the OSS server can accept a later first-signup attempt.
4. **Given** the server process stops during core first-signup persistence, **When** PostgreSQL resolves the open transaction, **Then** either the complete organization, user, owner membership, and default workspace exist or none of them exist.

---

### User Story 2 - Join OSS by Invitation (Priority: P2)

As a later OSS user, I join the existing organization through an invitation instead of creating a separate organization.

**Why this priority**: Invitation-only onboarding is the intended ongoing OSS membership model.

**Independent Test**: Bootstrap an OSS organization, invite a second email address, accept the invitation, and verify that the new user joins the existing organization without creating another one.

**Acceptance Scenarios**:

1. **Given** an OSS server that already has an organization, **When** a visitor attempts open signup, **Then** signup is rejected as closed and no user, organization, membership, workspace, or session is created.
2. **Given** an existing OSS organization invitation, **When** the invited person accepts it, **Then** that person receives a user account and membership in the existing organization.
3. **Given** a signed-in OSS member, **When** the member lists or switches accessible organization context, **Then** existing invitation-based access continues to work without offering organization creation.

---

### User Story 3 - Create Multiple Organizations in Enterprise Edition (Priority: P3)

As an Enterprise user, I can create organizations through signup or the signed-in additional-organization flow, subject to the existing Enterprise anti-abuse limit for additional creation.

**Why this priority**: Enterprise must retain the multi-organization capability removed from OSS.

**Independent Test**: In an Enterprise deployment, create organizations through the supported signup and signed-in paths, then verify ownership, default workspace provisioning, session behavior, and existing monthly-limit enforcement.

**Acceptance Scenarios**:

1. **Given** an Enterprise deployment, **When** a new user signs up, **Then** the user can create a new organization even if other organizations already exist.
2. **Given** a signed-in Enterprise user below the configured monthly limit, **When** the user creates an additional organization, **Then** the organization, owner membership, default workspace, and switched session are created successfully.
3. **Given** a signed-in Enterprise user at the configured monthly limit, **When** the user attempts another organization creation, **Then** the existing rate-limit response is returned and no organization is created.
4. **Given** Enterprise organization provisioning fails after reserving capacity, **When** the failed operation is rolled back, **Then** its creation reservation is released.

---

### User Story 4 - Create Workspaces in Either Edition (Priority: P4)

As an organization member with workspace-creation permission, I can create additional workspaces regardless of edition.

**Why this priority**: The edition boundary applies to organizations, not workspaces within the allowed organization.

**Independent Test**: In both OSS and Enterprise deployments, create another workspace as an authorized organization member and verify that workspace creation succeeds without invoking organization-creation policy.

**Acceptance Scenarios**:

1. **Given** an authorized OSS organization member, **When** the member creates a workspace, **Then** the workspace is created in the existing organization.
2. **Given** an authorized Enterprise organization member, **When** the member creates a workspace, **Then** the workspace is created in the selected organization.
3. **Given** a member without workspace-creation permission in either edition, **When** the member attempts workspace creation, **Then** the existing permission denial remains unchanged.

---

### User Story 5 - Present the Correct Edition Experience (Priority: P5)

As a user, I see first-run registration and organization controls that match the server's current edition and initialization state.

**Why this priority**: The interface should guide OSS users toward first-run signup or invitation-based onboarding without advertising actions the server will reject.

**Independent Test**: Compare an empty OSS server, an initialized OSS server, and an Enterprise server, confirming that their registration and organization creation actions match the permitted server behavior.

**Acceptance Scenarios**:

1. **Given** an empty OSS server, **When** a visitor opens authentication, **Then** first-user registration is available.
2. **Given** an initialized OSS server, **When** a visitor opens authentication, **Then** open registration is unavailable and the visitor is directed to use an invitation or sign in.
3. **Given** a signed-in OSS user, **When** the user opens the organization switcher, **Then** the additional-organization action is absent while workspace creation remains available to authorized users.
4. **Given** an Enterprise server, **When** a visitor or signed-in user uses organization creation, **Then** the existing signup and additional-organization controls remain available.

### Edge Cases

- Direct OSS requests to either organization-creating path must be rejected when the server is already initialized, even when the corresponding UI action is hidden.
- The initial OSS organization decision must be concurrency-safe across requests and server processes.
- A failed first OSS signup must not permanently close registration when no organization was successfully created.
- Process or connection loss during core organization provisioning must not leave an account row without its user, owner membership, or default workspace.
- Invitation acceptance must remain available after OSS open registration closes.
- Workspace creation must not consult or consume organization-creation limits.
- Existing Enterprise monthly overrides, including unlimited overrides, must retain their behavior.
- Any failure after an Enterprise additional-creation reservation is acquired, including initial account persistence failure, must release the reservation.
- Denied attempts must produce sanitized audit events without organization names, credentials, session values, or other customer content.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Backend development MUST follow TDD: tests are written and observed failing before implementation.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit tests remain focused on edition and initialization capability logic.
- The server-side organization policy is authoritative; UI hiding is not an authorization control.
- Customer data and session state MUST fail safely, with no partial organization artifacts after rejected or failed creation.
- Existing design tokens and authentication/switcher conventions MUST be reused.
- Public API behavior, setup behavior, and user-visible functionality MUST remain documented.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: The auth service continues to own user and organization provisioning orchestration; a narrow organization-creation policy owns edition and initialization decisions; application composition chooses the OSS or Enterprise policy; HTTP routes present the resulting state and errors; the frontend consumes server initialization state and edition capabilities for presentation.
- **Encapsulation Rule**: HTTP routes do not count organizations or decide entitlement. The Enterprise guard owns monthly counters and overrides but does not own account, membership, workspace, session, or audit orchestration. Workspace services remain unaware of organization limits.
- **New Seams Required**: Extend or refine the existing organization-creation guard so it can authorize both first-signup provisioning and signed-in additional creation without leaking persistence or edition rules into auth routes. Add a narrow organization provisioner/unit-of-work port that commits the account, new user when applicable, owner membership, and default workspace in one PostgreSQL transaction. Expose a read-only registration-availability result for the authentication UI.
- **Anti-Goals**: Do not remove workspaces, organization membership, invitations, or switching from OSS. Do not duplicate provisioning inside EE. Do not infer server initialization or entitlement from client-provided data. Do not introduce a new storage system or queue contract.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: An OSS server with no organization MUST allow one first-user signup to create its initial organization and default workspace.
- **FR-002**: Once an OSS organization exists, open signup MUST reject every attempt before creating a user, organization, membership, workspace, hook side effect, or session.
- **FR-003**: Concurrent first-user signup attempts on an empty OSS server MUST result in at most one successfully created organization.
- **FR-004**: A failed OSS first-user signup MUST release its bootstrap opportunity when no organization was successfully created.
- **FR-005**: The OSS closed-registration response MUST use a stable authorization-style error indicating that subsequent users require an invitation.
- **FR-006**: OSS MUST reject every signed-in attempt to self-create an additional organization before any account, membership, workspace, hook, or session mutation occurs.
- **FR-007**: Invitation creation and acceptance MUST remain available in OSS after open registration closes.
- **FR-008**: Enterprise Edition MUST continue to allow organization-creating signup when other organizations already exist.
- **FR-009**: Enterprise Edition MUST continue to allow signed-in additional organization creation through the existing workflow.
- **FR-010**: Enterprise Edition MUST retain the existing per-user monthly additional-creation limit, configured default, operator override, concurrency protection, and rate-limit response.
- **FR-011**: Organization creation reservations MUST be released for every failure that occurs after reservation and before successful completion.
- **FR-012**: Authorized workspace creation MUST remain available in both editions and MUST NOT consume or consult organization-creation policy.
- **FR-013**: Existing workspace-create permissions and denials MUST remain unchanged.
- **FR-014**: The authentication experience MUST make first-user registration available on an empty OSS server and unavailable after OSS initialization, while preserving invitation acceptance and sign-in.
- **FR-015**: The OSS dashboard MUST NOT display the additional-organization creation action.
- **FR-016**: The Enterprise dashboard MUST continue to display and operate the additional-organization creation action.
- **FR-017**: Denied signup and additional-organization attempts MUST produce sanitized failure audit events suitable for operator troubleshooting.
- **FR-018**: The public API contract and relevant setup, product, and operator documentation MUST describe the edition- and initialization-specific behavior.
- **FR-019**: The change MUST NOT alter document-worker dispatch, AMQP payloads, retry semantics, SDK contracts, MCP contracts, connector contracts, or organization/workspace data ownership.
- **FR-020**: Core organization provisioning MUST atomically commit the account, new user when applicable, owner membership, and default workspace in one PostgreSQL transaction so interruption cannot leave partial bootstrap state.
- **FR-021**: Registration availability failures MUST provide an automatic or user-invoked recovery path without briefly exposing registration before availability is known.

### UI Tasks

- Show first-user registration on an empty OSS server.
- Remove open registration after the OSS server has an organization and guide later users toward an invitation or sign-in.
- Hide the “New organization” action and creation dialog in OSS dashboards.
- Keep signup plus additional-organization controls available in Enterprise dashboards.
- Keep workspace creation and accessible-context switching unchanged in both editions.

## Assumptions

- There are no current OSS users or deployments requiring grandfathering or a data migration.
- No bootstrap-state table or schema migration is required; the existing organization graph is the committed state, and PostgreSQL transaction rollback handles interrupted core provisioning.
- The OSS restriction is deployment-wide: one self-created organization per server, not one per user.
- Later OSS users are provisioned only by accepting an invitation to the existing organization.
- Deleting the sole OSS organization returns the server to an uninitialized state only if no organization remains; recovery of an email address that already exists remains an operator concern.
- The existing Enterprise default of ten signed-in additional organizations per user per UTC month remains the intended anti-abuse policy; normal signup is not charged against that counter.
- No new operator configuration value is required.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Across concurrent first-signup tests on an empty OSS server, exactly one organization is created and no partial organization artifacts remain from rejected requests.
- **SC-002**: In all tested initialized-OSS signup and signed-in organization-creation attempts, zero additional organizations or partial provisioning artifacts are created.
- **SC-003**: In all tested OSS invitation flows, invited users join the existing organization without creating another organization.
- **SC-004**: In both editions, authorized users can create additional workspaces with no change to existing permission behavior.
- **SC-005**: In all tested Enterprise attempts below the configured limit, users can create and enter an additional organization in one completed flow.
- **SC-006**: In all tested Enterprise attempts at the configured limit, creation is rejected without exceeding the limit or leaving partial artifacts.
- **SC-007**: Authentication and dashboard tests show only actions that the active edition and initialization state permit.
- **SC-008**: Focused registration, invitation, organization creation, workspace creation, Enterprise limit, frontend capability, and API contract test suites pass without regression.
