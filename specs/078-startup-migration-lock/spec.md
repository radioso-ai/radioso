# Feature Specification: Startup Migration Lock Reliability

**Feature Branch**: `issue-613-spec`
**Created**: 2026-06-04
**Status**: Approved
**Tracking**: GitHub issue #613
**Input**: User description: "Backend startup migration (CREATE TABLE schema_migrations) can block on a lock, causing silent startup hangs and cascading Cloud Run deploy failures."

## Scope Decision

This feature fixes the backend startup failure mode reported in issue #613:

1. **Fast, loud startup failure for blocked migrations.** When startup SQL migrations are blocked by database locks or long-running statements, the backend must fail quickly with structured application logs rather than waiting for the Cloud Run startup probe window to expire with no application logs.

2. **No steady-state DDL lock on the migration table.** When the `schema_migrations` table already exists and all migrations are applied, backend startup must not attempt table-creation DDL before checking existing migration state.

3. **Operational guidance for deploy incidents.** Operator documentation must explain what the backend does during startup migrations, what failure signal to expect, and how to diagnose or recover from a migration lock wait.

The longer-term move to a separate pre-deploy migration job is not part of this feature. This spec should leave the migration-runner separation as a future deployment architecture improvement rather than expanding the immediate reliability fix.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Backend Starts Cleanly When Migrations Are Current (Priority: P1)

As an operator deploying a new backend revision when the database schema is already current, I need the backend to finish startup without taking a table-creation lock on the migration metadata table, so overlapping deploys do not create avoidable database contention.

**Why this priority**: This removes the steady-state contention that caused repeated deploy retries to hang behind an orphaned lock.

**Independent Test**: Can be fully tested against a database where `schema_migrations` already exists and contains every migration filename. Start the backend migration flow and verify it reads applied migration state without issuing table-creation DDL for `schema_migrations`.

**Acceptance Scenarios**:

1. **Given** the migration metadata table exists and all migrations are applied, **When** the backend startup migration flow runs, **Then** it checks existing migration state without attempting to create the metadata table.
2. **Given** the migration metadata table exists and no migrations are pending, **When** overlapping backend revisions start, **Then** neither revision waits on a table-creation lock for the metadata table.
3. **Given** a migration metadata table is missing on a fresh database, **When** the backend startup migration flow runs, **Then** it still creates the metadata table and applies migrations normally.

---

### User Story 2 - Blocked Startup Migration Fails Fast And Loudly (Priority: P1)

As an operator deploying a backend revision, I need a blocked migration lock wait to produce a clear application log and a quick failed startup, so I can distinguish a database lock issue from a broken image or port-binding failure.

**Why this priority**: The incident produced four-minute silent startup probe failures. The fix must make the failure observable and reduce deploy retry time.

**Independent Test**: Can be fully tested by holding a conflicting database lock on `schema_migrations`, starting the backend migration flow, and verifying it fails within the configured startup budget with a structured log naming the migration startup failure.

**Acceptance Scenarios**:

1. **Given** another database session holds a lock that blocks startup migration metadata access, **When** the backend startup migration flow waits on that lock, **Then** it fails before the platform startup probe timeout and logs a clear migration lock or timeout error.
2. **Given** a startup migration metadata check exceeds the metadata statement budget, **When** the backend starts, **Then** the backend exits with a visible application error instead of silently waiting until the platform reports a port-listen failure.
3. **Given** a blocked migration fails fast, **When** the deploy platform reports the failed revision, **Then** Cloud Logging or equivalent application logs include enough structured context to identify the database migration phase as the blocker.

---

### User Story 3 - Operators Can Diagnose And Recover Migration Lock Incidents (Priority: P2)

As a self-hosting or hosted-environment operator, I need deployment documentation to describe backend startup migrations and lock diagnostics, so I can recover from a blocked rollout without rediscovering the same database queries and mitigation steps.

**Why this priority**: The bug is partly an observability problem. The fix must preserve the diagnostic knowledge from the incident in durable operator docs.

**Independent Test**: Can be fully tested by reviewing the deployment or self-hosting operations guide and verifying it explains the startup migration signal, the expected fast-fail behavior, and safe diagnostics for migration lock waits.

**Acceptance Scenarios**:

1. **Given** an operator sees a backend startup migration timeout, **When** they open the deployment or self-hosting operations guide, **Then** the guide identifies migration lock waits as a possible cause and describes how to inspect blocking sessions.
2. **Given** the backend now fails fast on migration lock waits, **When** documentation describes startup probes, **Then** it explains that migration failures should appear in application logs rather than only as port-listen failures.
3. **Given** a deployment uses separate backend and worker runtimes, **When** documentation discusses migration ownership, **Then** it explains that the backend owns SQL migrations and workers only verify pending migrations.

### Edge Cases

- A fresh database has no `schema_migrations` table; startup must still initialize the migration metadata table and apply migrations.
- The metadata table exists but one or more migrations are pending; startup may need to run migration SQL, and metadata timeout handling must not abort legitimate long-running migration bodies.
- The metadata table exists but is locked by another backend instance, a stale deploy session, or manual database work; startup must fail within the migration timeout budget with logs.
- The metadata table exists outside the canonical `public` schema or has drifted unexpectedly; startup must use `public.schema_migrations` consistently rather than depending on connection search path.
- A lock timeout failure may happen before the backend binds its HTTP port; logs must still be emitted before process exit.
- Worker and crawler worker runtimes must continue to use pending-migration verification and must not begin applying SQL migrations.
- Timeout settings must not expose database credentials or sensitive SQL payloads in logs.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; runtime conversational copy MUST be generated by the LLM so multilingual behavior remains intact.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit tests MUST stay focused on non-visual logic rather than markup or design assertions.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated if configuration changes.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.
- Public API, SDK, MCP, connector, worker payload, or other cross-service contract changes MUST include a message-queue impact review and update generated contracts/docs when affected.
- Operator-facing deployment and migration behavior changes MUST update the relevant docs in the same change.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: API runtime startup owns sequencing of pre-listen tasks and must remain orchestration-only. The database migration module owns migration discovery, migration metadata checks, migration application, and migration-specific timeout behavior. Generic database infrastructure may expose reusable connection options but must not encode migration policy or deployment-specific product behavior. Worker runtimes own pending-migration verification only and must not apply SQL migrations.
- **Encapsulation Rule**: The API runtime must not inline SQL migration details or lock-diagnostic queries. The generic database wrapper must not learn about `schema_migrations` table semantics. Migration observability must use the existing application logger and avoid creating a separate logging path. Operator docs must describe behavior and diagnostics without becoming a run log for this specific incident.
- **New Seams Required**:
  - A focused migration startup policy that defines the timeout budget, failure classification, and log context for migration metadata lock waits while preserving long-running migration bodies.
  - A SELECT-first migration metadata check so the migration flow can distinguish an existing metadata table from a fresh database before attempting table-creation DDL.
  - Regression tests that can observe migration SQL sequencing and timeout/failure behavior without relying on Cloud Run itself.
- **Anti-Goals**: Do not bind the backend port before required startup migrations complete. Do not move migrations into worker runtimes. Do not introduce a separate migration job or deploy pipeline in this feature. Do not hand-edit generated OpenAPI artifacts. Do not add English keyword heuristics to diagnose incidents. Do not log database credentials, full connection strings, or sensitive SQL parameter values.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST check whether the migration metadata table already exists before attempting table-creation DDL for that table.
- **FR-002**: System MUST avoid table-creation DDL for the migration metadata table during steady-state startup when the table already exists.
- **FR-003**: System MUST continue to initialize the migration metadata table on a fresh database where the table does not exist.
- **FR-004**: System MUST continue to identify and apply pending SQL migrations when migrations are not current.
- **FR-005**: System MUST apply a bounded lock-wait budget to the startup migration connection so a blocked metadata-table lock cannot silently consume the full platform startup probe window.
- **FR-006**: System MUST apply a bounded statement-execution budget to migration metadata checks and bookkeeping so blocked metadata access fails visibly rather than hanging startup indefinitely.
- **FR-007**: System MUST log the beginning and failure of startup migration execution with structured context sufficient to identify the migration phase, timeout class, and affected runtime role.
- **FR-008**: System MUST convert migration metadata lock or statement timeout failures into process-visible startup failures that appear in application logs before exit.
- **FR-009**: System MUST keep worker and crawler worker startup behavior as pending-migration verification only; those runtimes MUST NOT create the migration metadata table or apply SQL migrations.
- **FR-010**: System MUST preserve successful local, test, and production startup behavior when the database is reachable and no migration metadata lock or statement timeout occurs.
- **FR-011**: System MUST avoid logging database credentials, full connection strings, or sensitive SQL parameter values in migration startup logs.
- **FR-012**: System MUST add backend regression tests before implementation for steady-state no-DDL startup, fresh-database metadata initialization, blocked-lock fast failure, and worker pending-migration verification remaining SELECT-only.
- **FR-013**: System MUST update operator-facing deployment or self-hosting documentation to explain backend migration ownership, the new fast-fail signal, and migration lock diagnostics.
- **FR-014**: System MUST document that a separate pre-deploy migration job is future architecture work and is not required to resolve this startup hang.
- **FR-015**: System MUST include a message-queue impact review in planning stating that document worker dispatch, AMQP payloads, retry semantics, and queue docs/tests are unaffected unless implementation discovery proves otherwise.

### Key Entities

- **Migration Metadata Table**: The database table that records which SQL migration files have been applied.
- **Startup Migration Run**: The backend pre-listen workflow that checks migration state and applies pending SQL migrations before accepting API traffic.
- **Migration Timeout Budget**: The bounded time allowed for migration metadata lock waits and metadata statements during backend startup.
- **Pending-Migration Verification**: The SELECT-only worker startup check that ensures workers do not process jobs against an out-of-date schema.
- **Deployment Revision**: A backend service instance starting during a rollout and subject to platform startup probes.

### Assumptions

- The immediate fix should keep backend-owned migrations during startup and should not introduce a separate migration job.
- The platform startup probe window is approximately four minutes in the reported Cloud Run environment; migration timeout budgets should be significantly shorter than that window.
- The worker cold-start asymmetry described in the issue is expected and should remain: workers verify migration state but do not apply migrations.
- This feature does not change public HTTP routes, SDK APIs, MCP contracts, connector contracts, or worker queue payloads.
- Operator docs are part of the product surface for deployment reliability and must be updated with the implementation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In covered regression tests with an existing fully applied migration metadata table, backend startup performs zero table-creation DDL statements against the metadata table.
- **SC-002**: In a blocked-lock test, backend startup fails within 30 seconds with a structured application log that identifies startup migrations as the failing phase.
- **SC-003**: In covered regression tests for a fresh database, startup still creates the migration metadata table and applies migrations successfully.
- **SC-004**: Worker and crawler worker startup tests continue to show pending-migration verification without SQL migration application.
- **SC-005**: The implementation introduces no public API, SDK, MCP, connector, or worker queue payload changes.
- **SC-006**: Operator documentation describes the startup migration owner, expected failure signal, lock diagnostic query pattern, and recovery path clearly enough for an operator to diagnose a blocked migration rollout without reading issue #613.
