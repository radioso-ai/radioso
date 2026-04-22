# Research: OSS Observability

## Decision 1: Use vendor-neutral telemetry as the core runtime observability layer

**Decision**: Treat structured logs plus vendor-neutral telemetry and
Prometheus-compatible metrics as the default runtime observability foundation.

**Rationale**: Radioso needs an OSS-safe default that works for self-hosters and
SaaS without forcing a hosted vendor dependency. Vendor-neutral telemetry keeps
instrumentation portable, and metrics exposure through a common scrape model
matches standard OSS operations tooling.

**Alternatives considered**:

- Use a hosted vendor SDK as the default observability layer. Rejected because
  it makes the OSS story weaker and couples event semantics to a third party.
- Keep only Pino logs with no formal telemetry seam. Rejected because logs
  alone are too weak for latency, error-rate, and queue-health visibility.

## Decision 2: Keep Radioso-owned event semantics internal

**Decision**: Define product analytics and incident reporting around
Radioso-owned event models before any exporter is considered.

**Rationale**: The product needs stable internal semantics whether the sink is
audit storage, logs, a webhook, or a vendor. Internal ownership also makes
privacy review, schema evolution, and self-hosting support tractable.

**Alternatives considered**:

- Model analytics directly around PostHog events. Rejected because it would push
  vendor naming and payload shape into shared product code.
- Model incidents directly around Sentry concepts. Rejected because the product
  still needs a complete default error record when no external sink is enabled.

## Decision 3: Reuse first-party storage before adding new persistence

**Decision**: Use `audit_events` as the first durable sink for product events
and internal incident records where feasible, then add dedicated storage only if
implementation pressure proves it necessary.

**Rationale**: Radioso already has audit storage and retrieval trace history.
Reusing those assets minimizes schema churn and keeps the first implementation
slice focused on interfaces and correctness instead of building a second event
system prematurely.

**Alternatives considered**:

- Add a new analytics event table immediately. Rejected because the planning
  feature does not yet justify new persistence.
- Send events only to logs. Rejected because durable operator inspection and
  replay would be weaker than the current audit foundation.

## Decision 4: Make external sink fan-out asynchronous and non-blocking

**Decision**: Optional analytics and incident exporters must run behind an
internal sink interface and must not become part of the request critical path.

**Rationale**: External vendors fail, rate-limit, and drift. Radioso must keep
serving traffic and keep first-party observability intact even when a SaaS-only
adapter is unavailable.

**Alternatives considered**:

- Send analytics or incidents inline during request handling. Rejected because
  it couples latency and availability to a non-essential external dependency.
- Ignore export failures silently. Rejected because operators still need local
  visibility into exporter degradation.

## Decision 5: Introduce a dedicated incident reporting seam before broad instrumentation

**Decision**: Replace ad hoc unhandled-error logging with a normalized incident
reporting service before adding optional external incident adapters.

**Rationale**: The current `console.error` fallback is inconsistent with the
rest of the backend’s structured logging and audit behavior. A focused incident
service gives the implementation a safe default path and a stable place for
redaction, severity, tagging, and exporter fan-out.

**Alternatives considered**:

- Keep `console.error` and add Sentry later. Rejected because it leaves the OSS
  default path weak and inconsistent.
- Add incident export first, then normalize later. Rejected because it would
  lock the internal model to the first vendor chosen.

## Decision 6: Start backend-first, then add frontend analytics only where backend visibility is insufficient

**Decision**: The first implementation slice should be backend-first. Frontend
analytics emitters should be added only for actions such as citation clicks or
embed interactions that cannot be reconstructed reliably from backend events.

**Rationale**: Most of the initial observability value lives in backend health,
domain events, and incident capture. Starting there keeps scope controlled and
lets the team validate the internal event model before broadening into client
events.

**Alternatives considered**:

- Instrument frontend and backend together from the start. Rejected because it
  increases surface area before the backend event model stabilizes.
- Skip client-side analytics entirely. Rejected because some product actions are
  inherently client-side and matter to later product analysis.
