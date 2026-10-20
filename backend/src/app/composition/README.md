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
- `abuseControl.ts`: selects the Postgres counter or the Redis counter with Postgres failover.
- `applicationModule.ts`: module registration shape.
- `builtIn/`: built-in module registrations for optional surfaces that ship
  with the default app.
- `workspaceLlmCapabilityResolver.ts`: workspace-scoped LLM capability wiring. Precedence is agent override → workspace preference → env default, then a registered `ManagedModelPolicy` (`shared/domain/managedModelPolicy.ts`, `registerManagedModelPolicy`) may replace the candidate for a workspace that holds no key of its own for the candidate provider; a workspace key for that provider keeps the candidate, and removing the key restores the managed selection. `resolvedBy` on the result names the winning model-selection step.
- `backend/src/modules/*/composition.ts`: module-owned construction helpers.
- `backgroundJobs.ts`: the durable background job queue, the runtime the worker
  drains, and the dead-letter retention sweep. Modules enqueue through the
  `BackgroundJobQueue` port and return handlers that `dependencies.ts` passes to
  `createRuntime`; see `backend/src/shared/background-jobs/README.md`.
- `conversationErasure.ts` and `conversationRetention.ts`: every module's eraser
  for conversation-derived rows no foreign key reaches, and every module's fixed
  retention window (`ConversationDataRetentionRule`) over rows that outlive their
  conversation's own window. The retention sweep is a built-in periodic task
  (`conversation-retention`), prepended to the `registerPeriodicTask` entries in
  `dependencies.ts`, so the poll worker's interval loop and the push worker's
  `/internal/tasks/periodic-tasks/:taskId/run` route both run it. A module that
  keeps a shorter-lived copy of conversation content registers its rule here.
- `conversationLockOrder.ts`: the conversation lock protocol every unit of work
  touching a conversation's ownership, held replies or mailbox policy follows,
  and the bounded deadlock retry for the units that can still meet one. Read it
  before adding a unit of work that locks any of those rows.

## Common Change Paths

- New replaceable runtime behavior: add a narrow port in the owning module,
  provide default behavior, then wire the default here.
- Optional feature behavior: register it through an application module instead
  of importing optional implementation details into routes or domain services.
- Operator copilot tools from an optional module: `registerCopilotTools` in
  `applicationModule.ts`, assembled by `copilotToolCatalog.ts`. The contribution
  declares the operation and application-primitive identities its descriptors
  cite, since this repository's public contract and owning-port registry describe
  first-party surfaces only. The catalog serves tenant operators: every
  descriptor takes a workspace-scoped invocation context and every permission
  resolves through workspace membership, so a staff principal that holds no
  membership needs its own catalog rather than a filter over this one.
- Handing a service to another module's port: adapt the service into an object
  of closures, as `websiteCrawlerIngestionPort.ts` does. Ports are structural
  interfaces, so a service instance satisfies one directly, and its methods then
  carry a `this` the consumer knows nothing about; a consumer that holds such a
  method as a value loses the receiver at runtime. Closures make the port's
  surface explicit and keep it callable however a consumer holds it.
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
