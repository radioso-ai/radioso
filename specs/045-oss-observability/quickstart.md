# Quickstart: OSS Observability

Use this guide to validate the implemented observability slice.

## 1. Verify default OSS behavior

1. Start Radioso with no external analytics or incident exporter configured.
2. Trigger a normal API request, a chat request, and a document-processing path.
3. Confirm:
   - structured logs still work
   - first-party telemetry and product events are emitted
   - incident capture works for forced failure paths
   - the system remains functional without external sinks

## 2. Verify non-blocking failure handling

1. Enable an optional external sink with intentionally invalid credentials or an
   unreachable endpoint, for example `PRODUCT_ANALYTICS_SINKS=audit,posthog`
   without a working PostHog host or `INCIDENT_SINKS=audit,sentry` with an
   unreachable DSN.
2. Trigger analytics and incident-producing paths.
3. Confirm:
   - user-facing requests still succeed or fail only for their original reason
   - exporter failures are visible locally
   - first-party event capture still happens

## 3. Verify redaction rules

1. Trigger a request path that includes document content, prompt assembly, or
   connector-backed data.
2. Inspect emitted telemetry, persisted event records, and incident records.
3. Confirm:
   - raw prompts are absent
   - raw document contents are absent unless explicitly allowed in a local-only path
   - secrets and session material are absent

## 4. Verify correlation fields

1. Trigger a chat request that touches retrieval and persistence.
2. Inspect logs, first-party event records, and any metrics/traces.
3. Confirm shared identifiers are present where available:
   - request identifier
   - workspace identifier
   - conversation identifier
   - job or document identifier when relevant

## 5. Verify metrics exposure

1. Start Radioso with metrics enabled.
2. Fetch the metrics endpoint.
3. Confirm:
   - the endpoint is reachable
   - key request, retrieval, document-worker, product-event, and incident counters exist
   - no sensitive payload content is exposed

## 6. Verify phased rollout boundaries

1. Confirm the first implementation slice lands backend seams before vendor adapters.
2. Confirm optional frontend analytics emitters are added only for events the
   backend cannot infer.
3. Confirm docs are updated when runtime configuration or supported deployment
   patterns change.
