# Feature Specification: Workspace Management (Rename & Delete)

**Feature Branch**: `016-workspace-mgmt`
**Created**: 2026-03-18
**Status**: Draft
**Input**: User description: "Add workspace management features: ability to rename a workspace and delete a workspace. When a workspace is deleted, all documents and chats under it must be wiped too. Workspace rename should be accessible in settings on the frontend. Workspace delete should also be in settings but under a special danger zone card."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Rename Workspace (Priority: P1)

A user navigates to the workspace settings page and changes the workspace name to something more descriptive. The new name appears immediately in the workspace switcher and throughout the UI.

**Why this priority**: Renaming is non-destructive and the most commonly needed workspace management action. Users who created workspaces with placeholder names need this to stay organized.

**Independent Test**: Can be fully tested by opening settings, typing a new name, saving, and verifying the workspace switcher reflects the change.

**Acceptance Scenarios**:

1. **Given** a user is on the workspace settings page, **When** they edit the workspace name and save, **Then** the workspace name is updated everywhere in the UI (workspace switcher, settings header) without a page reload.
2. **Given** a user enters a name that is empty or exceeds 100 characters, **When** they attempt to save, **Then** an inline validation error is shown and the save is prevented.
3. **Given** a user edits the workspace name and then cancels, **When** they navigate away, **Then** the original name is preserved.

---

### User Story 2 - Delete Workspace with Cascading Cleanup (Priority: P2)

A user navigates to the workspace settings page, scrolls to the "Danger Zone" card, and deletes the workspace. All documents, chunks, conversations, messages, retrieval settings, processing jobs, audit events, and the workspace token associated with that workspace are permanently removed.

**Why this priority**: Deletion is a critical but destructive action. It's essential for data hygiene and account management, but must be carefully guarded since it is irreversible.

**Independent Test**: Can be fully tested by creating a workspace with documents and chats, deleting it, and verifying the workspace no longer appears and its data is inaccessible.

**Acceptance Scenarios**:

1. **Given** a user is on the workspace settings page, **When** they click "Delete Workspace" in the Danger Zone card, **Then** a confirmation dialog appears requiring them to type the workspace name to confirm.
2. **Given** the confirmation dialog is open, **When** the user types the correct workspace name and confirms, **Then** the workspace and all its data (documents, chunks, conversations, messages, retrieval settings, processing jobs, audit events, workspace token) are permanently deleted.
3. **Given** a workspace is successfully deleted, **When** the user is redirected, **Then** they land on another workspace (or the workspace creation flow if none remain).
4. **Given** a user has only one workspace, **When** they attempt to delete it, **Then** the delete button is disabled with an explanation that at least one workspace must exist.

---

### User Story 3 - Settings Page Layout with Danger Zone (Priority: P3)

A user opens the workspace settings page and sees workspace management options organized into logical sections: general settings (name, retrieval configuration) at the top, and a visually distinct "Danger Zone" card at the bottom for destructive actions like workspace deletion.

**Why this priority**: The UI layout supports the other stories and ensures destructive actions are visually separated to prevent accidental use.

**Independent Test**: Can be verified by opening the settings page and confirming the Danger Zone card is visually distinct (red border/accent) and positioned below all other settings.

**Acceptance Scenarios**:

1. **Given** a user opens workspace settings, **When** the page loads, **Then** the Danger Zone card is visually distinct (red-accented border) and positioned at the bottom of the settings page.
2. **Given** a user views the Danger Zone card, **When** they read the card contents, **Then** there is a clear warning about the irreversible nature of workspace deletion and a "Delete this workspace" button.

---

### Edge Cases

- What happens when a workspace is being deleted while another user/session has it active? The active token becomes invalid and subsequent API calls return an authentication error, prompting re-authentication.
- What happens if the deletion of related data partially fails? The deletion must be atomic — if any part fails, the entire operation rolls back and the user is informed to retry.
- What happens if the user renames a workspace to a name already used by another workspace? Duplicate names within the same account are allowed (workspaces are identified by ID, not name).
- What happens if the user tries to delete a workspace while documents are being processed? Active processing jobs for that workspace are cancelled as part of the cascading delete.

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

- **Boundary Rule**: Transport (`workspaceRoutes.ts`), orchestration (`workspaceService.ts`), persistence (`workspaceRepository.ts`). The settings UI component handles presentation only.
- **Encapsulation Rule**: `workspaceRoutes.ts` must remain transport-only (request validation, response formatting). `settings-view.tsx` must remain UI-only (no direct API calls — use workspace context or api client). `workspaceRepository.ts` must remain persistence-only.
- **New Seams Required**: No new modules needed. Rename and delete operations extend existing workspace service, repository, and routes. The frontend settings view gains new sections.
- **Anti-Goals**: Do not add deletion logic into the route handler — keep it in the service/repository layer. Do not add workspace management state into the settings view component — use the existing workspace context.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow a workspace owner to rename their workspace via the settings page.
- **FR-002**: System MUST validate workspace names: non-empty, trimmed, maximum 100 characters.
- **FR-003**: System MUST persist the updated workspace name and reflect the change immediately in the frontend without requiring a page reload.
- **FR-004**: System MUST allow a workspace owner to delete their workspace from a "Danger Zone" section in settings.
- **FR-005**: System MUST require explicit confirmation before deleting a workspace — the user must type the workspace name to confirm.
- **FR-006**: System MUST cascade-delete all related data when a workspace is deleted: documents, chunks, conversations, messages, retrieval settings, document processing jobs, audit events, and workspace tokens.
- **FR-007**: System MUST perform workspace deletion atomically — either everything is deleted or nothing is.
- **FR-008**: System MUST prevent deletion of the last remaining workspace on an account. At least one workspace must always exist.
- **FR-009**: System MUST redirect the user to another workspace after successful deletion, or to the workspace creation flow if no workspaces remain (guarded by FR-008, but as a safety net).
- **FR-010**: System MUST invalidate the deleted workspace's API token immediately upon deletion so that any in-flight or cached tokens stop working.

### UI Tasks

- Add a "Workspace Name" editable field to the settings page with inline save/cancel controls.
- Add a "Danger Zone" card at the bottom of the settings page with a red-accented border, warning text, and "Delete this workspace" button.
- Add a confirmation dialog for workspace deletion that requires typing the workspace name.
- Disable the delete button with a tooltip when the workspace is the only one on the account.
- Update the workspace switcher to reflect name changes in real time.

### Key Entities

- **Workspace**: The primary entity being managed. Has `id`, `name`, `account_id`, `created_at`, `updated_at`. Owns documents, conversations, retrieval settings, and tokens.
- **Workspace Token**: 1:1 with workspace. Must be invalidated/deleted when workspace is deleted.
- **Documents, Chunks, Conversations, Messages**: Child entities that must be cascade-deleted with the workspace. Already have ON DELETE CASCADE foreign keys in the database.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can rename a workspace in under 10 seconds (open settings, edit name, save).
- **SC-002**: Users can delete a workspace in under 30 seconds (open settings, click delete, confirm by typing name).
- **SC-003**: 100% of related data (documents, chats, tokens) is removed within the same operation when a workspace is deleted — no orphaned records.
- **SC-004**: The Danger Zone card is visually distinguishable from other settings sections so that 0 accidental deletions occur due to UI ambiguity.
- **SC-005**: Users who delete a workspace are seamlessly redirected to an active workspace without errors or blank screens.
