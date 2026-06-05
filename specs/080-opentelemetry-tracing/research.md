# Research: OpenTelemetry Tracing

## Decision: Use OpenTelemetry async-hooks context propagation

**Rationale**: The codebase currently passes correlation explicitly, but nested span parenting across chat, retrieval, provider, document, and connector services would require widespread parent-context parameters without an ambient context substrate. OpenTelemetry's async-hooks context manager gives in-process span parenting while preserving narrow service signatures.

**Alternatives considered**:

- Explicit parent span/context parameters through services: rejected because it would touch too many interfaces and violate the repo's boundary discipline.
- Custom AsyncLocalStorage outside OpenTelemetry: rejected because it would duplicate OpenTelemetry context behavior and make auto-instrumentation harder to compose.

## Decision: Keep tracing optional and disabled by default

**Rationale**: Self-hosting operators should not need a collector for default local development. Enabling tracing should be an explicit operator choice through existing observability env fields.

**Alternatives considered**:

- Always initialize/export traces: rejected because it makes observability infrastructure a product dependency.
- Vendor SDK integration: rejected because the observability strategy requires standards in core and vendors at the edge.

## Decision: Add debug-only product correlation field

**Rationale**: Operators need to move from Radioso's product activity trace to the exported OpenTelemetry trace. A log-only correlation path is too fragile. The field must carry only safe trace identity, not SDK objects or raw span data.

**Alternatives considered**:

- Log-only correlation: rejected because it is hard to use from chat diagnostics.
- Embedding full span data in product diagnostics: rejected because it couples product trace envelopes to OpenTelemetry SDK details.

## Decision: Start with conservative manual spans plus selected auto-instrumentation

**Rationale**: Domain spans provide readable operational structure, while auto HTTP spans provide transport detail. Provider spans should be semantic parents of outbound HTTP transport spans to avoid double-counted sibling latency.

**Alternatives considered**:

- Auto-instrumentation only: rejected because it does not expose Radioso-specific retrieval/chat/document stages.
- Manual spans only: rejected because it loses useful transport detail and standard propagation behavior.

## Decision: Standard sampling environment variables

**Rationale**: `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG` match OpenTelemetry operator expectations and avoid Radioso-specific sampling semantics.

**Alternatives considered**:

- Custom `RADIOSO_TRACE_SAMPLE_RATE`: rejected unless standard fields prove insufficient.

## Decision: No worker payload change by default

**Rationale**: PostgreSQL jobs remain authoritative. Trace context should not change durable queue semantics. If propagation across AMQP requires metadata, planning must document a queue impact review before changing payloads.

**Alternatives considered**:

- Add trace context to every worker message immediately: rejected because it changes a cross-service contract before proving it is necessary.
