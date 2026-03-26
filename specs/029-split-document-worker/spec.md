# Feature Specification: Split Document Worker Runtime

**Feature Branch**: `029-split-document-worker`  
**Created**: 2026-03-26  
**Status**: Draft  
**Input**: User description: "Split the document processing worker into a separate runtime while preserving the existing DB-backed job model and updating local orchestration"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Keep Chat Serving Independent From Ingestion (Priority: P1)

An operator can run the Radioso API without also running document processing in the same process, so chat and API traffic stay available even when background document work is stopped, restarted, or overloaded.

**Why this priority**: The primary value of this feature is failure isolation. If the API and worker still share one runtime boundary, the feature does not solve the underlying operational risk.

**Independent Test**: Can be fully tested by starting only the API runtime, confirming API routes remain available, then stopping and restarting the worker runtime separately without requiring the API process to restart.

**Acceptance Scenarios**:

1. **Given** the API runtime is started and the worker runtime is not running, **When** an operator calls a healthy authenticated API route, **Then** the API responds normally without requiring the worker loop to be active in the same process.
2. **Given** the API runtime is serving requests and the worker runtime is stopped, **When** the worker runtime is started later, **Then** queued document jobs begin processing without requiring the API runtime to restart.
3. **Given** the worker runtime exits unexpectedly, **When** the API runtime continues serving requests, **Then** API availability is preserved and newly queued documents remain queued until a worker is available.

---

### User Story 2 - Preserve Existing Document Processing Behavior (Priority: P2)

An operator can split the runtime roles without changing how document jobs are queued, retried, recovered after restart, or marked complete, skipped, or failed.

**Why this priority**: Runtime separation is only safe if existing document-processing behavior remains stable. Regressing job handling would trade one operational problem for another.

**Independent Test**: Can be fully tested by queuing documents, running only the worker runtime, and confirming that successful jobs, retried jobs, stale revisions, deleted documents, and restart recovery behave the same as before.

**Acceptance Scenarios**:

1. **Given** a document job has been queued, **When** the worker runtime claims and processes the job successfully, **Then** the document reaches the ready state and the job is marked complete.
2. **Given** a queued job references a stale document revision or deleted document, **When** the worker runtime attempts the job, **Then** the job is skipped with the existing safe outcome rather than retried indefinitely.
3. **Given** the worker runtime stops while jobs are in progress or left in a processing state, **When** the worker runtime starts again, **Then** recoverable work is returned to a processable state and resumes without manual database intervention.

---

### User Story 3 - Run Local Development With Explicit Runtime Roles (Priority: P3)

A developer can start local Radioso with clearly named API and worker processes or services, so local setup mirrors the production runtime split without guesswork about which role owns which responsibility.

**Why this priority**: The split is only sustainable if the local development workflow makes the two runtime roles explicit and easy to start together or independently.

**Independent Test**: Can be fully tested by running the documented local commands or compose services, confirming that both roles start successfully, and verifying that each role can also be run independently for debugging.

**Acceptance Scenarios**:

1. **Given** a developer wants the full local stack, **When** the developer uses the repository's default local orchestration, **Then** the API and worker roles both start with clear names and expected responsibilities.
2. **Given** a developer needs to debug only background processing, **When** the developer starts only the worker role, **Then** document jobs can still be processed without launching the API role in the same process.
3. **Given** a developer needs to debug only HTTP behavior, **When** the developer starts only the API role, **Then** the server starts without also starting the background worker loop.

### Edge Cases

- What happens when both runtime roles start at nearly the same time and the database schema is not yet up to date?
- What happens when the worker runtime starts before the API runtime has queued any jobs?
- What happens when the API queues jobs while no worker runtime is available for an extended period?
- What happens when the worker runtime is restarted while jobs are in a processing state?
- What happens when one runtime role fails connector or environment initialization while the other role is otherwise healthy?
- What happens when a developer intentionally starts only one of the two roles in local development?
- What happens when the non-migration-owning runtime starts against an outdated schema?
- What happens when the API runtime is healthy but the worker runtime is down and queued jobs are accumulating?

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

- **Boundary Rule**: HTTP transport remains responsible only for API serving and route composition; startup orchestration remains responsible for role-specific boot flow; document-processing domain services remain responsible for claiming and executing queued work; persistence remains responsible for database-backed job and document state transitions.
- **Encapsulation Rule**: `backend/src/app/server/createApp.ts` must remain HTTP composition only and must not gain worker lifecycle responsibilities. `backend/src/modules/documents/services/documentProcessingWorker.ts` must remain the owner of polling and retry behavior rather than having that logic duplicated in a new entrypoint.
- **New Seams Required**: Introduce explicit role-specific backend entrypoints for API and worker execution, plus a shared startup/bootstrap seam for common environment loading, dependency creation, and graceful shutdown wiring that does not absorb HTTP-only or worker-only logic.
- **Anti-Goals**: Do not replace the database-backed job model with a broker-backed queue in this feature. Do not move document-processing behavior into route handlers. Do not make the HTTP process silently start the worker loop. Do not introduce a catch-all startup module that owns transport, worker behavior, and domain logic together.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide separate backend runtime roles for API serving and background document processing.
- **FR-002**: System MUST allow the API runtime to start and serve requests without automatically starting the document-processing worker loop in the same process.
- **FR-003**: System MUST allow the worker runtime to start and process queued document jobs without requiring the HTTP server to start in the same process.
- **FR-004**: System MUST preserve the existing database-backed job lifecycle for queued, processing, completed, skipped, and failed document jobs.
- **FR-005**: System MUST preserve the existing retry and delayed reprocessing behavior for retryable document-processing failures.
- **FR-006**: System MUST preserve the existing stale-revision and deleted-document safeguards when the worker runtime claims queued jobs.
- **FR-007**: System MUST recover in-flight or stranded document jobs safely when the worker runtime restarts after an interruption.
- **FR-008**: System MUST keep runtime startup responsibilities explicit so operators can tell which role owns API serving and which role owns background processing.
- **FR-009**: System MUST provide explicit named commands for starting the API role and the worker role independently in development and production-style runtime usage.
- **FR-010**: System MUST allow repository-supported local orchestration to start both runtime roles together with clear service naming.
- **FR-011**: System MUST allow developers to run only the API role or only the worker role for debugging without editing application code.
- **FR-012**: System MUST ensure the runtime split does not change existing authenticated API contracts, payloads, or status codes.
- **FR-013**: System MUST ensure that startup initialization shared by both roles is executed from a focused shared seam rather than duplicated across multiple entrypoints.
- **FR-014**: System MUST make one runtime role clearly responsible for schema migration ownership during startup so role startup does not rely on unsafe race behavior.
- **FR-014a**: System MUST define the startup behavior for the non-migration-owning role when the schema is outdated, including a fail-fast outcome that does not begin serving HTTP traffic or processing jobs on an incompatible schema.
- **FR-015**: System MUST keep graceful shutdown behavior explicit for both roles so each runtime stops its own resources cleanly.
- **FR-016**: System MUST keep connector and other shared dependency initialization aligned with the actual needs of each runtime role rather than assuming both roles require identical boot steps.
- **FR-016a**: System MUST make the API runtime the owner of connector migration and connector initialization for this feature, and the worker runtime MUST avoid duplicating that boot responsibility unless a documented worker-side connector dependency is added in a later approved spec.
- **FR-017**: System MUST add backend tests that prove the runtime split preserves worker behavior and independent role startup.
- **FR-018**: System MUST emit clear role-specific startup and shutdown logs so operators can distinguish API lifecycle events from worker lifecycle events.
- **FR-019**: System MUST emit worker-operational signals that make it clear when the worker is idle, actively processing, has failed startup, or is unavailable while jobs remain queued.
- **FR-020**: System MUST make backlog growth or queued-work accumulation observable to operators without requiring direct database inspection during normal operation.

### Key Entities *(include if feature involves data)*

- **API Runtime Role**: The long-running backend process responsible for HTTP serving, request handling, and API-facing startup concerns.
- **Worker Runtime Role**: The long-running backend process responsible for claiming and executing queued document-processing jobs.
- **Shared Startup Bootstrap**: The focused startup flow that prepares common dependencies and role-specific lifecycle hooks without owning HTTP or worker behavior directly.
- **Document Processing Job**: The existing queued work item whose lifecycle and retry semantics must remain unchanged by the runtime split.
- **Local Runtime Service Definition**: The repository-supported command or service declaration that identifies how a developer starts one role or both roles locally.

## Assumptions

- The existing database-backed job table remains the only queueing mechanism for this feature.
- The initial version of the worker split does not require a new external queue broker or scheduler.
- No frontend changes are required because the runtime split is operational and backend-facing.
- Existing document processing, retrieval, and chat domain behavior should remain unchanged apart from startup ownership and process boundaries.
- Local development continues to use the repository's existing compose-based topology, expanded only as needed to represent separate backend roles clearly.
- The initial version should prefer one clear migration owner rather than allowing both runtimes to race on schema changes.
- Connector migration and connector initialization are owned by the API runtime for this feature scope.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In runtime-start integration tests, 100% of API-only startup scenarios complete without starting the document worker loop in the same process.
- **SC-002**: In runtime-start integration tests, 100% of worker-only startup scenarios can claim and process queued document jobs without starting the HTTP server in the same process.
- **SC-003**: In document-processing regression tests, 100% of covered success, retry, stale-revision, deleted-document, and restart-recovery scenarios preserve their pre-split outcomes.
- **SC-004**: In local orchestration verification, developers can start both runtime roles together and identify each role's responsibility from the command or service names without additional tribal knowledge.
- **SC-005**: In local debugging verification, developers can start only the API role or only the worker role in one command each without modifying source files.
- **SC-006**: The feature introduces zero intentional HTTP contract changes for existing API routes and keeps contract tests passing without route payload updates.
- **SC-007**: In outdated-schema startup tests, 100% of non-owning-runtime starts fail fast with a clear schema-update message before serving HTTP traffic or processing jobs.
- **SC-008**: In startup verification, operators can identify from logs alone which runtime started, which runtime failed, and whether the worker is idle or processing work.
- **SC-009**: In backlog-observability verification, operators can detect from the supported runtime signals when queued work is accumulating while no worker is available.
- **SC-010**: In connector-bootstrap verification, connector migration and initialization occur from exactly one documented runtime role during normal startup.
