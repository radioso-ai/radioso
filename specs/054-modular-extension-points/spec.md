# Feature Specification: Modular Extension Points

**Feature Branch**: `054-modular-extension-points`
**Created**: 2026-05-02
**Status**: Draft
**Input**: User description: "Prepare Radioso architecture for modular extension points and deployment-specific composition. Define neutral capability checks, adapter boundaries, optional module registration, default-build verification, and documentation requirements while preserving current default product behavior."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Preserve The Default Product Through Explicit Composition (Priority: P1)

As a Radioso maintainer, I want the default application to be assembled from explicit modules so the current product behavior remains clear, testable, and independent of optional deployment-specific additions.

**Why this priority**: This is the foundation for the feature. If the default product cannot be composed and verified on its own, later modularity work will create uncertainty and accidental coupling.

**Independent Test**: Can be tested by running the default application build and focused startup tests, then confirming all existing user-facing workflows continue to operate with only the default modules registered.

**Acceptance Scenarios**:

1. **Given** a default Radioso deployment, **When** the application starts, **Then** it registers the baseline connectors, observability sinks, incident sinks, retrieval behavior, auth behavior, storage behavior, and worker dispatch behavior needed to preserve current functionality.
2. **Given** no optional modules are configured, **When** a maintainer builds and tests the application, **Then** the build succeeds without requiring any deployment-specific package or environment setting.
3. **Given** an existing chat, document ingestion, retrieval, settings, or workspace workflow, **When** the default application is assembled through the new composition path, **Then** the workflow behaves the same as it did before this feature.

---

### User Story 2 - Register Optional Capabilities Without Core Coupling (Priority: P1)

As a Radioso maintainer, I want optional capabilities to register through stable extension points so additions do not require scattered imports, conditionals, or adapter-specific logic inside route handlers and orchestration services.

**Why this priority**: The main architectural risk is code spread. Optional capabilities need a single, obvious way to plug into the product without making core product modules responsible for deployment decisions.

**Independent Test**: Can be tested by registering a representative optional module in tests and confirming it participates through the intended extension point without requiring changes to unrelated routes, frontend screens, or product services.

**Acceptance Scenarios**:

1. **Given** a new connector, observability sink, incident sink, auth provider, retrieval strategy, storage adapter, or worker dispatcher, **When** it is registered through the appropriate extension point, **Then** the owning registry or composition layer makes it available to the product without changing unrelated product code.
2. **Given** an optional module is absent, **When** the application starts, **Then** the default implementation handles the missing module predictably without runtime failure.
3. **Given** an optional module fails during initialization, **When** startup or runtime registration is attempted, **Then** the failure is reported through existing operational channels and does not corrupt the default module registry.

---

### User Story 3 - Evaluate Capabilities Through A Neutral Policy Layer (Priority: P2)

As a Radioso maintainer, I want sensitive or optional actions to consult a neutral capability policy so product code has one consistent way to decide whether an action is available in the current deployment.

**Why this priority**: A neutral policy layer prevents future feature availability checks from being hard-coded into route handlers, UI components, or orchestration services. The default policy should preserve existing behavior.

**Independent Test**: Can be tested by exercising a default policy that allows existing actions and a stricter test policy that denies one representative action with a predictable response.

**Acceptance Scenarios**:

1. **Given** the default policy, **When** existing document, chat, retrieval, settings, connector, and workspace actions are checked, **Then** they are allowed so current behavior is preserved.
2. **Given** a stricter policy is configured in a test deployment, **When** a checked action is denied, **Then** the user receives a clear non-chat operational response and no partial mutation occurs.
3. **Given** a product workflow needs to check availability, **When** the workflow invokes the policy, **Then** it uses a capability name from a shared catalog rather than embedding ad hoc string decisions throughout the codebase.

---

### User Story 4 - Verify Standalone Default Builds In Continuous Integration (Priority: P2)

As a maintainer, I want automated verification that the default product builds and tests without optional modules so regressions in the modular boundary are caught before merge.

**Why this priority**: Modular boundaries decay unless CI enforces them. The default build must remain independently valid.

**Independent Test**: Can be tested by running the dedicated default-composition validation target and confirming it fails if a default entry point imports an unavailable optional module.

**Acceptance Scenarios**:

1. **Given** a pull request changes composition, registries, or module boundaries, **When** CI runs, **Then** it verifies the default application can build and run focused composition tests without optional modules.
2. **Given** a default entry point accidentally depends on an unavailable optional module, **When** CI runs, **Then** the validation fails with an actionable error.

---

### User Story 5 - Document The Extension Model For Maintainers (Priority: P3)

As a maintainer or contributor, I want documentation that explains the supported extension points and module ownership rules so future work follows the same architecture.

**Why this priority**: Documentation makes the boundary durable after the initial implementation and reduces future review ambiguity.

**Independent Test**: Can be tested by reviewing the documentation and confirming it identifies the supported extension points, default behavior, registration flow, ownership boundaries, and anti-goals.

**Acceptance Scenarios**:

1. **Given** a contributor wants to add a new adapter or module, **When** they read the documentation, **Then** they can identify the correct extension point and the files or layers that must remain responsibility-limited.
2. **Given** a reviewer evaluates a future contribution, **When** they compare the change against the documentation, **Then** they can tell whether the contribution follows the supported composition model.

### Edge Cases

- What happens when an optional module is registered twice with the same identifier?
- What happens when an optional module is configured but missing a required dependency or configuration value?
- What happens when a capability check is denied after part of a user workflow has already started?
- What happens when the default composition is run with no optional modules and no deployment-specific environment variables?
- How does the system report module initialization failures without exposing secrets or sensitive customer data?
- How does a future module add user-facing settings without bypassing existing settings validation and documentation expectations?

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; runtime conversational copy MUST be generated by the LLM so multilingual behavior remains intact.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit tests MUST stay focused on non-visual logic rather than markup or design assertions.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated for any new configuration.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.
- Any public contract, operator setting, run flow, or extension contract changed by this feature MUST update the corresponding documentation in the same delivery.
- This feature MUST NOT introduce backend runtime prompt assets. If a later change introduces runtime prompts, those assets MUST live under `backend/prompts/`.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Application composition owns module registration and deployment-specific assembly. HTTP routes own request handling and response shaping. Chat, retrieval, document ingestion, settings, account, workspace, and connector services own product workflow orchestration. Domain modules own business rules and capability definitions. Persistence modules own storage access. Observability, analytics, and incident modules own their own sink contracts and fan-out behavior.
- **Encapsulation Rule**: Route handlers, frontend components, chat orchestration, retrieval orchestration, document worker orchestration, settings services, and account/workspace services MUST NOT become permanent homes for optional-module imports, deployment-specific conditionals, sink-specific payload logic, or adapter-specific initialization. Existing sink contracts and connector plugin contracts SHOULD be reused or strengthened rather than replaced with parallel mechanisms.
- **New Seams Required**: The plan MUST define explicit seams for application module registration, neutral capability checks, connector registration, observability and incident sink registration, retrieval strategy registration, storage adapter selection, worker dispatch selection, and default composition verification. Where a seam already exists, the plan MUST identify whether it is sufficient or requires a focused refactor.
- **Anti-Goals**: Do not change product scope or user-facing positioning. Do not remove existing default behavior. Do not scatter deployment-specific checks through routes or UI components. Do not make optional module availability part of the critical path for unrelated workflows. Do not introduce user-facing assistant or chat copy to explain capability availability. Do not make external services mandatory for the default local or self-hosted run path.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST define a default application composition that preserves existing baseline behavior for backend HTTP serving, background document processing, frontend usage, SDK/API access, MCP access, connector management, chat, retrieval, settings, account, and workspace workflows.
- **FR-002**: The system MUST expose a single, documented registration path for optional application modules so additions are assembled at startup rather than imported ad hoc throughout product code.
- **FR-003**: The system MUST define a neutral capability policy interface with a default implementation that allows all currently available actions.
- **FR-004**: The system MUST route representative guarded actions through the capability policy before performing mutations or privileged operations.
- **FR-005**: The system MUST define a shared catalog or equivalent canonical source for capability names used by product code and tests.
- **FR-006**: The system MUST keep connector plugins registered through the existing connector abstraction or an explicitly improved successor that remains focused on connector behavior.
- **FR-007**: The system MUST keep observability, analytics, and incident delivery behind sink contracts, with default behavior that works when no deployment-specific sink is configured.
- **FR-008**: The system MUST keep retrieval behavior behind identifiable strategy or stage boundaries so future retrieval additions do not require changing route handlers or chat transport code.
- **FR-009**: The system MUST keep storage and worker-dispatch choices behind focused adapters where deployment differences exist or are expected.
- **FR-010**: The system MUST provide focused tests proving the default composition works without optional modules.
- **FR-011**: The system MUST provide focused tests proving an optional module can be registered through at least one representative extension point without changing unrelated product services.
- **FR-012**: The system MUST provide focused tests proving the default capability policy preserves existing behavior and a stricter policy can deny a representative action without partial mutation.
- **FR-013**: The system MUST add or update CI validation so the default composition build is checked without relying on optional modules or deployment-specific packages.
- **FR-014**: The system MUST report duplicate module identifiers, failed module initialization, and invalid capability names with actionable errors that do not expose secrets or customer data.
- **FR-015**: The system MUST update maintainer or operator documentation to explain the extension model, default composition, supported extension points, module ownership, and anti-goals.
- **FR-016**: The system MUST avoid introducing new required environment variables for the default composition unless they are already required by the existing product. Any new optional configuration MUST be documented and added to the relevant example environment file.
- **FR-017**: The system MUST preserve generated API contract behavior unless a required capability-denial response changes a public HTTP contract; any such contract change MUST update the code-first OpenAPI registry and generated outputs.
- **FR-018**: The system MUST preserve multilingual chat behavior by keeping operational capability-denial responses outside assistant-generated conversational copy unless the existing product flow already delegates that conversation to the model.

### Key Entities *(include if feature involves data)*

- **Application Module**: A cohesive optional or default contribution registered during application assembly. It may contribute connectors, sinks, policies, strategies, adapters, routes, or lifecycle hooks through supported extension points.
- **Extension Point**: A named composition boundary that accepts default or optional contributions while keeping product workflow modules independent from deployment-specific decisions.
- **Capability Policy**: A neutral service that answers whether a workspace, account, or request context may perform a named action.
- **Capability Name**: A canonical identifier for a guarded action, stored in a shared catalog so checks are consistent and testable.
- **Default Composition**: The baseline set of modules and adapters required for the current local or self-hosted product to work without optional additions.
- **Optional Adapter**: A deployable contribution that implements an existing extension contract and can be omitted without breaking the default composition.

### Assumptions

- Existing user-facing behavior should remain unchanged unless a later approved plan identifies a necessary compatibility fix.
- The first implementation may strengthen existing seams instead of replacing them when current contracts are already sufficient.
- This feature is allowed to introduce tests and documentation before adding broad new module types.
- Optional module support should be verifiable with local or test-only modules; no real external service integration is required for this feature.
- New frontend UI is not expected unless planning discovers that existing settings or admin screens need minor visibility for module status.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A maintainer can run the default build and focused composition tests without installing or configuring any optional module.
- **SC-002**: At least five extension categories are documented with their owner, registration path, default behavior, and anti-goals.
- **SC-003**: At least one representative optional module registration test proves an optional contribution can be added through an extension point without changing unrelated product services.
- **SC-004**: At least one representative capability-denial test proves a guarded action can be denied without partial mutation and without hard-coded assistant/chat copy.
- **SC-005**: CI includes a validation path that fails if the default composition depends on unavailable optional modules.
- **SC-006**: A reviewer can map every new module, registry, policy, or adapter introduced by this feature to a named architecture boundary in this spec.
- **SC-007**: Existing core chat, retrieval, document ingestion, settings, account, workspace, API, SDK, and MCP smoke or focused regression tests continue to pass after the composition changes.
