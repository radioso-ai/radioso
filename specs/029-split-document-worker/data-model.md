# Data Model: Split Document Worker Runtime

## API Runtime Role

- Purpose: Own HTTP serving, SQL migration execution, connector migration, connector initialization, and API-facing shutdown.
- Inputs: backend environment configuration, database connection, connector configuration, HTTP traffic.
- Outputs: HTTP responses, route-level logs, connector lifecycle logs.

## Worker Runtime Role

- Purpose: Own recovery and execution of queued document-processing jobs without serving HTTP routes.
- Inputs: backend environment configuration, database connection, queued document-processing jobs.
- Outputs: worker lifecycle logs, queue-processing logs, document/job state transitions.

## Shared Startup Bootstrap

- Purpose: Assemble common dependencies and apply runtime-role-specific startup decisions.
- Responsibilities:
  - load environment safely
  - build shared dependencies
  - verify migration state for non-owning runtimes
  - expose role-specific startup and shutdown hooks

## Migration State

- Source of truth: SQL migration files under `backend/src/db/migrations/` plus rows recorded in `schema_migrations`.
- Lifecycle:
  - API runtime applies pending migrations before serving traffic.
  - Worker runtime checks for pending migrations before processing jobs.
  - If migrations are pending, worker startup exits before claiming work.

## Document Processing Job

- Existing entity preserved for this feature.
- Fields used by the runtime split:
  - `status`
  - `attemptCount`
  - `availableAt`
  - `claimedAt`
  - `completedAt`
- Runtime expectations:
  - API runtime may enqueue jobs but does not execute them.
  - Worker runtime claims jobs, retries failures, and recovers stranded work on restart.

## Operational Queue Snapshot

- Derived runtime signal, not a new persisted entity.
- Captures:
  - queued job count
  - processing job count
  - oldest queued job age when available
- Used for role-specific logs and backlog observability.
