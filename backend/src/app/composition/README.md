# Application Composition

Application composition assembles the default runtime. Start here when a change
adds or swaps adapters, registries, lifecycle hooks, sinks, capability policies,
storage implementations, worker dispatchers, providers, or optional modules.

For the broader repository map, see
[`docs/architecture/code-map.md`](../../../../docs/architecture/code-map.md).

## Boundaries

Composition knows how implementations are selected and wired for the running
application.

Composition should not own product rules, domain decisions, validation details,
or user-facing behavior. Domain modules expose narrow construction helpers;
composition calls them and assembles the result.

## Read First

- `defaultComposition.ts`: baseline OSS application wiring.
- `applicationModule.ts`: module registration shape.
- `builtIn/`: built-in module registrations for optional surfaces that ship
  with the default app.
- `workspaceLlmCapabilityResolver.ts`: workspace-scoped LLM capability wiring.
- `backend/src/modules/*/composition.ts`: module-owned construction helpers.

## Common Change Paths

- New replaceable runtime behavior: add a narrow port in the owning module,
  provide default behavior, then wire the default here.
- Optional feature behavior: register it through an application module instead
  of importing optional implementation details into routes or domain services.
- Capability checks: define stable capability names and keep checks close to
  the mutation or privileged workflow.
- Storage, queue, telemetry, and provider changes: keep provider-specific code
  behind adapters and select those adapters here.
- Realtime mutation acceleration: `realtimePublisherComposition.ts` selects the
  disabled no-op or the bounded producer backed by a lazy, publisher-only Redis
  adapter. It exposes only the synchronous publisher port to API/worker graphs;
  subscriber/admission clients belong to the dedicated realtime composition and
  broker adapters remain outside mutation services.

## Tests

Focused starting points:

- `cd backend && pnpm run test:composition`
- `cd backend && pnpm run build`
- `cd backend && pnpm run validate:architecture` when boundaries change.

The default composition must build and run without optional Enterprise modules.
