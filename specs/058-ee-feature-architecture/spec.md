# Feature Specification: Enterprise Feature Architecture Boundaries

**Feature Branch**: `study-posthog-ee-structure`
**Created**: 2026-05-07
**Status**: Draft
**Input**: User description: "Incorporate the top five lessons from PostHog's repository structure into Radioso: per-feature Enterprise modules, feature manifests, import boundary enforcement, public backend module contracts, and generated Enterprise frontend route registry."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Understand Enterprise Feature Ownership (Priority: P1)

As a Radioso maintainer, I want each Enterprise capability to have an obvious owning module so I can inspect, test, and evolve one feature without reading a single aggregate Enterprise registration file.

**Why this priority**: The current Enterprise backend module already isolates commercial code from OSS, but the module index is becoming the place where unrelated Enterprise features accumulate. Per-feature ownership is the foundation for every other boundary improvement.

**Independent Test**: Can be tested by inspecting Enterprise backend registration and confirming each existing Enterprise capability contributes through its own named feature module while preserving the same registered routes, migrators, hooks, and lifecycle behavior.

**Acceptance Scenarios**:

1. **Given** the Enterprise backend package is loaded, **When** application modules are registered, **Then** usage limits, Enterprise auth, human contact, website crawler, and website embed integration are contributed by focused Enterprise feature modules rather than one feature-heavy aggregate.
2. **Given** an existing Enterprise route, migrator, lifecycle hook, or policy registration, **When** the refactored Enterprise package is loaded, **Then** the registration behavior remains equivalent to the previous behavior.
3. **Given** a maintainer opens the Enterprise backend module index, **When** they inspect it, **Then** it reads as an aggregation layer rather than a home for feature-specific transport, orchestration, domain, or configuration logic.

---

### User Story 2 - Keep Architecture Boundaries Enforced (Priority: P1)

As a Radioso reviewer, I want automated checks that prevent OSS code from depending on Enterprise implementation details and prevent feature modules from deep-importing each other's internals.

**Why this priority**: Architecture based only on convention decays. Boundary checks make the Enterprise separation and module contract rules durable after this feature lands.

**Independent Test**: Can be tested by running the documented boundary validation target and confirming it fails on representative forbidden imports and passes on approved public contract imports.

**Acceptance Scenarios**:

1. **Given** OSS backend or frontend code imports from Enterprise implementation paths, **When** boundary validation runs, **Then** validation fails with an actionable message.
2. **Given** Enterprise code imports an approved OSS public contract, **When** boundary validation runs, **Then** validation passes.
3. **Given** one backend module deep-imports another module's private service or infrastructure path, **When** boundary validation runs, **Then** validation fails unless the import is explicitly documented as an allowed migration exception.

---

### User Story 3 - Depend On Public Contracts Instead Of Internals (Priority: P2)

As a maintainer adding or reviewing feature work, I want cross-module dependencies to go through public contracts so feature code does not rely on private service internals that are difficult to change safely.

**Why this priority**: Enterprise features already need OSS capabilities such as document ingestion, chat actions, contact history, settings, account access, and application composition. Those dependencies should be explicit contracts, not deep imports.

**Independent Test**: Can be tested by checking representative Enterprise and OSS cross-module dependencies and confirming they import from documented public contract surfaces.

**Acceptance Scenarios**:

1. **Given** an Enterprise feature needs an OSS capability, **When** it imports from OSS, **Then** the import targets an approved public contract or application composition type rather than a private service implementation.
2. **Given** a backend module exposes a capability consumed outside the module, **When** a maintainer inspects the module, **Then** the public contract surface is discoverable and documented.
3. **Given** a public contract changes, **When** tests run, **Then** affected Enterprise and OSS consumers fail clearly rather than silently depending on private implementation details.

---

### User Story 4 - Declare Feature-Owned Wiring In Manifests (Priority: P2)

As a maintainer, I want feature-owned routes, module IDs, edition gating, documentation ownership, and validation expectations to be declared in lightweight manifests so feature ownership is visible in one place.

**Why this priority**: PostHog's product manifests make product ownership discoverable. Radioso does not need the same scale of product registry yet, but lightweight manifests would reduce scattered knowledge across scripts, route stubs, package exports, documentation, and edition checks.

**Independent Test**: Can be tested by inspecting representative OSS and Enterprise feature manifests and confirming they describe ownership metadata used by validation or generation.

**Acceptance Scenarios**:

1. **Given** an existing Enterprise feature, **When** a maintainer opens its manifest, **Then** they can identify its feature ID, edition, backend module contribution, owned API namespace when applicable, frontend route contribution when applicable, and relevant documentation.
2. **Given** a manifest references documentation or generated route ownership, **When** validation runs, **Then** missing referenced files or inconsistent ownership are reported.
3. **Given** a feature has no frontend route or no API route, **When** its manifest is validated, **Then** the manifest can omit those sections without being treated as incomplete.

---

### User Story 5 - Generate Enterprise Frontend Route Stubs From Ownership Metadata (Priority: P3)

As a maintainer of the Enterprise frontend, I want generated route stubs to come from feature-owned declarations so Enterprise pages can be added or moved without manually editing a separate synchronization script for every route.

**Why this priority**: Radioso already generates local EE route files, but the route list is script-owned rather than feature-owned. Moving to manifest-driven route stubs makes the route mechanism match the intended Enterprise encapsulation model.

**Independent Test**: Can be tested by running the frontend route synchronization command and confirming generated stubs match the feature manifests and the OSS run path removes or omits Enterprise stubs as it does today.

**Acceptance Scenarios**:

1. **Given** an Enterprise frontend feature declares a route contribution, **When** the synchronization command runs, **Then** the corresponding route stub is generated with the expected package export target.
2. **Given** the OSS development run path starts, **When** Enterprise route synchronization is not enabled, **Then** Enterprise route stubs do not remain active in the OSS frontend.
3. **Given** a manifest declares an invalid package export or route path, **When** validation runs, **Then** it fails before a broken Next.js route is generated.

### Edge Cases

- An Enterprise feature module is registered twice under the same identifier.
- A feature manifest is present for a package that is not installed in the current run mode.
- A manifest references a route export that the package does not expose.
- OSS code accidentally imports an Enterprise frontend or backend package.
- Enterprise code needs a temporary OSS internal import while a public contract is being extracted.
- A public contract folder exists but simply re-exports private internals without documenting the supported surface.
- Boundary validation runs in a workspace where Enterprise packages are intentionally absent.
- Existing generated Enterprise route files are present when the OSS run path starts.

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
- This feature MUST NOT introduce backend runtime LLM prompt assets. If a later change introduces runtime prompts, those assets MUST live under `backend/prompts/`.
- Any route-generation, package-install, or local run-flow change MUST update the relevant repo or documentation portal docs in the same delivery.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Enterprise backend feature modules own Enterprise feature registration and lifecycle. OSS application composition owns generic extension registry behavior and default assembly. OSS backend modules own their own public contracts, internal orchestration, domain logic, and persistence. Frontend route stubs are generated from feature-owned metadata rather than hand-maintained route lists.
- **Encapsulation Rule**: `ee/packages/backend-module/src/index.ts` must remain an aggregation surface, not the owner of feature-specific behavior. `backend/src/app/composition/` must remain generic and must not gain feature-specific Enterprise concepts. `frontend/lib/edition-controller.ts`, `frontend/lib/api.ts`, and route synchronization scripts must not become the permanent registry for all Enterprise feature ownership.
- **New Seams Required**: Add focused Enterprise feature module exports, a manifest shape for feature-owned metadata, boundary validation for approved imports, public contract surfaces for representative backend module dependencies, and manifest-driven Enterprise frontend route generation or validation.
- **Anti-Goals**: Do not rebuild Radioso into PostHog's full product-package architecture. Do not introduce separate product databases. Do not change user-facing Enterprise behavior. Do not add a new commercial licensing system. Do not move all existing OSS modules in one broad refactor. Do not require Enterprise packages for the OSS run path. Do not hand-edit generated OpenAPI artifacts or generated route files as source of truth.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Enterprise backend registration MUST be decomposed so each existing Enterprise capability has a focused application module or feature module contribution.
- **FR-002**: The Enterprise backend package MUST preserve the current externally observable behavior for existing Enterprise routes, migrators, account-created hooks, usage policies, chat action providers, contact history providers, website embed integration, lifecycle startup, and lifecycle shutdown.
- **FR-003**: The Enterprise backend package index MUST aggregate feature modules and exported public types without owning feature-specific transport, orchestration, domain, configuration, or provider logic.
- **FR-004**: The system MUST provide automated import boundary validation that prevents OSS backend and frontend code from importing Enterprise implementation paths.
- **FR-005**: The system MUST provide automated import boundary validation for at least one representative class of private cross-module backend imports.
- **FR-006**: Boundary validation MUST allow documented public contract imports and MUST provide an explicit, reviewable place for temporary migration exceptions.
- **FR-007**: Representative backend modules consumed across module or edition boundaries MUST expose discoverable public contract surfaces.
- **FR-008**: Enterprise code that depends on representative OSS capabilities MUST use approved public contracts or generic application composition types rather than private service or infrastructure internals.
- **FR-009**: The system MUST define a lightweight feature manifest shape that can represent feature ID, edition, backend module contribution, API namespace ownership when applicable, frontend route ownership when applicable, documentation ownership, and validation expectations.
- **FR-010**: Existing Enterprise features MUST have representative manifests sufficient to prove the manifest model works without requiring every OSS feature to migrate in the first slice.
- **FR-011**: Manifest validation MUST report missing referenced docs, duplicate feature IDs, duplicate route ownership, and malformed route ownership metadata.
- **FR-012**: Enterprise frontend route stub generation MUST be driven by manifest-owned route metadata or by a manifest-derived registry rather than a hand-maintained list embedded directly in the synchronization script.
- **FR-013**: The OSS run path MUST continue to remove or omit Enterprise frontend route stubs so OSS development and builds do not require Enterprise frontend packages.
- **FR-014**: The Enterprise run path MUST continue to build and install Enterprise backend and frontend packages according to the existing local development and container workflows.
- **FR-015**: Tests MUST prove Enterprise backend module decomposition preserves current registration behavior and lifecycle shutdown behavior.
- **FR-016**: Tests MUST prove boundary validation catches representative forbidden imports and allows representative public contract imports.
- **FR-017**: Tests MUST prove manifest validation catches duplicate IDs or route ownership conflicts.
- **FR-018**: Tests MUST prove Enterprise frontend route synchronization produces the expected route stubs from manifest metadata and rejects invalid metadata.
- **FR-019**: Documentation MUST explain the Enterprise feature module model, manifest ownership model, boundary validation command, public contract expectations, route generation flow, and anti-goals.
- **FR-020**: Message-queue impact review MUST state whether worker dispatch payloads, AMQP queue payloads, retry semantics, queue tests, or queue docs are affected. The expected outcome is no queue contract change because this feature changes architecture boundaries and route generation, not document worker payloads.

### Key Entities *(include if feature involves data)*

- **Enterprise Feature Module**: A focused contribution that registers one Enterprise capability's routes, migrators, hooks, providers, policies, and lifecycle through the generic application module system.
- **Feature Manifest**: A lightweight source-of-truth declaration for feature ownership metadata, including edition, module contribution, API namespace ownership, frontend route ownership, documentation, and validation expectations.
- **Import Boundary Rule**: An automated validation rule that describes allowed and forbidden dependencies between OSS, Enterprise, package, frontend, and backend module surfaces.
- **Public Module Contract**: A discoverable, documented import surface for capabilities intentionally consumed outside the owning module.
- **Enterprise Frontend Route Stub**: A generated Next.js route file that re-exports an Enterprise package page or route handler during Enterprise development or builds.
- **Migration Exception**: A temporary, documented allowance for a dependency that cannot be moved to a public contract within the first slice.

### Assumptions

- The first delivery should migrate representative existing Enterprise features and routes, not every possible future OSS module.
- The import-boundary tool may be an existing linting dependency, a new development dependency, or a local validation script as long as it is automated, documented, and testable.
- Public contracts can start with the backend capabilities already consumed by Enterprise features, then expand as future features need them.
- Feature manifests should be small and practical for Radioso's current scale; they should not require a PostHog-style full product registry.
- No new user-facing screens are expected. If planning discovers a need for a visible module status screen, it must be treated as a separate user-facing scope decision.
- No backend runtime LLM prompts are introduced by this feature.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A maintainer can identify the owning Enterprise feature module for each existing Enterprise backend route in under 2 minutes by inspecting feature module files or manifests.
- **SC-002**: Automated tests confirm the refactored Enterprise backend registration exposes the same route mount paths and lifecycle behavior as before the refactor.
- **SC-003**: Boundary validation fails on at least three representative forbidden import examples and passes on at least two representative approved public contract imports.
- **SC-004**: At least three representative Enterprise features have manifests that validate successfully and identify owned backend or frontend contributions.
- **SC-005**: Enterprise frontend route synchronization is generated from manifest-owned metadata and produces the same active route stubs for currently supported Enterprise frontend pages.
- **SC-006**: The OSS build or development path remains runnable without installing Enterprise frontend packages or Enterprise backend modules.
- **SC-007**: Documentation gives future contributors enough information to add a new Enterprise feature module and route stub without editing unrelated OSS product services.
