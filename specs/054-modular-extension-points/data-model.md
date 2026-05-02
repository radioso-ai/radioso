# Data Model: Modular Extension Points

This feature does not require new database tables or persisted records. The entities below are in-process application concepts and contracts.

## Application Module

Represents a cohesive contribution registered during application assembly.

**Fields**

- `id`: Stable unique module identifier.
- `name`: Human-readable module name for logs and diagnostics.
- `register`: Lifecycle function that contributes to one or more extension points.
- `initialize`: Optional lifecycle function for startup work.
- `shutdown`: Optional lifecycle function for cleanup.

**Validation Rules**

- `id` must be unique within the application composition.
- Registration must be deterministic for the same default inputs.
- Initialization errors must be reported without leaking secrets or customer data.

**Relationships**

- May contribute zero or more Extension Point registrations.
- May depend on default services passed through a constrained registration context.

## Extension Point

Represents a named boundary where default or optional contributions are accepted.

**Fields**

- `key`: Canonical extension point identifier.
- `owner`: Owning product area or module.
- `defaultBehavior`: What happens when no optional contribution is registered.
- `register`: The accepted registration action for this extension category.

**Validation Rules**

- Extension points must have clear ownership.
- Extension points must define default behavior.
- Extension point registration must reject incompatible contribution types.

**Relationships**

- Receives contributions from Application Modules.
- Maps to existing registries or ports where those already exist.

## Capability Policy

Answers whether a request context may perform a named action.

**Fields**

- `can`: Decision function for a capability name and context.
- `describe`: Optional diagnostic function that explains policy mode without exposing sensitive data.

**Validation Rules**

- Default policy must allow all current actions.
- Denial must happen before mutations or privileged operations.
- Denial responses must be operational responses, not assistant-authored conversational copy.

**Relationships**

- Uses Capability Names from the shared catalog.
- Is provided to product workflows through application dependencies.

## Capability Name

Canonical identifier for a guarded action.

**Fields**

- `name`: Stable string identifier.
- `description`: Plain-language description.
- `owner`: Owning product area.

**Validation Rules**

- Names must be defined in one shared catalog.
- Product code must not invent ad hoc capability names.
- Tests must cover invalid or unknown capability handling.

## Default Composition

The baseline set of modules and adapters required for current product behavior.

**Fields**

- `modules`: Default Application Modules.
- `capabilityPolicy`: Default allow policy.
- `connectors`: Built-in connector registrations.
- `sinks`: Default telemetry, analytics, and incident sink bundles.
- `storage`: Default document storage adapter selection.
- `workerDispatch`: Default document job dispatcher selection.
- `retrieval`: Default retrieval stage and strategy construction.

**Validation Rules**

- Must build without optional modules.
- Must preserve existing local/self-hosted behavior.
- Must not introduce new required environment variables.

## Optional Adapter

An implementation of a supported extension contract that may be omitted.

**Fields**

- `id`: Stable unique adapter identifier.
- `extensionPoint`: Extension point the adapter contributes to.
- `configRequirements`: Optional configuration requirements.
- `register`: Registration behavior.

**Validation Rules**

- Missing optional adapters must not break default composition.
- Misconfigured adapters must fail with actionable diagnostics.
- Adapter errors must not corrupt existing default registrations.
