# Data Model: Startup Migration Lock Reliability

This feature does not add application entities or user-facing data. It clarifies operational entities that already exist.

## Migration Metadata Table

Represents the applied SQL migration ledger.

- **Name**: `schema_migrations`
- **Key attributes**:
  - `filename`: migration file name, unique primary identifier
  - `applied_at`: timestamp when the migration was recorded as applied
- **Relationships**:
  - One row corresponds to one SQL migration file under `backend/src/db/migrations/`.
- **Validation rules**:
  - A migration file is considered applied only when its filename is present.
  - The table must exist before applied migrations can be read.

## Startup Migration Run

Represents one backend pre-listen migration attempt.

- **Key attributes**:
  - runtime role: `api`
  - metadata table state: exists or missing
  - pending migration filenames
  - timeout policy applied to the migration connection
  - failure class when startup fails
- **State transitions**:
  - start
  - metadata table check
  - metadata table initialization if missing
  - pending migration application
  - complete or fail

## Migration Timeout Budget

Represents the bounded lock and statement execution budget for startup migrations.

- **Key attributes**:
  - lock timeout in milliseconds
  - statement timeout in milliseconds
- **Validation rules**:
  - Values must be positive integers when exposed through environment configuration.
  - The effective failure budget should be shorter than the platform startup probe window.

## Pending-Migration Verification

Represents worker startup's read-only check that schema is current.

- **Key attributes**:
  - pending migration filenames
  - verification result: pass or fail
- **Constraints**:
  - Must remain SELECT-only.
  - Must not create the metadata table.
  - Must not apply SQL migrations.
