# Feature Specification: OpenTelemetry Tracing

**Feature Branch**: `opentelemetry-implementation`
**Created**: 2026-06-05
**Status**: Draft
**Tracking**: GitHub issue #631
**Input**: User description: "Create the full scope spec for adding OpenTelemetry to Radioso so operators can debug API, chat, retrieval, worker, connector, and provider flows with vendor-neutral traces."

## Scope Decision

This feature adds vendor-neutral OpenTelemetry tracing as an operator-facing observability capability for Radioso. It should make a single API request, chat turn, retrieval execution, document-processing job, crawler job, connector operation, or provider call traceable across runtime boundaries without replacing the existing Pino logs, Prometheus-compatible metrics endpoint, audit events, product analytics, or error-reporting services.

The full scope includes:

1. **Runtime trace export.** Operators can enable trace export in API and worker runtimes using existing observability configuration without requiring a hosted vendor account.
2. **High-value backend spans.** Radioso records privacy-safe spans for HTTP requests, chat answer generation, retrieval stages, document worker jobs, crawler work, connector fetch/sync operations, selected database calls, queue dispatch/consume boundaries, API-mounted MCP requests, and LLM/provider calls.
3. **Cross-boundary correlation.** Traces carry stable request, workspace, account, conversation, job, document, route, runtime role, environment, and version attributes where available.
4. **Privacy and reliability guardrails.** Trace attributes must not include raw prompts, raw document bodies, retrieved chunks, connector secrets, credentials, access tokens, or high-cardinality user content by default. Tracing failures must never break product workflows.
5. **Operator documentation.** Setup and operations docs explain how to enable tracing, connect a local or hosted collector, interpret common traces, and understand what data is intentionally excluded.
6. **In-process propagation substrate.** Manual spans must nest through the OpenTelemetry async-hooks context manager, backed by Node's async context propagation, so domain modules can call focused span helpers without threading parent span handles through broad service signatures.

Product analytics, frontend browser tracing, vendor-specific SaaS exporters, aggregate dashboards, standalone MCP package instrumentation, and replacing existing metrics/logging surfaces are not part of this feature.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Enable Vendor-Neutral Backend Tracing (Priority: P1)

As a self-hosting or hosted-environment operator, I want to turn on backend trace export and point Radioso at a standards-based collector, so I can inspect runtime behavior without adopting a Radioso-specific or vendor-specific monitoring system.

**Why this priority**: Trace export is the foundation for all later diagnostic value. Without a safe, configurable runtime path, manual spans have nowhere useful to go.

**Independent Test**: Configure tracing with a local collector, start the API and worker runtimes, issue a health or simple API request, and verify that a trace with service, environment, version, route, status, and runtime role information reaches the collector.

**Acceptance Scenarios**:

1. **Given** tracing is disabled, **When** the API and worker runtimes start, **Then** Radioso behaves exactly as it does today and does not require a collector.
2. **Given** tracing is enabled with a valid collector endpoint, **When** the API receives a request, **Then** a trace is exported with privacy-safe service, environment, version, route, method, status, and duration information.
3. **Given** tracing is enabled but the collector is temporarily unavailable, **When** Radioso handles API or worker traffic, **Then** product workflows continue and the export failure is logged without exposing secrets or failing the request.
4. **Given** an operator shuts down an API or worker runtime, **When** tracing is enabled, **Then** pending traces are flushed or gracefully abandoned within the shutdown budget.

---

### User Story 2 - Diagnose Chat And Retrieval Latency (Priority: P1)

As an operator investigating a slow or poor grounded answer, I want one trace to show the chat turn and retrieval path with stage durations and outcomes, so I can identify whether latency or failure came from query interpretation, candidate retrieval, reranking, prompt assembly, answer generation, or provider calls.

**Why this priority**: Radioso's most important runtime diagnostic need is understanding grounded-answer quality and latency across chat, retrieval, and LLM provider boundaries.

**Independent Test**: Run a retrieval-backed chat request against representative documents, inspect the resulting trace, and verify that the chat turn includes child spans for the retrieval pipeline, material retrieval stages, and provider calls with stage outcomes and bounded counts.

**Acceptance Scenarios**:

1. **Given** a retrieval-backed chat answer completes successfully, **When** an operator opens the exported trace, **Then** the trace shows the chat turn, retrieval execution, material retrieval stages, answer generation, and provider call durations in parent-child order.
2. **Given** retrieval falls back, skips a stage, returns no contexts, or rejects a rewrite, **When** the trace is inspected, **Then** the affected stage is marked with a privacy-safe outcome reason rather than appearing as a silent success.
3. **Given** a provider call fails or times out and the product degrades safely, **When** the trace is inspected, **Then** the failed span identifies the provider capability, model family or configured model alias when safe, duration, retry outcome, and error class without raw prompt or completion text.
4. **Given** existing operator-facing retrieval activity traces are recorded for chat diagnostics, **When** OpenTelemetry spans are emitted, **Then** the debug-only turn trace envelope exposes an additive optional OpenTelemetry correlation field that lets operators correlate the product activity trace with the exported trace without turning product diagnostics into SDK wrappers.

---

### User Story 3 - Trace Asynchronous Document And Crawler Work (Priority: P2)

As an operator diagnosing ingestion or crawling delays, I want document-processing, crawler, queue dispatch, and queue-consumption work to be traceable across asynchronous boundaries, so I can tell whether work is stuck in dispatch, queue delivery, job claiming, parsing, chunking, embedding, storage, or retry handling.

**Why this priority**: Document ingestion and crawling are asynchronous by design. Without trace propagation and worker spans, operators only see partial logs and aggregate metrics.

**Independent Test**: Ingest a document or start a crawl with tracing enabled, then verify that dispatch, worker consumption, processing stages, and any retry or failure path can be correlated through stable job and document identifiers.

**Acceptance Scenarios**:

1. **Given** a document upload or import creates processing work, **When** the job is dispatched and later handled by a worker, **Then** exported traces include linked or propagated context for job creation, dispatch, consumption, claim, processing, and completion.
2. **Given** document processing performs parsing, chunking, embedding, storage, and indexing work, **When** an operator inspects the trace, **Then** each material stage has duration, outcome, and bounded counts without raw document text.
3. **Given** a crawler job fetches and ingests pages, **When** tracing is enabled, **Then** the trace shows crawl fetch, policy decisions, ingestion dispatch, and completion or retry outcomes with bounded URL and workspace metadata.
4. **Given** queue or worker delivery happens more than once, **When** duplicate or stale work is handled, **Then** the trace records the no-op or busy outcome without implying duplicate processing succeeded.

---

### User Story 4 - Correlate Logs, Metrics, Traces, And Audit Events (Priority: P2)

As a support engineer, I want logs, metrics, traces, and audit-backed events to share stable correlation identifiers, so I can move from a user report or audit event to the exact runtime trace without guessing from timestamps alone.

**Why this priority**: OpenTelemetry is most valuable when it complements existing observability surfaces instead of creating a separate debugging island.

**Independent Test**: Trigger a request that emits logs, metrics, telemetry events, and an audit-backed event, then verify that common identifiers appear consistently enough to find the same execution across all surfaces.

**Acceptance Scenarios**:

1. **Given** an API request has a request id and workspace id, **When** logs, telemetry events, metrics labels, and trace spans are emitted, **Then** the request id and workspace id are available wherever that surface safely supports them.
2. **Given** a chat answer has an activity trace id, conversation id, and provider-call spans, **When** a support engineer inspects the trace and chat diagnostics, **Then** the two surfaces can be correlated without exposing hidden prompts or raw retrieved content.
3. **Given** a document job emits worker telemetry and audit-related state changes, **When** a support engineer inspects logs and traces, **Then** job id and document id make the same execution identifiable.
4. **Given** metrics remain aggregated and low-cardinality, **When** tracing is enabled, **Then** metric label cardinality does not increase due to raw trace ids, prompts, document titles, or user content.

---

### User Story 5 - Operate Tracing Safely In Production (Priority: P3)

As an operator responsible for customer data, I want documentation, defaults, and tests that prove tracing is privacy-safe and operationally safe, so I can enable it without accidentally exporting sensitive content or making observability a production dependency.

**Why this priority**: Radioso handles customer documents, prompts, sessions, and connector secrets. The feature is not acceptable unless observability is safe by default.

**Independent Test**: Review configuration examples and run redaction/privacy tests that attempt to attach prompts, document text, chunks, credentials, and tokens to trace attributes, verifying they are omitted or redacted.

**Acceptance Scenarios**:

1. **Given** a developer adds a span attribute from runtime metadata, **When** the metadata contains prompt text, document body text, chunks, secrets, credentials, or access tokens, **Then** prohibited values are not exported by default.
2. **Given** tracing is enabled in a self-hosted environment, **When** the operator reads setup docs, **Then** the docs explain how to connect a local collector, where traces go, which fields are exported, and which fields are deliberately excluded.
3. **Given** an operator changes tracing configuration, **When** required settings are missing or invalid, **Then** startup fails with an actionable configuration error only for invalid enabled tracing, while disabled tracing remains optional.
4. **Given** trace volume is high, **When** the operator configures sampling or turns tracing off, **Then** Radioso can reduce or stop trace export without changing product behavior or requiring code changes.

### Edge Cases

- Tracing is disabled, partially configured, or misconfigured; disabled mode must be no-op, while enabled invalid configuration must fail loudly before traffic is accepted.
- A collector is down, slow, or returns export errors; product requests and worker jobs must continue unless the failure is in the product dependency rather than the tracing dependency.
- Runtimes may start under different roles: API, document worker, document worker task server, crawler worker, and crawler worker task server. MCP requests mounted into the API runtime are traced under the API role with route or surface attributes; the standalone MCP server package is out of scope for this feature.
- Auto-instrumentation may produce spans for internal libraries; exported attributes must still follow Radioso privacy and cardinality rules.
- Provider calls may produce both a domain-level provider span and an outbound HTTP auto-instrumentation span; the manual provider span is the product semantic parent, while the HTTP span is the transport child or linked transport detail. The implementation must avoid duplicate sibling spans that make provider latency appear twice in the same stage.
- Existing activity traces for retrieval and conversation diagnostics are product diagnostics, not a replacement for distributed tracing; both surfaces must remain coherent and correlatable.
- Queue delivery can be delayed, duplicated, stale, or requeued; trace linkage must not make job state less authoritative than PostgreSQL job records.
- Provider calls may stream, retry, timeout, or fail after partial work; traces must report safe outcome metadata without recording raw prompts or completions.
- Database instrumentation can be noisy or sensitive; selected database spans must avoid raw SQL payloads and high-cardinality parameter values unless a future explicit operator mode allows deeper local-only diagnostics.
- Operators may run multiple Radioso services with the same collector; service name, role, environment, and version must distinguish them.
- A graceful shutdown may not have enough time to flush every trace; shutdown must prioritize product lifecycle correctness over observability completeness.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; runtime conversational copy MUST be generated by the LLM so multilingual behavior remains intact.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit tests MUST stay focused on non-visual logic rather than markup or design assertions.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated if configuration changes.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.
- Public API, SDK, MCP, connector, worker payload, or other cross-service contract changes MUST include a message-queue impact review and update generated contracts/docs when affected.
- Operator-facing configuration and observability behavior changes MUST update the relevant docs in the same change.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Shared observability owns tracing configuration, async context setup, span creation helpers, redaction, attribute policy, exporter lifecycle, and correlation helpers. Application composition owns default runtime wiring and lifecycle hooks for tracing. Runtime entrypoints own early initialization and shutdown sequencing only. Domain modules own the semantic decision of where business-relevant spans begin and end, but they must use shared observability ports rather than importing exporter-specific code or accepting parent span handles in broad product method signatures. Transport layers remain request/response orchestration surfaces and must not own retrieval, chat, document-processing, or provider-specific trace semantics.
- **Encapsulation Rule**: `backend/src/app/composition/` must assemble trace providers, exporters, async context propagation, and lifecycle hooks without embedding product rules. Existing logging, telemetry, analytics, error-reporting, and metrics services must remain independently useful when tracing is disabled. Retrieval activity trace builders, chat turn traces, and conversation traces must remain product diagnostics and must not become wrappers around OpenTelemetry SDK objects. Worker and queue adapters must propagate trace context without making queue payloads the source of truth for job state.
- **New Seams Required**:
  - A backend tracing lifecycle owned by shared observability and wired through application composition.
  - An AsyncLocalStorage/async-hooks-backed OpenTelemetry context manager that provides ambient in-process span parenting and prevents parent context from being threaded through wide service signatures.
  - A privacy-safe trace attribute policy shared by automatic and manual instrumentation.
  - Narrow span helper ports for modules that need manual spans without depending on exporter implementation details.
  - Runtime-role-aware service metadata for API, document worker, document worker task server, crawler worker, and crawler worker task server, with API-mounted MCP requests represented as API spans tagged by surface or route.
  - Trace context propagation for document job dispatch and message-queue consumption that does not change durable job semantics.
  - An additive debug-contract correlation field that records safe OpenTelemetry trace/span identifiers on the versioned turn trace envelope when tracing is active.
  - Focused test helpers for asserting span names, attributes, parent-child or link relationships, redaction, and no-op behavior when tracing is disabled.
- **Anti-Goals**: Do not replace Pino logs, Prometheus metrics, audit events, product analytics, or error-reporting services. Do not introduce vendor-specific tracing SDKs in shared backend modules. Do not store raw prompts, completions, retrieved chunks, document text, connector secrets, access tokens, cookies, database credentials, or unrestricted SQL parameter values in trace attributes. Do not make observability exporters part of the critical product path. Do not add frontend browser tracing, standalone MCP server package instrumentation, aggregate dashboards, cross-tenant analytics, or SaaS-only sinks in this feature. Do not hand-edit generated OpenAPI artifacts.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST support optional backend trace export controlled by observability configuration and disabled by default unless an operator explicitly enables it.
- **FR-002**: System MUST use a standards-based trace export path so operators can route traces to a collector or any compatible backend without vendor-specific application code.
- **FR-003**: System MUST initialize tracing early enough for inbound HTTP, outbound HTTP, and selected library instrumentation to create real spans when tracing is enabled.
- **FR-004**: System MUST shut down or flush tracing during API, document worker, document worker task server, crawler worker, and crawler worker task server runtime shutdown without blocking beyond the configured shutdown budget.
- **FR-005**: System MUST preserve existing product behavior when tracing is disabled.
- **FR-006**: System MUST preserve existing product behavior when trace export fails after startup, logging exporter failures without failing API requests or worker jobs.
- **FR-007**: System MUST fail startup with an actionable configuration error when tracing is explicitly enabled with invalid required configuration.
- **FR-008**: System MUST attach safe service metadata to exported traces, including service name from `OBSERVABILITY_SERVICE_NAME`, runtime role, environment from `OBSERVABILITY_ENVIRONMENT`, and version from `OBSERVABILITY_VERSION`.
- **FR-009**: System MUST attach stable correlation attributes where available, including request id, workspace id, account id, conversation id, job id, document id, route, method, and status.
- **FR-010**: System MUST avoid exporting raw prompts, raw completions, raw document bodies, retrieved chunks, connector secrets, access tokens, cookies, database credentials, full connection strings, and unrestricted SQL parameter values as trace attributes by default.
- **FR-011**: System MUST enforce a bounded attribute policy so high-cardinality content such as arbitrary user messages, document titles, full URLs with secrets, and raw trace ids do not leak into metrics labels or unbounded trace attributes.
- **FR-012**: System MUST create or export spans for inbound API requests with route, method, status, duration, runtime role, and error outcome.
- **FR-013**: System MUST create manual spans for chat answer generation and streaming flows that identify turn lifecycle, answer outcome, tool or skill dispatch where relevant, and safe correlation identifiers.
- **FR-014**: System MUST create manual spans for retrieval execution stages, including query interpretation, candidate retrieval, candidate preparation, reranking when used, context selection, prompt assembly, and final diagnostics.
- **FR-015**: Retrieval spans MUST include bounded counts, statuses, fallback or skip outcomes, and durations without duplicating raw product diagnostic payloads into trace attributes.
- **FR-016**: System MUST create manual spans for LLM and embedding provider calls with provider capability, configured model identifier when safe, duration, retry outcome, timeout outcome, and error class.
- **FR-017**: System MUST create manual spans for document processing jobs covering job claim, parsing, chunking, embedding, storage, indexing, completion, retry, and failure paths where those stages occur.
- **FR-018**: System MUST create manual spans for crawler work covering fetch, policy decision, ingest dispatch, retry, and completion paths where those stages occur.
- **FR-019**: System MUST create manual spans for connector fetch, sync, webhook, and ingestion handoff operations where connectors participate in document ingestion or updates.
- **FR-020**: System MUST propagate or link trace context across document job dispatch and message-queue consumption without changing the durable worker payload contract unless planning explicitly approves a contract change.
- **FR-021**: System MUST include a message-queue impact review in planning that covers document worker dispatch, AMQP payloads, retry semantics, queue tests, and queue docs before any trace-context payload changes are made.
- **FR-022**: System MUST keep existing Prometheus-compatible metrics available and must not require operators to choose between current metrics and tracing.
- **FR-023**: System MUST keep existing structured logs available and must add trace or span identifiers to logs only when doing so is privacy-safe and operationally useful.
- **FR-024**: System MUST keep audit-backed product events and error reports independent from tracing while making shared correlation identifiers available across surfaces where safe.
- **FR-025**: System MUST provide focused backend tests for disabled tracing no-op behavior, enabled tracing export setup, invalid configuration failure, exporter failure isolation, runtime shutdown flushing, span hierarchy, cross-boundary context propagation, and redaction of prohibited values.
- **FR-026**: System MUST update `.env.example` or equivalent configuration examples for tracing settings introduced or activated by this feature.
- **FR-027**: System MUST update operator-facing observability documentation with enablement steps, local collector examples, production collector guidance, sampling guidance, privacy exclusions, troubleshooting steps, and expected trace shapes for API, chat/retrieval, and worker flows.
- **FR-028**: System MUST document that frontend browser tracing, vendor-specific SaaS exporters, aggregate dashboards, and product analytics sinks are out of scope for this feature.
- **FR-029**: System MUST preserve public API, SDK, MCP, and connector response contracts unless a separately approved plan identifies a required contract change.
- **FR-030**: System MUST include local verification guidance so contributors can generate at least one API trace and one worker trace in development.
- **FR-031**: System MUST use AsyncLocalStorage/async-hooks-backed OpenTelemetry context propagation for in-process span parenting so chat, retrieval, provider, document-processing, and connector spans nest without passing parent span handles through broad product service signatures.
- **FR-032**: System MUST expose optional debug-only OpenTelemetry correlation on the versioned turn trace envelope when tracing is active, including the active trace id, active span id, and sampled flag where available. This is an approved additive operator-debug contract change and MUST update code-first OpenAPI, generated contracts, SDK-facing types, and diagnostics docs if those surfaces expose the envelope.
- **FR-033**: System MUST support env-driven trace sampling using standard OpenTelemetry sampling settings (`OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG`), defaulting to parent-based always-on behavior when tracing is enabled and no sampler override is provided.
- **FR-034**: System MUST define the relationship between manual provider spans and outbound HTTP auto-instrumentation spans so provider latency is represented as one semantic provider operation with transport detail beneath or linked to it, not as duplicated sibling operations.
- **FR-035**: System MUST bound steady-state tracing overhead: with tracing enabled and exporting to a healthy local collector, representative chat/retrieval and document-processing benchmark coverage must show no more than 5% median latency increase and no more than 10% p95 latency increase compared with tracing disabled, or the implementation must document the measured exception and default the expensive span path off.
- **FR-036**: System MUST build on existing observability configuration names for service name, environment, and version (`OBSERVABILITY_SERVICE_NAME`, `OBSERVABILITY_ENVIRONMENT`, `OBSERVABILITY_VERSION`) and existing OpenTelemetry enablement fields (`OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`), adding only the minimum new environment fields required for sampling or exporter behavior.

### Key Entities

- **Trace**: A correlated execution record for one request, job, or operation, containing ordered spans and safe attributes.
- **Span**: A bounded operation within a trace, such as an API request, retrieval stage, provider call, document-processing step, queue dispatch, or connector sync.
- **Trace Attribute Policy**: The allowlist, redaction, cardinality, and value-length rules that determine which metadata may leave the process through traces.
- **Runtime Role**: The service role emitting spans, such as API, document worker, document worker task server, crawler worker, or crawler worker task server. API-mounted MCP requests are API spans with MCP route or surface attributes.
- **Trace Export Configuration**: Operator-provided settings that enable tracing and define where traces are exported.
- **Trace Context**: Correlation state carried or linked between synchronous requests and asynchronous jobs.
- **Activity Trace Correlation**: The relationship between product-level retrieval/chat diagnostic traces and exported OpenTelemetry traces.
- **Debug Trace Correlation Field**: The additive operator-debug envelope field that carries safe OpenTelemetry trace identity without embedding SDK objects or raw span data into product diagnostics.

### Assumptions

- The first implementation should focus on backend traces, not frontend browser instrumentation.
- Existing `OTEL_ENABLED` and `OTEL_EXPORTER_OTLP_ENDPOINT` configuration fields are intended to become the primary tracing enablement path.
- In-process parent-child span relationships should use OpenTelemetry's async-hooks context manager rather than explicit parent span parameters through chat, retrieval, document, connector, and provider service signatures.
- Sampling should use standard OpenTelemetry environment configuration rather than Radioso-specific sampling semantics unless implementation discovery shows the standard fields are insufficient.
- Existing logs, metrics, telemetry events, product analytics, audit events, and error reporting remain valuable and should coexist with tracing.
- Activity-trace correlation should be product-observable through an optional debug-only envelope field, not log-only, because operators need to move from product diagnostics to the exported trace.
- Trace context propagation across worker boundaries should prefer metadata that does not change public or durable payload contracts; any payload change requires the message-queue impact review before implementation.
- Selected database tracing should start conservative to avoid noise, sensitive SQL details, and high trace volume.
- Standalone `packages/radioso-mcp-server` tracing is a future package-level feature unless it is executing inside the backend API runtime through the merged MCP mount.
- Documentation is part of the product surface because this feature is primarily operated through deployment configuration.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With tracing disabled, existing API, document worker, document worker task server, crawler worker, and crawler worker task server startup and focused observability tests continue to pass without requiring a collector.
- **SC-002**: With tracing enabled against a local collector, a basic API request exports at least one trace containing service name, runtime role, environment, route, method, status, duration, and request id where available.
- **SC-003**: In representative retrieval-backed chat coverage, 100% of completed test turns export a trace containing chat, retrieval, material retrieval-stage, and provider-call spans with parent-child ordering or explicit links.
- **SC-004**: In representative document ingestion coverage, 100% of tested jobs export trace data or explicit trace links covering dispatch, worker handling, processing outcome, and job/document correlation.
- **SC-005**: In redaction tests, 100% of attempted raw prompts, raw completions, raw document bodies, retrieved chunks, connector secrets, access tokens, cookies, database credentials, and full connection strings are omitted or redacted from exported span attributes.
- **SC-006**: When the collector is unavailable after startup, API requests and worker jobs still complete or fail according to product dependency behavior, with zero failures caused solely by trace export.
- **SC-007**: Runtime shutdown with tracing enabled completes within the configured shutdown budget in focused tests while attempting to flush pending trace data.
- **SC-008**: Existing Prometheus metrics and Pino logs remain available in focused tests, and tracing does not require removing or renaming existing metric names.
- **SC-009**: Operator documentation enables a contributor to run a local collector and observe one API trace and one worker trace without reading implementation code.
- **SC-010**: The implementation introduces no public API, SDK, MCP, connector, or worker payload contract change unless the approved plan explicitly documents the change and its queue impact.
- **SC-011**: In focused span hierarchy tests, manual spans emitted from nested chat, retrieval, and provider service calls become parent-child spans through async context propagation without adding parent span parameters to broad product service interfaces.
- **SC-012**: In diagnostics contract tests, a traced chat turn exposes an optional debug-only OpenTelemetry correlation field on the versioned turn trace envelope, while untraced turns preserve the existing envelope shape except for the absent optional field.
- **SC-013**: In benchmark coverage with tracing enabled against a healthy local collector, representative chat/retrieval and document-processing flows stay within the tracing overhead budget or the expensive span path is disabled by default with documented measurements.
