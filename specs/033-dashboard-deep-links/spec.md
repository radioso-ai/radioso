# Feature Specification: Persistent Dashboard Links

**Feature Branch**: `033-dashboard-deep-links`
**Created**: 2026-03-31
**Status**: Draft
**Input**: User description: "In every frontend interaction, I want a persistent link that will lead to the page in a paginated list, a tab in settings with specific anchor etc. Find the places and create a plan"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reopen the exact dashboard location (Priority: P1)

A workspace admin can refresh, bookmark, or share a dashboard URL and return to the same workspace, section, and in-section location instead of losing context and landing on a generic default view.

**Why this priority**: Persistent links only deliver value if they reliably restore the exact place the user meant to return to.

**Independent Test**: Open deep locations across supported dashboard sections, copy the URL, reload the page or open it in a new browser tab, and verify the same workspace and location are restored.

**Acceptance Scenarios**:

1. **Given** an authenticated user is viewing a supported deep-linked dashboard location, **When** they reload the browser, **Then** the same workspace, section, and supported in-section state are restored.
2. **Given** an authenticated user copies a supported deep-linked dashboard URL and opens it later, **When** the dashboard loads, **Then** the destination view reflects the encoded location instead of the section default.
3. **Given** a supported deep-linked URL references a workspace the user can access, **When** the dashboard opens, **Then** that workspace becomes active before the destination state is rendered.

---

### User Story 2 - Navigate long collections and detail drawers with stable links (Priority: P1)

An admin can navigate paginated document and history views, open a specific document or history item, and retain a URL that points back to that exact page and detail state.

**Why this priority**: Paginated collections and detail drawers are the places where context loss is most disruptive and where users most often need a "take me back there" link.

**Independent Test**: Move to a non-default page in Documents and History, open a supported detail state, copy the URL, and verify the same page and detail state reopen after a refresh.

**Acceptance Scenarios**:

1. **Given** the Documents view is on a non-default page, **When** the user refreshes or revisits its URL, **Then** the same page of document results is shown.
2. **Given** the user opens a document from the Documents view, **When** they revisit the URL, **Then** the same document detail view is reopened.
3. **Given** the History view is filtered and paged away from defaults, **When** the user revisits the URL, **Then** the same filter and page are restored.
4. **Given** the user opens a saved conversation or saved search from History, **When** they revisit the URL, **Then** the same history item detail drawer is reopened.

---

### User Story 3 - Link directly to settings tabs and targeted settings sections (Priority: P2)

An admin can open a specific settings tab or section and use a URL that returns directly to that configuration area, including a selected connector when connector settings are in view.

**Why this priority**: Settings work is frequently interrupted or shared across teammates, so direct links to the exact tab or subsection reduce repeated navigation.

**Independent Test**: Open each supported settings tab and at least one targeted settings section or connector detail, copy the URL, and verify the same settings location is restored.

**Acceptance Scenarios**:

1. **Given** the user is on a non-default settings tab, **When** they revisit the URL, **Then** the same tab is selected.
2. **Given** the user opens a supported settings section anchor within a tab, **When** they revisit the URL, **Then** the page lands on that section.
3. **Given** the user selects a connector inside the Chat Connectors tab, **When** they revisit the URL, **Then** the same connector configuration is shown.

---

### User Story 4 - Fail safely when a link is stale or incompatible (Priority: P3)

An admin can open old, partial, or incompatible deep links without getting stuck in a broken state; unsupported or invalid location parts fall back to a safe destination.

**Why this priority**: Persistent links become long-lived artifacts. They need graceful degradation so old links remain usable as the product evolves.

**Independent Test**: Open malformed, stale, or partially valid dashboard URLs and verify the dashboard falls back to safe defaults while preserving any compatible state.

**Acceptance Scenarios**:

1. **Given** a dashboard URL contains an unsupported tab, page, filter, or anchor value, **When** the dashboard loads, **Then** the user is taken to the closest safe supported state instead of a blank or broken view.
2. **Given** a dashboard URL contains valid state for one section and stale state for another, **When** the user navigates within the dashboard, **Then** incompatible state does not leak into the new section.
3. **Given** a dashboard URL references an unavailable item such as a deleted document or removed connector, **When** the dashboard loads, **Then** the surrounding section still opens and the unavailable item state is cleared safely.

### Edge Cases

- A deep link points to a workspace that exists but is no longer the locally active workspace.
- A deep link points to a document, history item, or connector that no longer exists.
- A deep link includes a page number beyond the current number of results after deletions or filtering changes.
- A deep link combines valid section state with unsupported query parameters from another section.
- A deep link references a settings anchor inside a tab that is currently unavailable or renamed.
- A user lands on a supported deep link before workspace bootstrap has finished.
- A user switches sections from a deep-linked state and should not carry incompatible state into the next section.

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

- **Boundary Rule**: Account-level route parsing owns dashboard location decoding; a dedicated frontend route-state layer owns validation, normalization, and serialization of supported deep-link state; section views own rendering and user interactions; existing API clients remain responsible only for fetching data, not for interpreting URL semantics.
- **Encapsulation Rule**: `frontend/lib/dashboard-routes.ts` and the account route entry must remain the canonical dashboard routing seam. Section components such as Documents, History, Settings, and Connectors must consume normalized route state instead of each parsing raw query or hash input independently.
- **New Seams Required**: Introduce one shared dashboard route-state contract that can represent workspace, section, pagination, selected item, tab, connector, and section-anchor state without spreading ad hoc URL logic across multiple components.
- **Anti-Goals**: Do not add backend APIs solely to support deep linking. Do not encode ephemeral UI state that is not useful to revisit or share. Do not preserve incompatible state when moving between dashboard sections. Do not leave pagination and tab links as client-only button state for supported deep-link surfaces.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST define a canonical dashboard URL state model for supported frontend deep-link destinations.
- **FR-002**: The system MUST restore the active workspace from a supported dashboard URL before rendering workspace-scoped content for that location.
- **FR-003**: The system MUST support persistent links for the top-level dashboard sections currently reachable from the main sidebar.
- **FR-004**: The system MUST support persistent links for paginated document-list browsing, including revisiting a non-default page.
- **FR-005**: The system MUST support persistent links for opening a specific document detail view from the Documents section.
- **FR-006**: The system MUST support persistent links for history filter selection and history pagination state.
- **FR-007**: The system MUST support persistent links for opening a specific saved conversation or saved search detail state from History.
- **FR-008**: The system MUST support persistent links for the supported settings tabs.
- **FR-009**: The system MUST support persistent links for targeted settings anchors within supported tabs.
- **FR-010**: The system MUST support persistent links for the selected connector within the Chat Connectors settings tab.
- **FR-011**: Navigation actions inside supported views MUST update the URL so the current location can be revisited without reconstructing it from client memory.
- **FR-012**: Navigation actions between top-level sections MUST drop incompatible deep-link state while preserving compatible state for the destination section.
- **FR-013**: Unsupported, malformed, stale, or unavailable deep-link state MUST fall back to the closest safe supported destination without leaving the dashboard unusable.
- **FR-014**: The system MUST continue to work when users arrive at a supported deep link before workspace bootstrap has completed.
- **FR-015**: The system MUST provide automated frontend coverage for route-state parsing, serialization, normalization, and at least one end-to-end interaction path for Documents, History, and Settings deep links.

### UI Tasks

- Show real revisitable links for supported paginated lists instead of client-only pagination buttons.
- Keep document and history detail views restorable from the URL.
- Make settings tabs directly linkable.
- Provide stable section anchors for supported settings areas.
- Keep connector selection linkable within the Chat Connectors tab.
- Preserve the existing dashboard visual language while introducing URL-backed navigation behavior.

### Key Entities *(include if feature involves data)*

- **Dashboard Location State**: The normalized description of a dashboard destination, including workspace, section, and supported in-section state.
- **Section-Specific Link State**: The subset of dashboard location state that applies to one section, such as a page number, selected history item, selected connector, or settings anchor.
- **Safe Fallback Destination**: The closest supported dashboard state chosen when a deep-link input is missing, invalid, stale, or incompatible.

## Assumptions

- Supported persistent links are limited to dashboard surfaces that represent meaningful places to revisit or share, not every transient UI toggle.
- Workspace identity is part of the persistent-link contract because dashboard content is workspace-scoped and cannot be restored reliably without it.
- Settings anchors are limited to explicitly supported sections with stable identifiers rather than every field or validation message inside a form.
- Live chat composer text, scroll position, and similar transient session state are out of scope for the first implementation unless later approved.
- Existing account-scoped URLs remain the dashboard entry point; the feature extends them with deeper location state rather than replacing the dashboard route structure.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For each supported deep-link surface, revisiting a copied dashboard URL restores the same workspace, section, and supported in-section location during validation.
- **SC-002**: Supported non-default document and history pages reopen on the same page in at least 95% of representative validation attempts.
- **SC-003**: Supported settings tab and anchor links land on the intended configuration area in at least 95% of representative validation attempts.
- **SC-004**: Invalid or stale deep-link inputs fall back to a safe supported destination without producing an unrecoverable dashboard error during validation.
- **SC-005**: The implementation leaves behind automated coverage for the shared route-state contract and the main supported deep-link flows.
