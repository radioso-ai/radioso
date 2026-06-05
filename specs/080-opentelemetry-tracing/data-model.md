# Data Model: OpenTelemetry Tracing

This feature does not add persistent database entities.

## Runtime Entities

### Trace

- **Represents**: One correlated execution such as an API request, chat turn, document job, crawler job, connector operation, or provider call tree.
- **Key fields**: trace id, spans, service metadata, runtime role, environment, version.
- **Persistence**: Exported to configured collector; not stored in Radioso database by this feature.

### Span

- **Represents**: One bounded operation inside a trace.
- **Key fields**: name, start/end time, status, parent or link, safe attributes, events, error class.
- **Validation**: Attribute policy must reject or redact prohibited values before export.

### Trace Attribute Policy

- **Represents**: Shared allowlist/redaction/cardinality rules for span attributes.
- **Allowed examples**: request id, workspace id, account id, conversation id, job id, document id, route pattern, method, status, runtime role, bounded counts, safe enum statuses, duration.
- **Prohibited examples**: raw prompts, completions, document text, chunks, secrets, tokens, cookies, full connection strings, unrestricted SQL parameters.

### Trace Export Configuration

- **Represents**: Operator tracing settings from environment.
- **Key fields**: `OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`, `OBSERVABILITY_SERVICE_NAME`, `OBSERVABILITY_ENVIRONMENT`, `OBSERVABILITY_VERSION`.
- **Validation**: Enabled tracing with invalid required exporter configuration fails startup; disabled tracing is a no-op.

### Debug Trace Correlation

- **Represents**: Optional product-debug link from a turn trace envelope to the exported OpenTelemetry trace.
- **Key fields**: trace id, span id, sampled flag.
- **Rules**: Optional, debug-only, additive, no SDK objects, no raw span attributes.

## State Transitions

- **Tracing disabled**: no-op tracer helpers return no correlation and do not export spans.
- **Tracing enabled and configured**: runtime initializes context manager/exporter, span helpers emit spans, shutdown attempts flush.
- **Exporter unavailable after startup**: product path continues, exporter failure is logged.
- **Invalid enabled config**: startup fails with actionable configuration error.
