# Feature Specification: Multi-Workspace Support

**Feature Branch**: `014-multi-workspace`
**Created**: 2026-03-17
**Status**: Draft
**Input**: User description: "Expand radioso to support multiple workspaces per account. Currently account = workspace. An account should be able to have multiple workspaces, each with its own data (documents, chunks, conversations, messages, retrieval settings) and its own API token. Token scoping is per-workspace. The frontend should have a workspace switcher below the logo and above the menu in the sidebar."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create and Switch Between Workspaces (Priority: P1)

A user logs into their account and sees their default workspace loaded. They click the workspace switcher (located below the logo, above the sidebar menu) and select "Create new workspace." They name it, and the app navigates to the new, empty workspace. All documents, conversations, and settings start fresh. They can switch back to their original workspace at any time and see their existing data unchanged.

**Why this priority**: This is the foundational capability. Without the ability to create and switch workspaces, no other workspace feature works.

**Independent Test**: Can be fully tested by creating a second workspace, verifying it is empty, switching back and confirming the original workspace data is intact.

**Acceptance Scenarios**:

1. **Given** a user with one existing workspace, **When** they create a new workspace named "Project B", **Then** the app loads an empty workspace with no documents, conversations, or settings.
2. **Given** a user with two workspaces, **When** they switch from "Project B" to their original workspace, **Then** all original documents, conversations, and settings are present.
3. **Given** a user on the workspace switcher, **When** they view the list, **Then** they see all their workspaces with the active one highlighted.

---

### User Story 2 - Per-Workspace API Token (Priority: P1)

A user navigates to the token settings for their active workspace and generates an API token. This token only grants access to the data within that workspace. Using the token via the API, they can only see documents, conversations, and settings belonging to that workspace. A different workspace's token cannot access this workspace's data.

**Why this priority**: API tokens are the primary external integration point. Per-workspace token isolation is critical for data separation and security.

**Independent Test**: Generate tokens for two workspaces, use each token to list documents via API, confirm each only returns its own workspace's documents.

**Acceptance Scenarios**:

1. **Given** a user viewing workspace "Project A" settings, **When** they generate an API token, **Then** the token is scoped to "Project A" only.
2. **Given** a token for "Project A", **When** an API call lists documents, **Then** only "Project A" documents are returned.
3. **Given** a token for "Project A", **When** an API call attempts to access "Project B" data, **Then** the request returns no results.

---

### User Story 3 - Workspace-Scoped Data Isolation (Priority: P1)

A user uploads documents in Workspace A and has conversations in Workspace A. When they switch to Workspace B, none of Workspace A's documents or conversations appear. Search results, retrieval settings, and chat history are all scoped to the active workspace.

**Why this priority**: Data isolation is the core promise of workspaces. Without it, workspaces are cosmetic.

**Independent Test**: Upload a document in Workspace A, switch to Workspace B, verify it does not appear in document list or search results.

**Acceptance Scenarios**:

1. **Given** documents exist in Workspace A, **When** the user switches to Workspace B, **Then** the document list is empty (or shows only Workspace B documents).
2. **Given** a conversation in Workspace A, **When** the user views chat history in Workspace B, **Then** the Workspace A conversation does not appear.
3. **Given** retrieval settings configured in Workspace A, **When** the user views settings in Workspace B, **Then** default settings are shown (not Workspace A's).

---

### User Story 4 - Default Workspace on Account Creation (Priority: P2)

When a new user registers, a default workspace is automatically created for them. They land in that workspace immediately. The experience is seamless — new users do not need to understand the workspace concept to get started.

**Why this priority**: Preserves the existing onboarding flow. New users should not face friction from the multi-workspace feature.

**Independent Test**: Register a new account, verify a default workspace exists and the user is placed in it without extra steps.

**Acceptance Scenarios**:

1. **Given** a new user completing registration, **When** they land on the dashboard, **Then** they are in a default workspace with no extra prompts or setup required.

---

### User Story 5 - Existing Account Migration (Priority: P2)

Existing accounts that were created before the multi-workspace feature have all their data automatically assigned to a default workspace. The user experience is unchanged — they log in and see all their existing data in their default workspace.

**Why this priority**: Existing users must not lose data or face disruption. Backward compatibility is essential.

**Independent Test**: Log in with a pre-existing account after migration, verify all documents, conversations, and settings are present in the default workspace.

**Acceptance Scenarios**:

1. **Given** an existing account with documents and conversations, **When** the migration runs, **Then** all data is assigned to a newly-created default workspace.
2. **Given** a migrated account, **When** the user logs in, **Then** they see their existing data with no changes to their workflow.

---

### Edge Cases

- What happens when a user deletes their last workspace? The system prevents this — at least one workspace must exist per account.
- What happens when a user creates a workspace with a duplicate name? The system allows it (names are labels, not unique identifiers), but displays both clearly.
- What if a user has many workspaces (e.g., 50+)? The switcher remains usable with a scrollable list.

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

- **Boundary Rule**: Transport layer (routes/middleware) handles HTTP concerns and extracts `workspaceId`. Orchestration layer (services) coordinates business logic using `workspaceId`. Domain logic validates workspace ownership. Persistence layer (repositories) queries by `workspace_id`.
- **Encapsulation Rule**: `authService` remains responsible for authentication (account identity). A new `workspaceService` owns workspace CRUD and membership validation. Existing repositories must not absorb workspace ownership checks — that stays in the service/middleware layer.
- **New Seams Required**:
  - `WorkspaceRepository` for workspace CRUD operations
  - `WorkspaceService` for workspace business logic (create, list, validate membership)
  - `requireWorkspace` middleware to resolve and validate workspace context from API tokens
- **Anti-Goals**:
  - Do not add workspace resolution logic into individual route handlers
  - Do not merge workspace ownership checks into existing repositories — keep them in the service/middleware layer
  - Do not change the session/auth model — sessions remain account-level

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST support a `workspaces` entity that belongs to an account, identified by a unique ID and a user-provided name.
- **FR-002**: System MUST create a default workspace automatically when a new account is registered.
- **FR-003**: System MUST migrate all existing account data (documents, chunks, conversations, messages, retrieval settings, processing jobs) to a default workspace during the database migration.
- **FR-004**: System MUST scope documents, chunks, conversations, messages, retrieval settings, and document processing jobs to a workspace (not an account).
- **FR-005**: System MUST issue API tokens per workspace. Each token grants access only to the workspace it was created for.
- **FR-006**: System MUST resolve the workspace from the API token in middleware, so route handlers receive `workspaceId` without additional logic.
- **FR-007**: System MUST allow users to create new workspaces from the frontend.
- **FR-008**: System MUST display a workspace switcher in the sidebar, below the logo and above the menu.
- **FR-009**: System MUST prevent deletion of the last workspace on an account.
- **FR-010**: System MUST ensure vector search and lexical search filter by `workspace_id` instead of `account_id`.
- **FR-011**: System MUST preserve audit events with both `account_id` and `workspace_id` for traceability.

### UI Tasks

- Workspace switcher component in the sidebar (below logo, above menu) showing active workspace name and a dropdown to switch or create.
- Workspace creation flow (name input, confirmation).
- Token management page scoped to the active workspace.
- URL structure updated to include workspace context (e.g., `/account/[accountId]/workspace/[workspaceId]/...`).

### Key Entities

- **Workspace**: Represents an isolated data container within an account. Attributes: unique identifier, name, owning account, creation timestamp. One account has many workspaces. All data entities (documents, conversations, settings, tokens) belong to exactly one workspace.
- **Account Token (updated)**: Now belongs to a workspace instead of directly to an account. The token identifies and authorizes access to a specific workspace.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can create a new workspace and begin using it (upload documents, chat) within 30 seconds.
- **SC-002**: Switching between workspaces loads the target workspace's data with no cross-contamination of documents, conversations, or settings.
- **SC-003**: API tokens issued for one workspace return zero results when queried against another workspace's data.
- **SC-004**: Existing users logging in after migration see all their pre-existing data in a default workspace with no manual action required.
- **SC-005**: New user registration flow remains unchanged — users land in a ready-to-use workspace without additional setup steps.
