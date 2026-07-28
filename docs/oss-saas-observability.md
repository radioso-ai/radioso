---
title: "OSS And SaaS Observability"
description: "Vendor-neutral observability strategy separating telemetry, analytics, and error reporting via internal contracts with OSS defaults and optional SaaS exporters."
last_updated: 2026-06-24
---

# OSS And SaaS Observability

This note defines a vendor-neutral observability strategy for Radioso that works for both open source deployments and Radioso-operated SaaS.

The goal is simple:

- keep the open source product free of hard-coded PostHog or Sentry dependencies
- provide strong operational visibility for Radioso Cloud
- let self-hosting operators stop at logs, metrics, and built-in audit events if they want
- make commercial backends optional deployment-time adapters instead of product defaults

## Recommendation

Radioso should separate three concerns that are often mixed together:

1. application telemetry
2. product analytics
3. crash and error reporting

Each concern should use a stable internal interface owned by Radioso. Vendor SDKs, if enabled at all, should sit behind adapters that are disabled by default.

## Why This Fits Radioso

Radioso already has two useful primitives:

- structured backend logging in [`backend/src/shared/observability/logger.ts`](../backend/src/shared/observability/logger.ts)
- workspace-scoped audit events in [`backend/src/modules/audit/services/auditService.ts`](../backend/src/modules/audit/services/auditService.ts)

Those pieces are enough to avoid a vendor-first design.

The missing layer is a small internal observability contract that routes:

- runtime telemetry to logs, metrics, and traces
- product events to audit storage and optional exporters
- crashes to a normalized internal error event stream plus optional external sinks

## Design Principles

### OSS-first defaults

The repository should ship with no required dependency on closed hosted services. A local or self-hosted operator should get value from the default install without signing up for another product.

### Vendor-neutral instrumentation

Instrumentation should be based on standards, not a storage vendor. OpenTelemetry is the right default for traces and telemetry export, and Prometheus or OpenMetrics is the right default for metrics exposure.

### Adapters at the edge

Third-party integrations should be deployment choices. The core app should know about an `AnalyticsSink` or `ErrorSink`, not about PostHog or Sentry directly.

### Privacy by default

Telemetry emitted from a retrieval product can accidentally include prompts, user content, document fragments, connector secrets, and account identifiers. The internal model must define what is allowed to leave the process and what must stay local.

## Layer 1: Application Telemetry

Application telemetry answers operational questions such as:

- is the API healthy
- are background jobs stuck
- is latency regressing
- which retrieval stage is failing
- which workspace or route is producing the highest error rate

### What to emit

- structured logs
- counters
- gauges
- histograms
- traces and spans

### Source of truth

- Pino remains the structured log source
- OpenTelemetry becomes the trace and metric instrumentation layer
- a Prometheus-compatible `/metrics` endpoint becomes the default scrape surface

### Current metric set

The Prometheus-style surface is intentionally small and low-cardinality:

- `radioso_http_requests_total`
- `radioso_http_request_duration_ms`
- `radioso_telemetry_events_total`
- `radioso_retrieval_pipeline_runs_total`
- `radioso_retrieval_candidate_count`
- `radioso_retrieval_final_context_count`
- `radioso_document_worker_events_total`
- `radioso_document_worker_queue_jobs`
- `radioso_document_worker_job_duration_ms`
- `radioso_product_events_total`
- `radioso_errors_total`

Additional traces, request-in-flight gauges, and richer chat-specific metrics can
be layered on later without changing the internal seams.

### Trace boundaries

Create spans around:

- inbound HTTP requests
- chat answer generation
- retrieval pipeline stages
- document processing jobs
- connector fetch operations
- database queries only where sampling and cost remain acceptable

### Correlation fields

Every log and trace should carry stable identifiers where available:

- `requestId`
- `workspaceId`
- `accountId`
- `conversationId`
- `jobId`
- `documentId`
- `route`
- `deployment.environment`
- `deployment.version`

Do not attach raw document text, prompt bodies, or secrets to high-cardinality telemetry by default.

## Layer 2: Product Analytics

Product analytics answers questions such as:

- which features are used
- where onboarding drops off
- which settings correlate with successful answers
- how many workspaces activate document upload, chat, public chat, or embed

This should not be implemented as direct PostHog calls from random controller code.

### Internal event model

Define a small typed product event contract, for example:

- `workspace.created`
- `workspace.invited_user_added`
- `document.upload_requested`
- `document.processing_completed`
- `document.processing_failed`
- `chat.started`
- `chat.completed`
- `chat.unsupported_answer_returned`
- `chat.citation_clicked`
- `public_chat.started`
- `website_embed.loaded`
- `connector.sync_completed`
- `retrieval_settings.updated`

### Storage strategy

Default OSS path:

- persist the canonical event to `audit_events` or a dedicated append-only analytics table
- optionally mirror it to logs

SaaS path:

- persist the same canonical event internally first
- fan it out asynchronously to zero or more exporters

This preserves one Radioso-owned event schema regardless of backend.

### Exporter interface

Use an internal interface such as:

```ts
export interface ProductAnalyticsSink {
  emit(event: ProductAnalyticsEvent): Promise<void>;
}
```

Candidate sink implementations:

- `NoopProductAnalyticsSink`
- `AuditEventAnalyticsSink`
- `LogAnalyticsSink`
- `WebhookAnalyticsSink`
- `PostHogAnalyticsSink`

The first three should be safe to ship in OSS defaults. Vendor sinks can remain optional packages or optional dependencies enabled only in Radioso Cloud.

### Identity rules

Analytics identity should be explicit and privacy-aware:

- prefer workspace and account identifiers over personal identifiers where possible
- hash or pseudonymize end-user identifiers before export if the sink leaves Radioso infrastructure
- never emit raw session cookies, access tokens, connector secrets, prompt bodies, or document payloads

## Layer 3: Crash And Error Reporting

Crash monitoring answers questions such as:

- what broke
- who was affected
- what version shipped the regression
- is the same exception recurring across workspaces

### Internal error event shape

Normalize crashes into a Radioso-owned shape before any external export:

- timestamp
- severity
- environment
- version
- service
- request metadata
- workspace or account identifiers
- normalized exception type
- message
- stack trace
- tags
- selected breadcrumbs

### Default OSS behavior

- log the error through Pino
- record an internal audit-backed error event
- increment failure metrics when metrics exposure is enabled

### SaaS behavior

- do the default OSS behavior
- optionally forward the normalized error to an external sink such as Sentry

This keeps external crash tooling optional without weakening the product's default failure capture.

### Current implementation

Errors reach the shared error service (and therefore every configured sink,
including the optional PostHog/Sentry exporters) from four places, so capture is
not limited to the HTTP request path:

- **Unhandled HTTP request failures** — the error handler middleware in
  [`backend/src/app/http/middleware/errorHandler.ts`](../backend/src/app/http/middleware/errorHandler.ts)
  (`errorType: http.request.unhandled`).
- **Browser errors** — posted to `/api/v1/observability/frontend-errors`
  (`frontend.*.unhandled`).
- **Process-level crashes** — every entrypoint installs
  [`installProcessErrorHandlers`](../backend/src/runtime/processErrorHandlers.ts),
  which reports `process.uncaughtException` and `process.unhandledRejection`
  before exiting with code 1. Without this, a crash or a floating promise
  rejection would terminate the process with no error-sink record.
- **Background worker loops** — the document-processing poll tick
  (`document.worker.tick_failed`) and the action-dispatch outbox drain
  (`action.dispatch.drain_failed`) report the otherwise-swallowed infrastructure
  failures that never surface as HTTP errors. Per-document job failures keep
  their existing retry/audit/telemetry handling and are not reported here, to
  avoid turning expected transient failures into error-sink noise.

Analytics and errors persist through audit-backed sinks first, and optional
exporters fan out afterward.

## Recommended OSS Default Stack

For the public repository, the default supported path should be:

- Pino structured logs
- OpenTelemetry instrumentation libraries
- Prometheus or OpenMetrics `/metrics`
- existing `audit_events` for domain and product events
- optional Grafana dashboard examples

This gives a self-hoster a complete stack using common OSS infrastructure:

- Prometheus for scraping
- Grafana for dashboards
- Loki or another log backend if desired
- Jaeger or Tempo if traces are enabled

Radioso should document these as examples, not hard requirements.

## Recommended Radioso Cloud Stack

For the hosted SaaS, use the same instrumentation with deployment-time sinks:

- logs: Pino to the platform log pipeline
- metrics and traces: OpenTelemetry Collector
- storage and dashboards: whichever backend operations wants
- product analytics: exporter from the internal event bus
- errors: exporter from the internal error pipeline

The key point is that the cloud deployment gets extra sinks, not a different product architecture.

## Packaging Strategy

Avoid shipping the backend as:

- code paths that directly import PostHog or Sentry in shared modules
- required environment variables for vendor SDKs
- frontend bundles that assume a vendor analytics script exists

Prefer:

- internal interfaces in the main app
- `noop` default implementations
- optional adapter modules wired by environment configuration

One reasonable packaging split is:

- `backend/src/shared/observability/telemetry/`
- `backend/src/shared/analytics/`
- `backend/src/shared/errors/`
- optional Enterprise adapter modules such as `ee/packages/backend-module/src/observability/`

Vendor-specific hosted integrations should live outside the OSS backend. The
OSS backend owns the sink interfaces and first-party audit or metrics sinks.
Enterprise modules can register concrete hosted adapters through those
interfaces.

## Environment Model

Recommended core flags:

```bash
OBSERVABILITY_ENABLED=true
OBSERVABILITY_SERVICE_NAME=radioso-api
OBSERVABILITY_ENVIRONMENT=production
OBSERVABILITY_VERSION=git-sha-or-release

METRICS_ENABLED=true
METRICS_PATH=/metrics
METRICS_AUTH_TOKEN=replace-with-a-long-random-bearer-token

OTEL_ENABLED=false
OTEL_EXPORTER_OTLP_ENDPOINT=
OTEL_TRACES_SAMPLER=
OTEL_TRACES_SAMPLER_ARG=

PRODUCT_ANALYTICS_SINKS=audit
ERROR_SINKS=audit
```

`OBSERVABILITY_ENVIRONMENT` falls back to `NODE_ENV` when unset. `METRICS_ENABLED=true` requires `METRICS_AUTH_TOKEN`, and the backend serves `/metrics` only to callers that present `Authorization: Bearer <token>`.

Set `OTEL_ENABLED=true` and `OTEL_EXPORTER_OTLP_ENDPOINT` to an OTLP/HTTP
collector endpoint, for example `http://localhost:4318/v1/traces`, to export
backend traces. Tracing is disabled by default and is not required for local
development.

Sampling uses standard OpenTelemetry sampler names. Leave
`OTEL_TRACES_SAMPLER` empty for the default parent-based always-on behavior
when tracing is enabled. Use `parentbased_traceidratio` with
`OTEL_TRACES_SAMPLER_ARG=0.25` to sample roughly 25% of root traces while
respecting upstream sampling decisions.

Trace attributes follow the backend privacy policy. Raw prompts, completions,
document bodies, retrieved chunks, connector secrets, cookies, access tokens,
database credentials, and connection strings are redacted or omitted. URLs are
exported without query strings, fragments, usernames, or passwords.

Current backend tracing covers API and worker-task HTTP requests, chat turns,
retrieval stages, model and embedding provider calls, document worker jobs, and
document processing stages. Runtime roles are attached as trace resource
metadata, and workers use role-specific service names unless
`OBSERVABILITY_SERVICE_NAME` is explicitly overridden.

Backend logs can also be exported through OpenTelemetry logs while keeping Pino
stdout as the primary platform log stream:

```bash
OTEL_LOGS_ENABLED=true
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://eu.i.posthog.com/i/v1/logs
OTEL_EXPORTER_OTLP_LOGS_AUTH_BEARER=...
OTEL_LOGS_MIN_LEVEL=info
```

For PostHog, use the regional ingestion host for the project and append
`/i/v1/logs`. The bearer token is the PostHog project token. Do not use a
personal API key. The backend bridge redacts sensitive log attributes before
export and applies `OTEL_LOGS_MIN_LEVEL` before records leave the process.

The backend adds primitive OpenTelemetry correlation to debug turn traces when
an active span exists:

```json
{
  "openTelemetry": {
    "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
    "spanId": "00f067aa0ba902b7",
    "sampled": true
  }
}
```

This field is debug-only. It does not embed SDK span objects or raw trace data
inside product diagnostics.

Enterprise SaaS examples:

```bash
RADIOSO_EDITION=enterprise
PRODUCT_ANALYTICS_SINKS=audit,posthog
ERROR_SINKS=audit,sentry,posthog
SENTRY_DSN=...
POSTHOG_API_KEY=...
POSTHOG_HOST=...
OTEL_LOGS_ENABLED=true
OTEL_LOGS_MIN_LEVEL=info
```

The OSS runtime can carry the sink list without importing vendor code. The
Enterprise backend module owns validation and registration for the vendor
credentials. In practice, `RADIOSO_EDITION=enterprise` loads the bundled
`@radioso/enterprise-backend-module` unless `RADIOSO_APPLICATION_MODULES` is set
to an explicit comma-separated module list.

## Frontend-only events

Most product events should remain backend-derived. For the small set of actions
the backend cannot infer reliably, such as citation clicks or embed-only page
loads, use the isolated emitter seam in
[`frontend/lib/product-analytics.ts`](../frontend/lib/product-analytics.ts)
instead of scattering vendor calls through React components.

The browser should send these events to Radioso's generic observability API.
From there, the backend product analytics service persists the first-party
audit event and Enterprise sinks can fan it out to hosted analytics providers.

Frontend render and runtime errors follow the same rule. The application shell
uses Radioso's own error boundary and reporter in
[`frontend/components/frontend-error-boundary.tsx`](../frontend/components/frontend-error-boundary.tsx)
and [`frontend/lib/frontend-errors.ts`](../frontend/lib/frontend-errors.ts).
The browser posts sanitized error envelopes to
`/api/v1/observability/frontend-errors`; the backend records them through the
generic error reporting service and configured error sinks. React components do
not import PostHog, Sentry, or any other vendor SDK.

## Rollout Plan

### Phase 1

- formalize telemetry, analytics, and error interfaces
- replace direct `console.error` fallback paths with the internal logger and error service
- document a small stable product event taxonomy

### Phase 2

- add Prometheus metrics exposure
- add OpenTelemetry trace instrumentation around HTTP, chat, retrieval, and document processing
- correlate logs with request and workspace identifiers

### Phase 3

- route product events through a dedicated sink interface
- keep `audit_events` as the first sink
- add async fan-out so external exporters cannot break request paths

### Phase 4

- add optional SaaS-only sinks for error reporting and product analytics
- document exporter redaction and privacy rules
- add dashboards and alert examples

## What Not To Do

- do not hard-code PostHog calls in frontend components as the canonical analytics source
- do not make Sentry the only place an error exists
- do not send raw prompts, retrieved chunks, or document bodies to third-party telemetry tools by default
- do not create separate event semantics for OSS and SaaS
- do not block critical request paths on external analytics or error vendors

## Decision Summary

The best practice for an open source SaaS product like Radioso is:

- standards in core
- optional vendors at the edge
- internal event ownership
- privacy-safe defaults

Concretely, Radioso should build around Pino, `audit_events`, OpenTelemetry, and Prometheus-compatible metrics, then add vendor exporters only as optional deployment adapters for Radioso Cloud.
