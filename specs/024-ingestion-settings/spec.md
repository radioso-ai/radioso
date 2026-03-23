# Feature Specification: Ingestion Settings Controls

**Feature Branch**: `024-ingestion-settings`  
**Created**: 2026-03-23  
**Status**: Draft  
**Input**: User description: "Let's rework the existing settings as you suggested. Create a new tab in Settings for Ingestion, move the chunking strategy setting there, and add the others."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Tune Ingestion In One Place (Priority: P1)

A workspace operator can open a dedicated Ingestion tab in Settings and manage how new or updated documents are prepared for retrieval without mixing those controls into answer-generation or search-tuning settings. Ingestion tab should be placed right after General, before Retrieval

**Why this priority**: The feature only delivers value if operators can clearly find ingestion-specific controls and understand which settings affect document preparation versus retrieval or response behavior.

**Independent Test**: Can be fully tested by opening Settings, switching to the Ingestion tab, confirming that chunking and chunk-size controls are shown there, saving changes, reloading the page, and verifying the saved values are returned for the same workspace.

**Acceptance Scenarios**:

1. **Given** a workspace with default settings, **When** the operator opens Settings, **Then** a dedicated Ingestion tab is available and shows the workspace's current ingestion configuration.
2. **Given** the operator previously saved ingestion settings, **When** the operator returns to the Ingestion tab later, **Then** the same values are shown without requiring access through the Retrieval tab.
3. **Given** the operator is comparing settings categories, **When** the operator opens Retrieval and Ingestion tabs, **Then** ingestion controls appear only in Ingestion and retrieval controls remain in Retrieval.

---

### User Story 2 - Tune Chunking Behavior For Each Strategy (Priority: P2)

A workspace operator can choose a chunking strategy and adjust the most meaningful chunk-shaping controls for that strategy so new ingests better fit the structure and density of the workspace's documents.

**Why this priority**: Exposing chunking strategy alone is too coarse once operators need to tune chunk length and overlap for their content. The next level of value is being able to adjust the main settings that materially change chunk boundaries and retrieval quality.

**Independent Test**: Can be fully tested by saving ingestion settings for both chunking strategies, ingesting representative documents, and verifying that the resulting chunk sets reflect the saved values for chunk size, overlap, and structured chunk-size limits.

**Acceptance Scenarios**:

1. **Given** the operator selects fixed-window chunking, **When** the operator edits and saves fixed-window chunk size and overlap values, **Then** those values are persisted and used the next time a document is ingested or updated.
2. **Given** the operator selects structured-semantic chunking, **When** the operator edits and saves the structured minimum and maximum chunk-size values, **Then** those values are persisted and used the next time a document is ingested or updated.
3. **Given** the operator switches between chunking strategies in the Ingestion tab, **When** the operator views the advanced controls, **Then** the tab clearly distinguishes which controls apply to fixed-window chunking and which apply to structured-semantic chunking.
4. **Given** the operator enters a value outside an allowed range or creates an invalid size relationship, **When** the operator saves, **Then** the system rejects the invalid ingestion settings and preserves the last valid configuration.

---

### User Story 3 - Understand And Apply Setting Changes Safely (Priority: P3)

A workspace operator can understand when ingestion-setting changes take effect and can deliberately reprocess existing documents when the workspace should be brought into line with the new ingestion rules.

**Why this priority**: Ingestion changes can materially alter retrieval behavior. Operators need explicit, safe control over when those changes affect existing data instead of relying on hidden background behavior.

**Independent Test**: Can be fully tested by ingesting documents, changing ingestion settings, verifying existing stored chunks remain unchanged, triggering reprocessing, and confirming that documents are re-queued and later reflect the new ingestion configuration.

**Acceptance Scenarios**:

1. **Given** a workspace already contains processed documents, **When** the operator changes ingestion settings, **Then** the interface explains that existing documents keep their current chunks until they are reprocessed.
2. **Given** the operator wants existing documents to use the new ingestion settings, **When** the operator starts a workspace-level reprocess action, **Then** the system queues existing documents for reprocessing instead of silently rewriting them at save time.
3. **Given** a workspace has no existing documents, **When** the operator saves ingestion settings, **Then** the settings still save successfully and no reprocess action is required.

### Edge Cases

- What happens when an operator selects fixed-window chunking and sets overlap equal to or greater than the chunk size?
- What happens when an operator sets the structured minimum chunk size above the structured maximum chunk size?
- How does the Ingestion tab behave when a workspace has never saved ingestion settings and only defaults exist?
- What happens when a workspace has documents in queued, processing, failed, and ready states when the operator starts a reprocess-all action?
- How does the system handle a saved ingestion-setting value that is no longer supported by the running application?
- What happens when the operator changes ingestion settings but does not start reprocessing for existing documents?
- How does the system prevent duplicate or conflicting reprocess actions when a workspace-level reprocess has already been started?

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

- **Boundary Rule**: Settings routes remain transport-only, settings services own workspace-scoped configuration, document ingestion and processing remain orchestration-only, chunking domain modules own chunk-boundary rules, and repositories remain the only owners of persisted settings, documents, jobs, and chunks.
- **Encapsulation Rule**: The Settings UI must remain responsible for presenting, validating, and explaining ingestion controls, but must not embed chunking logic. Document processing must keep applying a selected ingestion profile rather than reading ad hoc request-time values from the UI. Retrieval settings and ingestion settings must remain conceptually distinct even if they temporarily share persistence or transport seams during migration.
- **New Seams Required**: Introduce a focused ingestion-settings domain shape and validation boundary, a UI panel dedicated to ingestion controls, and an orchestration path for workspace-level document reprocessing that can be triggered without expanding document routes into settings-specific logic.
- **Anti-Goals**: Do not leave chunking controls inside the Retrieval tab. Do not couple ingestion tuning changes to answer-generation instructions. Do not silently rewrite stored chunks when settings are saved. Do not expose low-level operational worker timers, retry delays, or provider internals as user-facing ingestion settings.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a dedicated Ingestion tab within the Settings experience for controls that affect document preparation.
- **FR-002**: System MUST remove chunking strategy selection from the Retrieval tab and present it only within the Ingestion tab.
- **FR-003**: System MUST let operators choose the active chunking strategy for a workspace from the Ingestion tab.
- **FR-004**: System MUST let operators configure fixed-window chunk size for a workspace.
- **FR-005**: System MUST let operators configure fixed-window chunk overlap for a workspace.
- **FR-006**: System MUST let operators configure the minimum chunk-size target used by structured-semantic chunking for a workspace.
- **FR-007**: System MUST let operators configure the maximum chunk-size target used by structured-semantic chunking for a workspace.
- **FR-008**: System MUST persist ingestion settings per workspace so one workspace's ingestion choices do not affect another workspace.
- **FR-009**: System MUST provide default ingestion values for workspaces that have never saved ingestion settings.
- **FR-010**: System MUST validate ingestion-setting inputs and reject unsupported strategies, out-of-range values, and invalid size relationships with clear validation errors.
- **FR-011**: System MUST apply the currently saved ingestion settings whenever a document is newly ingested or an existing document is updated.
- **FR-012**: System MUST continue using the active chunking strategy abstraction so all supported strategies are invoked through the same ingestion boundary.
- **FR-013**: System MUST preserve existing stored chunks when ingestion settings are changed and MUST NOT silently reprocess documents at save time.
- **FR-014**: System MUST explain in the Ingestion tab that setting changes affect future ingests and document updates immediately, while existing documents keep their current chunks until reprocessed.
- **FR-015**: System MUST let operators start a workspace-level reprocess action for existing documents from the Ingestion tab.
- **FR-016**: System MUST queue existing documents for reprocessing when the operator starts the workspace-level reprocess action.
- **FR-017**: System MUST prevent duplicate or conflicting workspace-level reprocess starts from creating ambiguous reprocessing behavior for the same workspace.
- **FR-018**: System MUST preserve compatibility for workspaces that only have the currently supported chunking strategy saved and no advanced ingestion values yet.
- **FR-019**: System MUST expose only ingestion settings that have direct, explainable impact on chunk boundaries and retrieval preparation.
- **FR-020**: System MUST keep answer-generation instructions, retrieval thresholds, worker timing controls, and provider internals out of the Ingestion tab.
- **FR-021**: System MUST keep the Ingestion tab understandable for operators by grouping common controls separately from advanced controls.
- **FR-022**: System MUST make clear which advanced controls apply to fixed-window chunking and which apply to structured-semantic chunking.
- **FR-023**: System MUST preserve existing retrieval settings behavior after chunking controls are moved out of the Retrieval tab.
- **FR-024**: System MUST keep ingestion settings and reprocessing behavior testable through isolated backend validation coverage, settings contract coverage, and end-to-end workspace settings flows.

### UI Tasks

- The Settings screen must add an Ingestion tab alongside the existing settings categories.
- The Ingestion tab must show the active chunking strategy and plain-language descriptions of each strategy option.
- The Ingestion tab must show fixed-window controls for chunk size and overlap.
- The Ingestion tab must show structured-semantic controls for minimum and maximum chunk size.
- The Ingestion tab must separate common controls from advanced controls so operators can scan the page quickly.
- The Ingestion tab must explain when changed settings affect new documents and when existing documents need reprocessing.
- The Ingestion tab must provide a clear action for reprocessing existing documents with the current ingestion settings.
- The Retrieval tab must no longer display chunking controls after this feature ships.

### Key Entities *(include if feature involves data)*

- **Ingestion Settings**: The workspace-scoped configuration that determines which chunking strategy and chunk-size controls are used when documents are prepared for retrieval.
- **Fixed-Window Tuning**: The subset of ingestion settings that define chunk size and overlap for fixed-window chunking.
- **Structured Chunking Tuning**: The subset of ingestion settings that define minimum and maximum chunk-size targets for structured-semantic chunking.
- **Workspace Reprocess Request**: The operator-initiated action that tells the system to re-queue existing documents so their chunks can be rebuilt using the current ingestion settings.
- **Document Processing Queue Entry**: The queued processing state for a document that will be re-run under the workspace's current ingestion configuration.

## Assumptions

- Ingestion settings remain workspace-scoped like the existing retrieval settings.
- Fixed-window chunking and structured-semantic chunking remain the only supported chunking strategies in this feature.
- The initial set of operator-tunable ingestion controls is limited to chunking strategy, fixed-window chunk size, fixed-window overlap, structured minimum chunk size, and structured maximum chunk size.
- Existing workspaces without saved advanced ingestion controls receive safe defaults derived from the current production chunking behavior.
- Reprocessing existing documents is an explicit operator action and is not automatically triggered when ingestion settings are saved.
- The system may disable or guard the reprocess action while a conflicting workspace-wide reprocess is already in progress.
- This feature reworks the settings experience and ingestion configuration model only; it does not add model-driven document-parsing instructions.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In settings contract and UI flow tests, 100% of supported ingestion settings round-trip correctly for a workspace and 100% of invalid combinations are rejected with validation errors.
- **SC-002**: In usability review of the Settings experience, operators can locate chunking controls in the Ingestion tab without entering the Retrieval tab.
- **SC-003**: In ingest regression tests, 100% of newly ingested or updated documents use the workspace's currently saved ingestion settings.
- **SC-004**: In regression tests covering saved-setting changes, 100% of existing stored chunk sets remain unchanged until the operator starts reprocessing or the document is updated.
- **SC-005**: In workspace reprocess tests, 100% of eligible documents are queued for reprocessing from a single operator action and no duplicate workspace-wide reprocess is started for the same workspace while one is already active.
- **SC-006**: In representative chunking tests, changing fixed-window chunk size, fixed-window overlap, structured minimum chunk size, or structured maximum chunk size produces measurable differences in output chunk boundaries for the affected strategy.
