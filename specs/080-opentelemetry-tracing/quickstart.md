# Quickstart: OpenTelemetry Tracing

## Local Verification

1. Start a local OTLP-compatible collector such as Jaeger all-in-one with OTLP enabled.
2. Configure backend tracing:

```bash
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OBSERVABILITY_SERVICE_NAME=radioso-api
OBSERVABILITY_ENVIRONMENT=development
OBSERVABILITY_VERSION=local
```

3. Start the API runtime and make a simple API request.
4. Confirm the collector receives a trace with service name, runtime role, route, method, status, duration, and request id where available.
5. Run a retrieval-backed chat request and confirm nested chat, retrieval, retrieval-stage, and provider spans.
6. Start a document worker flow and confirm job dispatch/processing spans or explicit trace links with job/document correlation.

## Focused Test Commands

```bash
cd backend
pnpm test -- tests/unit/runtime-config.test.ts tests/unit/telemetry-service.test.ts
pnpm test -- tests/unit/turn-trace-envelope.test.ts
pnpm test -- tests/unit/retrieval-execution-telemetry-service.test.ts tests/unit/document-processing-worker-runtime.test.ts
pnpm run build
```

## Expected Safety Checks

- Disabled tracing must not require a collector.
- Collector export failure must not fail API requests or worker jobs.
- Redaction tests must prove prohibited content is omitted or redacted.
- Debug trace correlation must be absent when no active trace exists.
- Existing Prometheus metrics and Pino logs must remain available.
