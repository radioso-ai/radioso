# Quickstart: Startup Migration Lock Reliability

## Focused Validation

Run the focused backend tests after implementation:

```bash
cd backend
pnpm test -- tests/unit/run-migrations.test.ts tests/unit/database-config.test.ts tests/unit/runtime-startup.test.ts
```

## Expected Behaviors

### Steady-State Startup

1. Prepare a database where `schema_migrations` exists and includes every migration file.
2. Run the backend migration flow.
3. Confirm no `CREATE TABLE IF NOT EXISTS schema_migrations` statement is issued.
4. Confirm startup completes normally.

### Fresh Database Startup

1. Prepare a database where `schema_migrations` does not exist.
2. Run the backend migration flow.
3. Confirm the migration metadata table is created.
4. Confirm migrations apply and are recorded.

### Blocked Lock Startup

1. Hold a conflicting lock on `schema_migrations` from another database session.
2. Run the backend migration flow with the migration timeout budget enabled.
3. Confirm startup fails before the platform startup probe window.
4. Confirm logs identify startup migrations as the failing phase and do not include database credentials.

### Worker Verification

1. Start worker runtime tests with pending-migration verification enabled.
2. Confirm workers call the read-only pending-migration verification path.
3. Confirm workers do not create the metadata table or apply migrations.

## Documentation Check

Review these operator docs after implementation:

- `docs-portal/content/operators/deployment.mdx`
- `docs-portal/content/operators/self-hosting-operations.mdx`

They should explain migration ownership, expected startup failure signals, lock diagnostics, and the fact that separate pre-deploy migration jobs remain future architecture work.
