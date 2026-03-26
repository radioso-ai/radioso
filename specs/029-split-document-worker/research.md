# Research: Split Document Worker Runtime

## Decision: Keep the database-backed job model and split only the runtime entrypoints

### Rationale

- The approved spec explicitly excludes broker-backed queues and requires preserving current job semantics.
- The existing `document_processing_jobs` table already supports queueing, retry scheduling, stale revision handling, and restart recovery.
- Separating the API and worker processes delivers the required failure isolation without broadening infrastructure scope.

### Alternatives considered

- Introduce Redis, SQS, or RabbitMQ: rejected as out of scope and unnecessary for the approved runtime split.
- Keep a single process with optional worker flag: rejected because it keeps startup and lifecycle concerns coupled inside one entrypoint.

## Decision: Make the API runtime the migration and connector owner

### Rationale

- The spec requires one clear migration owner and explicitly assigns connector migration/init ownership to the API runtime.
- Current startup already runs SQL migrations plus connector migrations before serving traffic, so preserving that ownership minimizes regression risk.
- The worker only needs shared application dependencies plus document-processing services; it does not need connector bootstrapping for the approved scope.

### Alternatives considered

- Let both runtimes run migrations opportunistically: rejected because it relies on startup races and weakens observability.
- Make the worker own migrations: rejected because connector initialization and route-serving dependencies already live with the API runtime.

## Decision: Fail fast in the worker when pending SQL migrations exist

### Rationale

- The non-owning runtime must not process jobs on a stale schema.
- The SQL migration system already has a deterministic source of truth: migration files plus the `schema_migrations` table.
- A startup check for pending migrations is simpler and safer than allowing partial execution and surfacing failures later during job processing.

### Alternatives considered

- Allow the worker to start and error on first incompatible query: rejected because it hides the real cause and violates the fail-fast requirement.
- Make the worker trigger the API-owned migration path: rejected because it blurs ownership and recreates the double-run race.

## Decision: Use log-based operational signals for the first version

### Rationale

- The approved spec requires role-specific startup/shutdown logs and backlog visibility, but it does not require new APIs or schema changes.
- The existing `DocumentProcessingWorker` already owns the polling loop, making it the right place to emit worker state transitions and backlog counts.
- API-side document enqueue paths can log queued work volume, while worker-side idle/claim/finish logs make it clear when work is or is not being consumed.

### Alternatives considered

- Add a new worker health HTTP endpoint: rejected because it would add a new contract surface for an internal process without being required by the spec.
- Persist heartbeat state in new tables: rejected because it adds persistence surface for a first-pass operational split.
