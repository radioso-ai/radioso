# Research: Chat Connector Plugin System

**Feature**: 016-chat-connectors | **Date**: 2026-03-18

## R1: Plugin Interface Pattern for Node.js/Express

**Decision**: Explicit registration with a typed `ConnectorPlugin` interface — no dynamic filesystem scanning or `import()`.

**Rationale**: The codebase already follows an explicit wiring pattern in `dependencies.ts` where every service is manually instantiated and passed. Dynamic plugin discovery adds complexity (file scanning, path resolution, error handling for malformed plugins) without benefit when the set of connectors is known at build time. Explicit registration means type safety is enforced at compile time.

**Alternatives considered**:
- Dynamic `import()` with filesystem scanning: Too complex for the current scale. Would require runtime validation of the plugin interface. Rejected per spec anti-goals.
- Plugin manifest file (JSON): Adds an indirection layer without type safety. Still needs explicit import for each plugin module.

## R2: Secret Encryption at Rest

**Decision**: Use AES-256-GCM with a server-level encryption key stored in `.env` (`CONNECTOR_ENCRYPTION_KEY`). Each secret field is encrypted individually with a unique IV. Stored format: `iv:ciphertext:authTag` (base64-encoded).

**Rationale**: AES-256-GCM provides authenticated encryption (confidentiality + integrity). Using a single server-level key is simpler than per-workspace keys while still protecting against database compromise. The IV-per-field ensures identical values produce different ciphertexts. This matches the project's existing pattern of server-level secrets in `.env`.

**Alternatives considered**:
- Per-workspace encryption keys: More secure isolation but complex key management. Overkill for the current threat model (database compromise).
- PostgreSQL `pgcrypto` extension: Would tie encryption to the database layer. Keeping it in application code gives more control and avoids DB extension dependencies.
- HashiCorp Vault / AWS KMS: Enterprise-grade but introduces an external dependency not present in the current stack.

## R3: WhatsApp Cloud API Integration Pattern

**Decision**: Async webhook processing with immediate 200 acknowledgement. Use `whatsappClient.ts` as a thin HTTP client wrapping `fetch()` calls to the Graph API.

**Rationale**: Meta requires webhook acknowledgement within a tight window (undocumented exact timeout, but 5 seconds is the safe threshold). The RAG + LLM pipeline takes much longer. So the webhook handler must: (1) validate signature, (2) parse payload, (3) store in message log with status `received`, (4) return 200, (5) process asynchronously. No external SDK is needed — the Cloud API is a straightforward REST API with well-documented JSON payloads.

**Alternatives considered**:
- WhatsApp Business API SDK (unofficial npm packages): Adds a dependency with unclear maintenance. The API surface we use (send text, receive webhook) is small enough to wrap directly.
- Synchronous processing with extended timeout: Risky — Meta may disable the subscription after repeated slow responses.

## R4: Message Debounce Strategy

**Decision**: Per-sender in-memory debounce using `setTimeout`. When a message arrives for a sender, start/reset a 3-second timer. When the timer fires, concatenate all buffered messages (joined by newlines) and process as a single input.

**Rationale**: Simple and effective for the expected message volume. In-memory timers are sufficient since the connector runs in a single process. If the process restarts during a debounce window, the buffered messages are lost — but they're already logged in the message log with status `received` and won't be re-processed (dedup by wamid), so no duplicate replies will be sent.

**Alternatives considered**:
- Redis-based debounce: More durable across restarts but introduces a new infrastructure dependency not present in the stack.
- Database-based queue with polling: Higher latency, more complex. The debounce window is short (3s) so polling intervals would need to be sub-second.
- No debounce (process each message independently): Leads to out-of-order responses and wasted LLM calls. Rejected in clarification.

## R5: Connector Migration Strategy

**Decision**: Two-tier migration approach. (1) Core migration `007_connector_config.sql` creates the shared `connector_configs` table — this runs through the existing migration runner. (2) Each connector plugin defines its own `migration.sql` file, executed by the `ConnectorRegistry` during plugin initialization (after core migrations complete).

**Rationale**: Core migrations handle the shared infrastructure table. Plugin-specific migrations are managed by the plugin itself, keeping them self-contained. The registry runs plugin migrations in a transaction, tracking applied migrations in a `connector_migrations` table to ensure idempotency.

**Alternatives considered**:
- All migrations in the core `migrations/` folder: Breaks plugin encapsulation. Adding a new connector would require adding files to the core migration directory.
- Plugin migrations as programmatic schema builders (Knex-style): The project uses raw SQL migrations. Staying consistent avoids introducing a new pattern.

## R6: Frontend Config Form Rendering

**Decision**: Generic schema-driven form using existing Shadcn/ui components. The backend returns a config schema (array of field descriptors with type, label, required, placeholder, options). The frontend `connector-config-form.tsx` renders each field using the appropriate Shadcn/ui input component (Input for text, Input type=password for secret, Switch for toggle, Select for select).

**Rationale**: Keeps the frontend connector-agnostic per spec anti-goals. No connector-specific React code needed. Adding a new connector only requires implementing the backend plugin — the UI renders automatically from the schema.

**Alternatives considered**:
- Per-connector React components: Gives maximum UI flexibility but violates the spec constraint and creates frontend work for each new connector.
- JSON Schema + react-jsonschema-form: Adds a dependency. The schema is simple enough (4 field types) that a custom renderer is minimal and fully controlled.

## R7: Connector Config Storage

**Decision**: Single `connector_configs` table with columns: `workspace_id`, `connector_id`, `enabled`, `config_data` (JSONB, encrypted secret fields), `error_status`, `created_at`, `updated_at`. Composite unique key on `(workspace_id, connector_id)`.

**Rationale**: JSONB for config data is flexible — each connector can have different fields without schema changes. Secret fields within the JSONB are individually encrypted before storage. The table is shared across all connectors, with the `connector_id` column distinguishing them. This avoids creating a separate config table per connector.

**Alternatives considered**:
- Per-connector config tables: More isolated but creates table proliferation for config that is structurally the same across connectors.
- EAV (entity-attribute-value) pattern: More normalized but harder to query and reason about. JSONB is the standard PostgreSQL approach for semi-structured config.
