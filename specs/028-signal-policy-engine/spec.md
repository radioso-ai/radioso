# Feature Specification: Generic Retrieval Signal Policies

**Feature Branch**: `028-signal-policy-engine`  
**Created**: 2026-03-25  
**Status**: Draft  
**Input**: User description: "Replace hard-coded retrieval attribute enums and UI with a generic retrieval signal policy model"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Configure Retrieval Signals Without Code Changes (Priority: P1)

As a workspace admin, I can configure retrieval policies in terms of generic signals instead of four fixed attribute types so that new metadata-driven ranking behavior does not require product-specific code paths.

**Why this priority**: This is the core product value. Without a generic policy model, every new retrieval signal remains an engineering project.

**Independent Test**: Can be fully tested by opening retrieval settings, reviewing the available signal policies, changing their behavior, saving, and observing that the system persists and reloads those policies without referencing fixed attribute families.

**Acceptance Scenarios**:

1. **Given** a workspace with retrieval settings, **When** an admin opens the settings screen, **Then** they can view and manage retrieval signal policies without seeing the four legacy hard-coded attribute family controls.
2. **Given** an admin updates one or more signal policies, **When** the settings are saved and later reloaded, **Then** the same policies are restored for that workspace.

---

### User Story 2 - Apply Generic Signal Policies During Retrieval (Priority: P2)

As an end user asking questions against a corpus, I receive results ranked and constrained by generic retrieval signals so that metadata-aware relevance can improve without the retrieval pipeline depending on one-off family-specific branches.

**Why this priority**: Replacing the settings model is not enough unless the retrieval engine actually consumes the new policy representation.

**Independent Test**: Can be fully tested by running retrieval scenarios that use configured signal policies and confirming that ranking or filtering behavior follows the new policy model while preserving baseline retrieval behavior for queries that do not rely on signal matches.

**Acceptance Scenarios**:

1. **Given** configured signal policies and candidates carrying matching signal values, **When** retrieval runs, **Then** the configured policies influence candidate ranking or filtering according to their strategy.
2. **Given** a query and candidate set that do not rely on any configured signal policy, **When** retrieval runs, **Then** the baseline retrieval path still returns useful results without regression from the policy-system refactor.

---

### User Story 3 - Migrate Existing Workspaces Safely (Priority: P3)

As a workspace operator, I can upgrade to the new retrieval policy model without losing access to my existing settings or breaking retrieval settings pages for already-provisioned workspaces.

**Why this priority**: This change touches persisted settings and admin workflows. A migration that strands existing workspaces would block adoption.

**Independent Test**: Can be fully tested by loading or updating settings for a workspace created before the feature, verifying that the workspace remains editable and operational without manual database repair.

**Acceptance Scenarios**:

1. **Given** a workspace that previously stored legacy attribute controls, **When** its retrieval settings are read after the feature ships, **Then** the workspace still receives a valid retrieval settings payload under the new model.
2. **Given** a legacy workspace, **When** an admin saves retrieval settings after the upgrade, **Then** the saved settings use the new signal policy representation and remain usable on subsequent reads.

---

### Edge Cases

- What happens when a workspace has legacy attribute-control data that is incomplete, duplicated, or malformed?
- What happens when a workspace has no configured signal policies yet?
- How does the system behave when a signal policy refers to a supported signal type but a candidate lacks a value for that signal?
- What happens when retrieval queries produce no usable signal constraints and only semantic or lexical ranking remains?
- How does the system handle signal policies that are valid in storage but unsupported by the currently deployed evaluator registry?

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
- Backend API contracts MUST remain code-first and any HTTP contract change must regenerate generated OpenAPI artifacts instead of hand-editing them.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Retrieval settings transport remains owned by settings routes and API presenters; retrieval settings orchestration remains owned by settings services; persistence remains owned by the retrieval settings repository; query interpretation, signal evaluation, and scoring remain owned by focused retrieval-domain services rather than settings or route modules.
- **Encapsulation Rule**: [`backend/src/modules/settings/services/retrievalSettingsService.ts`](/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/modules/settings/services/retrievalSettingsService.ts) must remain orchestration-focused and must not accumulate retrieval-scoring logic; [`backend/src/modules/retrieval/services/attributeMatchScoringService.ts`](/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/modules/retrieval/services/attributeMatchScoringService.ts) must not be expanded with more family-specific branches and should be replaced or refactored toward typed signal evaluators; [`frontend/components/dashboard/settings-view.tsx`](/Users/dm/conductor/workspaces/radioso/buffalo/frontend/components/dashboard/settings-view.tsx) must remain a presentation container rather than owning retrieval-policy semantics.
- **New Seams Required**: Introduce a focused retrieval signal-policy domain model, a reusable evaluator registry keyed by signal type or operator family, and a compatibility layer that can translate or absorb legacy workspace settings during migration.
- **Anti-Goals**: Do not add a general-purpose end-user scripting language for retrieval rules; do not keep the four legacy attribute families as first-class configurable UI concepts; do not move retrieval policy decisions into route handlers, chat services, or large UI container components.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST replace the legacy workspace retrieval setting `attributeControls` model with a generic retrieval signal policy model that does not require the four legacy hard-coded attribute family enums.
- **FR-002**: The system MUST store and return retrieval settings in a form that can represent multiple signal policies, where each policy identifies the target signal, the behavior strategy, and any policy data needed to apply that strategy.
- **FR-003**: The system MUST support loading existing workspaces that were saved under the legacy attribute-control model and present them as valid retrieval settings under the new model without requiring manual database intervention.
- **FR-004**: The system MUST apply retrieval signal policies through a generic evaluation path so that retrieval behavior is driven by policy configuration and typed evaluators rather than family-specific `if` branches for the four legacy enums.
- **FR-005**: The system MUST allow retrieval to continue operating when no signal policy matches a given query or candidate, preserving baseline retrieval behavior rather than failing closed.
- **FR-006**: The system MUST expose only generic retrieval signal policies in the admin settings UI and MUST remove the four fixed attribute-family labels and controls from that UI.
- **FR-007**: The system MUST validate persisted and incoming retrieval policy configurations so unsupported or malformed policies fail safely with clear validation behavior.
- **FR-008**: The system MUST maintain a bounded initial signal-policy surface area by supporting a defined set of generic signal types and evaluator behaviors rather than a user-authored rules language.
- **FR-009**: The system MUST make migration behavior explicit and testable for workspaces that already have retrieval settings persisted before this feature.
- **FR-010**: The system MUST keep retrieval-policy tracing or diagnostics sufficiently clear that future debugging can identify which signal policies were applied, skipped, or ignored during retrieval.

### UI Tasks

- Replace the legacy attribute-family control section in retrieval settings with a generic signal-policy management interface.
- Present generic policy concepts in plain operator language that a workspace admin can understand without referencing internal enum names.
- Preserve the existing settings page layout, dark theme tokens, and save/reload workflow while updating only the retrieval-policy configuration surface.

### Key Entities

- **Retrieval Signal Policy**: A workspace-scoped rule describing how a named retrieval signal should influence candidate ranking or filtering.
- **Retrieval Signal**: A normalized fact available to retrieval, such as a date, range, number, label, or derived metadata concept, that can be evaluated by a generic policy.
- **Signal Evaluator**: A focused retrieval-domain component that knows how to compare a query constraint and candidate signal value for a supported signal type or operator family.
- **Legacy Attribute Control**: The pre-existing retrieval setting representation based on one of four fixed attribute families, retained only as a migration concern.

### Assumptions

- The initial release can define a limited catalog of supported generic signal types and policy strategies as long as those concepts are not exposed as the four legacy attribute families.
- Existing retrieval diagnostics can be extended or adapted rather than replaced wholesale.
- A compatibility layer or migration step is acceptable so long as existing workspaces continue to load and save without manual intervention.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Workspace retrieval settings responses and saves no longer depend on the four legacy attribute family enums in covered backend contract and unit tests.
- **SC-002**: Manual or automated settings verification confirms that the retrieval settings UI no longer displays the four legacy attribute-family controls and instead presents generic signal-policy controls.
- **SC-003**: Covered retrieval-domain tests confirm that configured signal policies influence ranking or filtering through the new generic evaluation path rather than through legacy family-specific branches.
- **SC-004**: Covered migration tests confirm that previously saved workspace retrieval settings can still be read and updated successfully after the feature ships.
