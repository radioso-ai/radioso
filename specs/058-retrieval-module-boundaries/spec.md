# Feature Specification: Retrieval Module Boundaries

**Feature Branch**: `058-retrieval-module-boundaries`
**Created**: 2026-05-07
**Status**: Draft
**Input**: User description: "Add an incremental PostHog-style retrieval module boundary pilot: create a retrieval public surface, migrate production cross-module imports through that public entrypoint, enforce retrieval internals as private for production code in CI, document the module public-surface pattern, and keep runtime/API behavior unchanged."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Depend On Retrieval Through Approved Root Entry Points (Priority: P1)

As a Radioso maintainer, I want production code outside retrieval to depend on approved retrieval root entry points so retrieval internals can evolve without silent cross-module coupling.

**Why this priority**: This is the core value of the pilot. Without approved public entry points, the project cannot distinguish intentional retrieval contracts from incidental imports of internal services, domain helpers, or infrastructure details.

**Independent Test**: Can be tested by reviewing production cross-module retrieval usage and confirming every non-retrieval production consumer imports retrieval-owned symbols through an approved retrieval root entry point while existing retrieval behavior remains unchanged.

**Acceptance Scenarios**:

1. **Given** a production file outside the retrieval module needs a retrieval request type, result type, diagnostic type, service, helper, or adapter that retrieval intends to expose, **When** the file imports that symbol, **Then** the import goes through an approved retrieval root entry point rather than a retrieval internal path.
2. **Given** a retrieval-internal symbol is not part of an approved entry point, **When** production code outside retrieval attempts to import it directly, **Then** the boundary check reports the violation before merge.
3. **Given** retrieval module internals continue to import their own domain, service, and infrastructure files, **When** the boundary check runs, **Then** retrieval-internal imports remain allowed.

---

### User Story 2 - Preserve Runtime Behavior During Import Migration (Priority: P1)

As a product maintainer, I want this boundary pilot to be an import-surface refactor only so chat, documents, settings, audit, database, provider, retrieval, SDK, MCP, and API behavior do not change.

**Why this priority**: A boundary pilot should reduce architectural risk, not introduce product behavior changes. The implementation must prove that explicit module ownership can be added without altering runtime contracts.

**Independent Test**: Can be tested by running backend build, composition coverage, boundary enforcement, and focused retrieval/chat/document tests after import migration.

**Acceptance Scenarios**:

1. **Given** existing retrieval-backed chat, document processing, settings, audit, database, provider, and app-composition flows, **When** imports are migrated to approved retrieval entry points, **Then** the flows compile and behave as before.
2. **Given** public API, SDK, MCP, database schema, frontend routes, and OpenAPI contracts before this feature, **When** the feature ships, **Then** those contracts remain unchanged.
3. **Given** tests that import retrieval internals for focused coverage, **When** this pilot ships, **Then** those tests may continue to import internals unless a later approved spec expands enforcement to tests.

---

### User Story 3 - Catch Boundary Regressions In CI (Priority: P2)

As a reviewer, I want continuous integration to fail on direct production imports from retrieval internals so module boundaries remain durable after the pilot lands.

**Why this priority**: Public surfaces decay unless automation enforces them. CI enforcement turns the boundary from a convention into a reviewable contract.

**Independent Test**: Can be tested by running the boundary lint target and by introducing a representative forbidden direct import in production code to confirm the lint target fails with an actionable error.

**Acceptance Scenarios**:

1. **Given** a production file outside retrieval imports from retrieval domain, service, or infrastructure internals, **When** boundary lint runs, **Then** the check fails and identifies the direct internal import.
2. **Given** a production file outside retrieval imports the same needed symbol through an approved retrieval root entry point, **When** boundary lint runs, **Then** the check passes.
3. **Given** generated output, distribution output, or backend tests import retrieval internals, **When** boundary lint runs, **Then** those paths are excluded from the first enforcement pass.
4. **Given** backend CI runs for a pull request, **When** backend dependencies are installed, **Then** the retrieval boundary check runs as part of CI before the pull request can merge.

---

### User Story 4 - Document The Public-Surface Pattern (Priority: P3)

As a future contributor, I want documentation that explains module public surfaces so later module boundary work can repeat the same pattern for documents, chat, settings, and other product areas.

**Why this priority**: The pilot is intended to become a reusable architecture pattern. Documentation gives reviewers and future implementers a stable reference for when to promote internals and how to keep cross-module usage intentional.

**Independent Test**: Can be tested by reviewing the architecture documentation and confirming it describes the public-surface rule, the retrieval pilot, production-versus-test enforcement, and future candidate modules.

**Acceptance Scenarios**:

1. **Given** a contributor needs retrieval behavior from outside retrieval, **When** they read the architecture documentation, **Then** they can identify that production imports must use an approved retrieval root entry point.
2. **Given** a contributor wants to expose a new retrieval symbol, **When** they read the documentation, **Then** they understand that promoting the symbol to an entry point is an intentional contract decision.
3. **Given** a maintainer plans the next module-boundary iteration, **When** they read the documentation, **Then** they can identify documents, chat, and settings as likely follow-up candidates rather than widening this pilot.

### Edge Cases

- What happens when a needed retrieval symbol is used outside retrieval but is not exported from an approved entry point yet? The implementation must either promote it intentionally through the right entry point or refactor the consumer so it no longer depends on retrieval internals.
- What happens when two public exports with similar names obscure ownership? Retrieval entry points must keep export names clear enough for maintainers to distinguish request/result contracts, diagnostics, services, helpers, and adapters.
- What happens when a test imports retrieval internals directly? Tests remain excluded in this pilot so focused unit coverage does not become harder before the production boundary is proven.
- What happens when generated or built output contains retrieval-internal paths? Generated and distribution output are excluded from the boundary rule to avoid enforcing against artifacts instead of source.
- What happens when import migration touches app-wide wiring? The plan must evaluate application composition ownership and keep default runtime assembly in the composition layer rather than moving product rules there.
- What happens when the boundary tool cannot resolve a path alias or generated file? The lint rule must fail or exclude paths in a way that keeps production source enforcement meaningful and documented.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; runtime conversational copy MUST be generated by the LLM so multilingual behavior remains intact.
- Backend development MUST follow TDD: tests written and failing before implementation, including a failing boundary-enforcement case before migration makes it pass.
- Frontend user-visible behavior MUST prefer Playwright coverage; this feature is not expected to add frontend UI.
- Secrets and keys MUST be stored in `.env` and never committed; this feature MUST NOT introduce new secrets or required environment variables.
- Customer data MUST be protected with least-privilege access and secure transmission; this feature MUST NOT expand customer-data access.
- Admin-facing pages MUST use the shared dark theme and existing design tokens; this feature is not expected to add admin-facing pages.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.
- Backend HTTP contract changes MUST update the code-first OpenAPI source and regenerated outputs in the same delivery; this feature MUST NOT change HTTP contracts.
- Contract changes MUST include a message-queue impact review; this feature is expected to have no queue payload, retry, or dispatcher contract changes.
- Documentation parity applies because the architecture pattern becomes maintainer-facing product documentation.
- This feature MUST NOT introduce backend runtime LLM prompt assets. If a later change introduces runtime prompts, those assets MUST live under `backend/prompts/`.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: The retrieval module owns grounded search, retrieval answer contracts, retrieval request/result contracts, retrieval diagnostics, retrieval-specific helper contracts, and retrieval infrastructure adapters. Production code outside retrieval may consume only symbols intentionally exposed by approved retrieval root entry points. Application composition owns default app-wide wiring when migrated imports touch replaceable runtime adapters or registries. Chat, documents, audit, settings, database, provider registry, and shared infrastructure modules remain consumers, not owners, of retrieval internals.
- **Encapsulation Rule**: Retrieval domain, service, and infrastructure files must remain internal to retrieval unless a symbol is deliberately promoted through an approved root entry point. Production consumers in app composition, chat, documents, audit, settings, database, and shared LLM infrastructure must not import retrieval internals directly. Tests may keep direct internal imports in this first pass. The dependency-boundary configuration must remain focused on boundary enforcement rather than becoming a catch-all lint system.
- **New Seams Required**: Retrieval root entry points that re-export only the retrieval contracts, services, and adapters intentionally used outside retrieval; a backend boundary lint target that enforces approved entry points for production source; and CI wiring that runs the boundary lint target for backend pull requests.
- **Anti-Goals**: Do not change runtime retrieval behavior, ranking, prompt behavior, chunking behavior, chat behavior, document processing behavior, settings behavior, API contracts, SDK contracts, MCP contracts, database schema, worker payloads, or frontend routes. Do not migrate unit tests in the first enforcement pass. Do not create public surfaces for documents, chat, or settings in this feature. Do not introduce intent-based dev profiles or frontend feature manifests in this feature.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide approved retrieval root entry points that expose only retrieval-owned symbols intentionally used by production code outside retrieval.
- **FR-002**: Approved retrieval entry points MUST include the retrieval request and result contracts, trace and diagnostic contracts, public retrieval services, chunking contracts, search-text helpers, subject helpers, and LLM gateway adapters that existing production consumers legitimately need.
- **FR-003**: Production source files outside retrieval MUST import retrieval-owned symbols through approved retrieval root entry points rather than direct retrieval domain, service, or infrastructure paths.
- **FR-004**: Production source files inside retrieval MUST remain free to import retrieval domain, service, and infrastructure internals directly.
- **FR-005**: Backend tests MUST be excluded from the first boundary enforcement pass so focused tests can continue to exercise retrieval internals.
- **FR-006**: Generated output and distribution output MUST be excluded from the boundary enforcement rule.
- **FR-007**: The system MUST include an automated boundary check that fails when production source outside retrieval directly imports retrieval domain, service, or infrastructure internals.
- **FR-008**: The automated boundary check MUST pass when production source outside retrieval imports retrieval-owned symbols through approved retrieval root entry points.
- **FR-009**: The backend command set MUST include a named boundary lint target that maintainers can run locally.
- **FR-010**: The backend command set MUST include or preserve a general lint target that runs the boundary lint target, without implying broader lint coverage that does not exist yet.
- **FR-011**: Backend CI MUST run the boundary lint target after backend dependencies are available so direct retrieval-internal production imports are blocked before merge.
- **FR-012**: The implementation MUST preserve current runtime behavior for retrieval, assistant-backed chat, document ingestion, settings, audit, provider registry, database integration, SDK usage, MCP usage, and application composition.
- **FR-013**: The implementation MUST NOT change REST API, OpenAPI, database schema, SDK, MCP, worker queue payload, frontend route, or user-facing assistant/chat contracts.
- **FR-014**: The implementation MUST include validation that the boundary check fails on a representative direct production import from retrieval internals.
- **FR-015**: The implementation MUST include validation that backend build and focused composition coverage continue to pass after import migration.
- **FR-016**: The implementation MUST include focused retrieval, chat, and document test coverage when import migration touches those areas.
- **FR-017**: Architecture documentation MUST explain the module public-surface pattern, the production import rule, the retrieval pilot, and the reason tests are excluded from first-pass enforcement.
- **FR-018**: Architecture documentation MUST identify documents, chat, and settings as future candidates for the same pattern without expanding this feature to those modules.
- **FR-019**: The plan MUST include a message-queue impact review confirming whether worker dispatch, AMQP queue payloads, retry semantics, queue tests, or queue docs are affected; the expected answer for this import-surface refactor is no impact.
- **FR-020**: The plan MUST evaluate whether application composition should own any default wiring touched by migrated imports and must keep product rules out of composition wiring.

### Key Entities *(include if feature involves data)*

- **Retrieval Public Surface**: The intentional entrypoint for production code outside retrieval to consume chat-safe retrieval-owned contracts and helpers.
- **Retrieval Root Entry Point**: An approved root-level retrieval file such as `public.ts`, `composition.ts`, or `llmAdapters.ts` that exposes a narrower production import surface for a specific consumer class.
- **Retrieval Internal Module**: Retrieval-owned domain, service, or infrastructure code that may be used freely inside retrieval but is private to external production consumers unless re-exported through the public surface.
- **Production Consumer**: Backend production source outside retrieval, including app composition, chat, documents, audit, settings, database integration, and shared provider infrastructure.
- **Boundary Rule**: Automated validation that distinguishes allowed public-surface imports from forbidden direct internal imports.
- **Boundary Violation**: A direct production import from retrieval internals by source code outside retrieval.
- **Pilot Module**: Retrieval, the first module selected to prove the public-surface pattern before repeating it for other modules.

### Assumptions

- Retrieval is the only module boundary enforced by this feature.
- Existing tests may continue direct imports from retrieval internals during the pilot.
- No user-facing behavior, public contract, database schema, queue payload, SDK surface, MCP surface, runtime prompt asset, or frontend UI change is intended.
- The boundary tool selected by planning should be enforceable both locally and in CI.
- The public surface should be intentionally small, but it may expose existing services or adapters when current app wiring legitimately depends on them.
- Documentation updates must follow the repository's document-writer guidance before editing product docs.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of production imports from outside retrieval to retrieval-owned symbols go through approved retrieval root entry points after migration.
- **SC-002**: A representative forbidden direct production import from retrieval internals fails the boundary lint target with an actionable violation.
- **SC-003**: Backend CI includes the retrieval boundary lint target and blocks pull requests with direct production imports from retrieval internals.
- **SC-004**: Backend build and focused composition validation pass after the import migration.
- **SC-005**: Focused retrieval, chat, and document tests pass when those areas are touched by import migration.
- **SC-006**: Architecture documentation explains the public-surface rule, retrieval pilot scope, test exclusion, and future candidate modules in one concise maintainer-facing section.
- **SC-007**: No REST API, OpenAPI, database schema, SDK, MCP, worker queue, frontend route, or user-facing assistant/chat contract changes are present in the completed diff.
