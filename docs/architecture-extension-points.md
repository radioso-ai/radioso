# Architecture Extension Points

Radioso keeps default product behavior in the core application and lets optional behavior enter through explicit extension points. The goal is to make future additions predictable without putting deployment-specific decisions in routes, frontend components, or product services.

## Core Idea

The default application is assembled from a known set of modules. Optional modules can add behavior by registering with a supported extension point during application startup.

In practice, product code should depend on stable contracts. It should not import optional implementations directly.

## Default Composition

The default composition is the baseline application used by local and self-hosted runs. It includes the current API, dashboard, document ingestion, retrieval, chat, settings, workspace, connector, observability, and worker behavior.

Default composition must build and run without optional modules or deployment-specific packages. CI verifies this with the backend build and composition-focused tests.

## Supported Extension Categories

| Category | Owner | Registration path | Default behavior | Anti-goal |
|---|---|---|---|---|
| Connectors | Connector module | Connector registry through application composition | Built-in connector catalog is registered; no optional connector is required | Do not import connector implementations from route handlers |
| Capability policy | Application composition | Capability policy contract | Default policy allows existing actions | Do not scatter availability checks through unrelated services |
| Telemetry, analytics, and incidents | Shared observability modules | Sink contracts | Default sinks use existing audit, metrics, logs, or no-op behavior based on config | Do not put vendor payload logic in product workflows |
| Document storage | Documents module | Storage adapter selection helper | Local or configured GCS storage follows existing environment behavior | Do not make storage-specific code part of document business logic |
| Worker dispatch | Documents module | Job dispatcher and consumer adapter selection helpers | No-op polling, configured Cloud Tasks dispatch, or configured AMQP dispatch follows environment behavior | Do not make queue-provider logic part of ingestion orchestration |
| Retrieval construction | Retrieval module | Stage and strategy construction helpers | Existing vector, lexical, rewrite, rerank, and prompt assembly behavior remains the default | Do not add retrieval ranking behavior to HTTP routes |

## Capability Policy

Capability policy is a neutral check for product actions. The default policy allows current behavior.

Use capability policy when a workflow needs to know whether an action is available in the current application composition. The check should happen before mutations or privileged work.

Capability names come from a shared catalog. Product code should not invent new capability strings inline.

## Module Boundaries

Routes translate requests and responses. They do not own module registration.

Product services coordinate workflows. They may call stable contracts such as capability policy, storage ports, or dispatch ports, but they should not decide which deployment-specific implementation is active.

Composition code assembles defaults and optional modules. This is where adapter selection and module registration belong.

Persistence and integration adapters talk to databases, queues, object storage, external telemetry targets, and similar systems. Their details stay behind focused ports.

Worker dispatch has two parts. The dispatcher publishes a wake-up notification after a durable document processing job exists. The optional consumer listens for broker deliveries in worker runtimes and delegates back to the worker's job-by-id processing path. The PostgreSQL job table remains authoritative for status, retries, leases, and recovery. AMQP dispatch intentionally keeps the worker polling loop active; broker messages improve wake-up latency, while polling preserves recovery and scheduled retry behavior through `available_at`.

## Adding A New Extension

First, identify the existing extension category. If one exists, implement that contract and register the module through composition.

If no category exists, add a focused contract in the owning product area and document:

- owner
- registration path
- default behavior
- failure behavior
- tests proving the default composition still works without the extension

Avoid adding conditionals to route handlers or frontend components just to detect whether an optional module exists.
